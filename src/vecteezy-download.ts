import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const API_BASE_URL = 'https://api.vecteezy.com'
const FILE_TYPE = 'mp4'
const MAX_FILE_SIZE_BYTES = 512 * 1024 * 1024
const MAX_AGGREGATE_SIZE_BYTES = 2 * 1024 * 1024 * 1024

export interface DownloadQuota {
  limit: number | null
  remaining: number | null
}

export interface CompletedVecteezyDownload {
  artifactKey: string
  sourceSizeBytes: number
  sourceSha256: string
  requiresAttribution: boolean
  requiredAttributionUrl: string | null
  quota: DownloadQuota
}

export interface VecteezyDownloadInfo {
  resourceId: number
  sourceSizeBytes: number
  requiresAttribution: boolean
  requiredAttributionUrl: string | null
  quota: DownloadQuota
}

export interface FormalDownloadRequest extends VecteezyDownloadInfo {
  requestId: number
}

export interface DownloadReady {
  requestId: number
  resourceId: number
}

export interface VecteezyDownloadFileOperations {
  createWriteStream(path: string): NodeJS.WritableStream
  rename(from: string, to: string): Promise<void>
  rm(path: string): Promise<void>
  readFile(path: string): Promise<Buffer>
}

export interface VecteezyDownloadClientOptions {
  accountId: string
  apiKey: string
  fetcher: typeof fetch
  delay?: (milliseconds: number) => Promise<void>
  fileOperations?: VecteezyDownloadFileOperations
  logger?: (message: string) => void
  maxStatusPolls?: number
}

interface PendingDownload {
  info: VecteezyDownloadInfo
  statusUrl: string | null
  signedUrl: string | null
}

export class VecteezyDownloadError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'VecteezyDownloadError'
  }
}

export class FormalDownloadBudget {
  readonly maximum: number
  #used = 0

  constructor(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 0) {
      throw new Error('formal download maximum must be a non-negative integer')
    }
    this.maximum = maximum
  }

  get used(): number {
    return this.#used
  }

  reserve(): number {
    if (this.#used >= this.maximum) {
      throw new VecteezyDownloadError('download_budget_exhausted', 'formal download budget exhausted')
    }
    this.#used += 1
    return this.#used
  }
}

export class VecteezyDownloadClient {
  readonly #options: Required<Pick<VecteezyDownloadClientOptions, 'delay' | 'fileOperations' | 'maxStatusPolls'>>
    & Pick<VecteezyDownloadClientOptions, 'accountId' | 'apiKey' | 'fetcher' | 'logger'>
  #aggregateSizeBytes = 0
  #nextRequestId = 1
  #pending = new Map<number, PendingDownload>()

  constructor(options: VecteezyDownloadClientOptions) {
    if (!/^\d+$/.test(options.accountId)) throw new Error('invalid Vecteezy account ID')
    if (options.apiKey.trim() === '') throw new Error('invalid Vecteezy API key')
    const maxStatusPolls = options.maxStatusPolls ?? 30
    if (!Number.isSafeInteger(maxStatusPolls) || maxStatusPolls < 1) {
      throw new Error('maxStatusPolls must be a positive integer')
    }
    this.#options = {
      ...options,
      delay: options.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))),
      fileOperations: options.fileOperations ?? defaultFileOperations,
      maxStatusPolls,
    }
  }

  async getDownloadInfo(resourceId: number, fileType = FILE_TYPE): Promise<VecteezyDownloadInfo> {
    validateResourceId(resourceId)
    const response = await this.#providerRequest(this.#resourceUrl(resourceId, 'download_info', fileType))
    const payload = providerData(await response.json())
    const sourceSizeBytes = normalizePositiveInteger(payload.file_size)
    if (sourceSizeBytes === null) {
      throw new VecteezyDownloadError('invalid_provider_payload', 'Vecteezy download info payload is invalid')
    }

    return {
      resourceId,
      sourceSizeBytes,
      requiresAttribution: payload.requires_attribution === true,
      requiredAttributionUrl: stringOrNull(payload.required_attribution_url),
      quota: quotaFromHeaders(response.headers),
    }
  }

  async requestDownload(
    resourceId: number,
    budget: FormalDownloadBudget,
    fileType = FILE_TYPE,
  ): Promise<FormalDownloadRequest> {
    const info = await this.getDownloadInfo(resourceId, fileType)
    if (info.sourceSizeBytes > MAX_FILE_SIZE_BYTES) {
      throw new VecteezyDownloadError('file_size_limit_exceeded', 'Vecteezy file exceeds the 512 MiB limit')
    }
    if (this.#aggregateSizeBytes + info.sourceSizeBytes > MAX_AGGREGATE_SIZE_BYTES) {
      throw new VecteezyDownloadError('aggregate_size_limit_exceeded', 'Vecteezy downloads exceed the 2 GiB aggregate limit')
    }

    // Reserve synchronously immediately before every quota-consuming request.
    budget.reserve()
    this.#aggregateSizeBytes += info.sourceSizeBytes
    const response = await this.#providerRequest(this.#resourceUrl(resourceId, 'download', fileType))
    const payload = providerData(await response.json())
    const signedUrl = signedUrlFrom(payload)
    const statusUrl = stringOrNull(payload.download_status_url)
    if (signedUrl === null && statusUrl === null) {
      throw new VecteezyDownloadError('invalid_provider_payload', 'Vecteezy formal download payload is invalid')
    }

    const requestId = this.#nextRequestId++
    const quota = mergeQuota(info.quota, quotaFromHeaders(response.headers))
    this.#pending.set(requestId, { info: { ...info, quota }, signedUrl, statusUrl })
    return { ...info, quota, requestId }
  }

  async waitForDownload(request: FormalDownloadRequest): Promise<DownloadReady> {
    const pending = this.#pendingDownload(request)
    if (pending.signedUrl !== null) return ready(request)
    try {
      if (pending.statusUrl === null) {
        throw new VecteezyDownloadError('invalid_provider_payload', 'Vecteezy download status is unavailable')
      }

      for (let attempt = 0; attempt < this.#options.maxStatusPolls; attempt += 1) {
        const response = await this.#providerRequest(pending.statusUrl)
        const payload = providerData(await response.json())
        const signedUrl = signedUrlFrom(payload)
        if (signedUrl !== null && normalizeNonNegativeInteger(payload.progress) === 100) {
          pending.signedUrl = signedUrl
          return ready(request)
        }
        if (attempt < this.#options.maxStatusPolls - 1) await this.#options.delay(1000)
      }

      throw new VecteezyDownloadError('download_status_timeout', 'Vecteezy download status timed out')
    } catch (error) {
      this.#pending.delete(request.requestId)
      throw error
    }
  }

  async transferSignedUrl(readyDownload: DownloadReady, destination: string): Promise<CompletedVecteezyDownload> {
    validateRelativeDestination(destination)
    const pending = this.#pendingDownload(readyDownload)
    if (pending.signedUrl === null) {
      throw new VecteezyDownloadError('download_not_ready', 'Vecteezy download is not ready for transfer')
    }

    const partDestination = `${destination}.part`
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.#options.fetcher(pending.signedUrl)
        if (!response.ok || response.body === null) {
          throw new VecteezyDownloadError('transfer_failed', 'Vecteezy signed transfer failed')
        }
        await pipeline(
          Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
          this.#options.fileOperations.createWriteStream(partDestination),
        )
        await this.#options.fileOperations.rename(partDestination, destination)
        const bytes = await this.#options.fileOperations.readFile(destination)
        const completed: CompletedVecteezyDownload = {
          artifactKey: destination,
          sourceSizeBytes: bytes.byteLength,
          sourceSha256: createHash('sha256').update(bytes).digest('hex'),
          requiresAttribution: pending.info.requiresAttribution,
          requiredAttributionUrl: pending.info.requiredAttributionUrl,
          quota: pending.info.quota,
        }
        this.#pending.delete(readyDownload.requestId)
        return completed
      } catch (error) {
        await this.#options.fileOperations.rm(partDestination).catch(() => undefined)
        if (attempt === 2) {
          this.#pending.delete(readyDownload.requestId)
          if (error instanceof VecteezyDownloadError) throw error
          throw new VecteezyDownloadError('transfer_failed', 'Vecteezy signed transfer failed')
        }
        await this.#options.delay(attempt === 0 ? 500 : 1000)
      }
    }
    throw new VecteezyDownloadError('transfer_failed', 'Vecteezy signed transfer failed')
  }

  #resourceUrl(resourceId: number, action: 'download_info' | 'download', fileType: string): string {
    const url = new URL(`/v2/${this.#options.accountId}/resources/${resourceId}/${action}`, API_BASE_URL)
    url.search = new URLSearchParams({ file_type: fileType }).toString()
    return url.toString()
  }

  async #providerRequest(url: string): Promise<Response> {
    let response: Response
    try {
      response = await this.#options.fetcher(url, {
        headers: { authorization: `Bearer ${this.#options.apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      throw new VecteezyDownloadError('provider_request_failed', 'Vecteezy provider request failed')
    }
    if (!response.ok) {
      throw new VecteezyDownloadError(`provider_${response.status}`, `Vecteezy provider request failed: ${response.status}`)
    }
    return response
  }

  #pendingDownload(request: DownloadReady): PendingDownload {
    const pending = this.#pending.get(request.requestId)
    if (pending === undefined || pending.info.resourceId !== request.resourceId) {
      throw new VecteezyDownloadError('invalid_download_request', 'Vecteezy download request is invalid')
    }
    return pending
  }
}

const defaultFileOperations: VecteezyDownloadFileOperations = {
  createWriteStream,
  rename,
  rm: path => rm(path, { force: true }),
  readFile,
}

function providerData(value: unknown): Record<string, unknown> {
  const input = record(value)
  const data = record(input.data)
  return Object.keys(data).length > 0 ? data : input
}

function quotaFromHeaders(headers: Headers): DownloadQuota {
  return {
    limit: headerInteger(headers, ['x-ratelimit-limit', 'x-rate-limit-limit', 'x-download-limit']),
    remaining: headerInteger(headers, ['x-ratelimit-remaining', 'x-rate-limit-remaining', 'x-download-remaining']),
  }
}

function headerInteger(headers: Headers, names: string[]): number | null {
  for (const name of names) {
    const value = normalizeNonNegativeInteger(headers.get(name))
    if (value !== null) return value
  }
  return null
}

function mergeQuota(current: DownloadQuota, updated: DownloadQuota): DownloadQuota {
  return {
    limit: updated.limit ?? current.limit,
    remaining: updated.remaining ?? current.remaining,
  }
}

function ready(request: FormalDownloadRequest): DownloadReady {
  return { requestId: request.requestId, resourceId: request.resourceId }
}

function signedUrlFrom(payload: Record<string, unknown>): string | null {
  return stringOrNull(payload.url) ?? stringOrNull(payload.download_url) ?? stringOrNull(payload.inline_url)
}

function validateResourceId(resourceId: number): void {
  if (!Number.isSafeInteger(resourceId) || resourceId < 1) {
    throw new Error('invalid Vecteezy resource ID')
  }
}

function validateRelativeDestination(destination: string): void {
  const normalized = normalize(destination)
  if (destination.trim() === '' || isAbsolute(destination) || normalized === '..'
    || normalized.startsWith('../') || normalized.startsWith('..\\')) {
    throw new Error('download destination must be relative')
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function normalizePositiveInteger(value: unknown): number | null {
  const normalized = normalizeNonNegativeInteger(value)
  return normalized !== null && normalized > 0 ? normalized : null
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const normalized = Number(value)
    return Number.isSafeInteger(normalized) ? normalized : null
  }
  return null
}
