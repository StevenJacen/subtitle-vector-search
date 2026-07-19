import type { VideoAssetMatchResponse as SceneMatchResponse } from '../supabase/functions/_shared/video-assets.js'
import type {
  DownloadMetadata,
  RenderOutputInput,
  RenderSegmentInput,
} from '../supabase/functions/_shared/video-production.js'
import { SubtitleApiError, SubtitleApiTransportError } from './supabase-api.js'

export interface VideoProductionApiConfig {
  supabaseUrl: string
  publishableKey: string
  personalToken: string
  fetchFn?: typeof fetch
  delayFn?: (milliseconds: number) => Promise<void>
}

export interface RenderStatusResponse {
  renderId: string
  status: 'planned' | 'downloading' | 'rendering' | 'completed' | 'failed'
  isExisting?: boolean
}

export interface StartRenderResponse extends RenderStatusResponse {
  isExisting: boolean
}

export type RecordDownloadRequest = { renderId: string; selectionId: number } & DownloadMetadata

export interface CompleteRenderRequest {
  renderId: string
  segments: RenderSegmentInput[]
  output: RenderOutputInput
}

export interface FailRenderRequest {
  renderId: string
  failureCode: string
  failureMessage: string
}

type Status = RenderStatusResponse['status']
type WireStatusResponse = { status: Status }
type WireSelectionResponse = { runId: string; providerResourceId: number; selectionId: number }
type WireDownloadResponse = { downloadId: number }

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const queryKinds = new Set(['literal', 'action', 'metaphor'])
const statusValues = new Set<Status>(['planned', 'downloading', 'rendering', 'completed', 'failed'])

export class VideoProductionApi {
  private readonly fetchFn: typeof fetch
  private readonly delayFn: (milliseconds: number) => Promise<void>
  private readonly headers: Record<string, string>
  private readonly matchUrl: string
  private readonly selectionUrl: string
  private readonly metadataUrl: string

  constructor(config: VideoProductionApiConfig) {
    this.fetchFn = config.fetchFn ?? fetch
    this.delayFn = config.delayFn ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
    const baseUrl = config.supabaseUrl.replace(/\/$/, '')
    this.matchUrl = `${baseUrl}/functions/v1/match-video-assets`
    this.selectionUrl = `${baseUrl}/functions/v1/select-video-asset`
    this.metadataUrl = `${baseUrl}/functions/v1/video-production-metadata`
    this.headers = {
      apikey: config.publishableKey,
      'x-subtitle-token': config.personalToken,
      'content-type': 'application/json',
    }
  }

  matchScene(input: { theme: string; candidateCount: number }): Promise<SceneMatchResponse> {
    return this.request(
      this.matchUrl,
      { theme: input.theme, candidateCount: input.candidateCount },
      isSceneMatchResponse,
      'video asset match',
    )
  }

  async selectCandidate(input: { runId: string; providerResourceId: number; note: string }): Promise<{ selectionId: number }> {
    const response = await this.request(
      this.selectionUrl,
      { runId: input.runId, providerResourceId: input.providerResourceId, note: input.note },
      (value): value is WireSelectionResponse => isSelectionResponse(value)
        && value.runId === input.runId
        && value.providerResourceId === input.providerResourceId,
      'video asset selection',
    )
    return { selectionId: response.selectionId }
  }

  start(input: { requestDigest: string; theme: string }): Promise<StartRenderResponse> {
    return this.request(
      this.metadataUrl,
      { action: 'start', requestDigest: input.requestDigest, theme: input.theme },
      isStartStatusResponse,
      'video production start',
    )
  }

  async recordDownload(input: RecordDownloadRequest): Promise<{ renderId: string; downloadId: number }> {
    const response = await this.request(
      this.metadataUrl,
      {
        action: 'recordDownload',
        renderId: input.renderId,
        selectionId: input.selectionId,
        artifactKey: input.artifactKey,
        fileType: input.fileType,
        sourceSizeBytes: input.sourceSizeBytes,
        sourceSha256: input.sourceSha256,
        width: input.width,
        height: input.height,
        durationMs: input.durationMs,
        frameRate: input.frameRate,
        videoCodec: input.videoCodec,
        audioCodec: input.audioCodec,
        requiresAttribution: input.requiresAttribution,
        requiredAttributionUrl: input.requiredAttributionUrl,
        quotaLimit: input.quotaLimit,
        quotaRemaining: input.quotaRemaining,
      },
      isRecordDownloadResponse,
      'video production download recording',
    )
    return { renderId: input.renderId, downloadId: response.downloadId }
  }

  async beginRender(renderId: string): Promise<RenderStatusResponse> {
    const response = await this.request(
      this.metadataUrl,
      { action: 'beginRender', renderId },
      value => isExpectedStatusResponse(value, 'rendering'),
      'video production begin render',
    )
    return { renderId, status: response.status }
  }

  async complete(input: CompleteRenderRequest): Promise<RenderStatusResponse> {
    const response = await this.request(
      this.metadataUrl,
      {
        action: 'complete',
        renderId: input.renderId,
        segments: input.segments.map(segment => ({
          segmentIndex: segment.segmentIndex,
          downloadId: segment.downloadId,
          timelineStartMs: segment.timelineStartMs,
          timelineEndMs: segment.timelineEndMs,
          sourceInMs: segment.sourceInMs,
          sourceOutMs: segment.sourceOutMs,
          captionKind: segment.captionKind,
          captionEn: segment.captionEn,
          captionZh: segment.captionZh,
          sourceTrackId: segment.sourceTrackId,
          sourceCueIndex: segment.sourceCueIndex,
        })),
        output: {
          artifactKey: input.output.artifactKey,
          outputSha256: input.output.outputSha256,
          outputSizeBytes: input.output.outputSizeBytes,
          outputDurationMs: input.output.outputDurationMs,
          videoCodec: input.output.videoCodec,
          audioCodec: input.output.audioCodec,
          pixelFormat: input.output.pixelFormat,
          ffmpegVersion: input.output.ffmpegVersion,
          manifestSha256: input.output.manifestSha256,
        },
      },
      value => isExpectedStatusResponse(value, 'completed'),
      'video production completion',
    )
    return { renderId: input.renderId, status: response.status }
  }

  async fail(input: FailRenderRequest): Promise<RenderStatusResponse> {
    const response = await this.request(
      this.metadataUrl,
      {
        action: 'fail',
        renderId: input.renderId,
        failureCode: input.failureCode,
        failureMessage: input.failureMessage,
      },
      value => isExpectedStatusResponse(value, 'failed'),
      'video production failure',
    )
    return { renderId: input.renderId, status: response.status }
  }

  async retry(renderId: string): Promise<RenderStatusResponse> {
    const response = await this.request(
      this.metadataUrl,
      { action: 'retry', renderId },
      value => isExpectedStatusResponse(value, 'planned') || isExpectedStatusResponse(value, 'downloading'),
      'video production retry',
    )
    return { renderId, status: response.status }
  }

  private async request<ResponseBody>(
    url: string,
    body: object,
    validate: (value: unknown) => value is ResponseBody,
    responseName: string,
  ): Promise<ResponseBody> {
    const requestInit: RequestInit = {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response
      try {
        response = await this.fetchFn(url, requestInit)
      } catch (cause) {
        if (attempt === 2) throw new SubtitleApiTransportError(cause)
        await this.delayFn(250 * (2 ** attempt))
        continue
      }

      const payload = await response.json().catch(() => undefined)
      if (response.ok) {
        if (!validate(payload)) {
          throw new SubtitleApiError(`${responseName} returned an invalid response`, 502, 'invalid_response')
        }
        return payload
      }

      const error = isErrorEnvelope(payload) ? payload.error : undefined
      const requestError = new SubtitleApiError(
        error?.message ?? `Subtitle API request failed with HTTP ${response.status}`,
        response.status,
        error?.code ?? 'request_failed',
      )
      if (!isTransientStatus(response.status) || attempt === 2) throw requestError
      await this.delayFn(250 * (2 ** attempt))
    }

    throw new Error('unreachable')
  }
}

function isSceneMatchResponse(value: unknown): value is SceneMatchResponse {
  if (!isRecord(value)
    || !hasExactKeys(value, ['runId', 'status', 'planner', 'visualIntent', 'queries', 'candidates'])
    || !isUuid(value.runId)
    || !isCompletedMatchStatus(value.status)
    || !isRecord(value.planner)
    || !hasExactKeys(value.planner, ['model', 'promptVersion', 'fallbackUsed'])
    || !boundedString(value.planner.model, 300)
    || !boundedString(value.planner.promptVersion, 300)
    || typeof value.planner.fallbackUsed !== 'boolean'
    || !isRecord(value.visualIntent)
    || !hasExactKeys(value.visualIntent, ['subject', 'action', 'setting', 'mood', 'lighting', 'shot'])
    || !Object.values(value.visualIntent).every(item => boundedString(item, 1_000))
    || !Array.isArray(value.queries)
    || !value.queries.every(isVisualQuery)
    || !Array.isArray(value.candidates)
    || !value.candidates.every(isCandidate)) {
    return false
  }
  return true
}

function isVisualQuery(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string' || !queryKinds.has(value.kind)
    || !boundedString(value.term, 1_000) || typeof value.status !== 'string'
    || (value.status !== 'completed' && value.status !== 'failed')) {
    return false
  }
  if (value.status === 'failed') {
    return hasExactKeys(value, ['kind', 'term', 'status', 'errorCode']) && boundedString(value.errorCode, 300)
  }
  return hasExactKeys(value, ['kind', 'term', 'status'])
}

function isCandidate(value: unknown): boolean {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'provider', 'providerResourceId', 'title', 'licenseType', 'aiGenerated', 'orientation',
      'fileTypes', 'downloadSizes', 'score', 'bestRank', 'matchedBy', 'previewUrl',
    ])
    || value.provider !== 'vecteezy'
    || !positiveInteger(value.providerResourceId)
    || !(value.title === null || boundedString(value.title, 1_000))
    || !(value.licenseType === null || boundedString(value.licenseType, 300))
    || !(value.aiGenerated === null || typeof value.aiGenerated === 'boolean')
    || !(value.orientation === null || boundedString(value.orientation, 100))
    || !Array.isArray(value.fileTypes)
    || !value.fileTypes.every(isFileType)
    || !Array.isArray(value.downloadSizes)
    || !value.downloadSizes.every(isDownloadSize)
    || !finiteNumber(value.score)
    || !positiveInteger(value.bestRank)
    || !Array.isArray(value.matchedBy)
    || !value.matchedBy.every(item => typeof item === 'string' && queryKinds.has(item))
    || !(value.previewUrl === null || httpUrl(value.previewUrl))) {
    return false
  }
  return true
}

function isFileType(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['extension', 'sizeInBytes'])
    && boundedString(value.extension, 100)
    && positiveInteger(value.sizeInBytes)
}

function isDownloadSize(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'width', 'height'])
    && boundedString(value.id, 300)
    && positiveInteger(value.width)
    && positiveInteger(value.height)
}

function isSelectionResponse(value: unknown): value is WireSelectionResponse {
  return isRecord(value)
    && hasExactKeys(value, ['runId', 'providerResourceId', 'selectionId'])
    && isUuid(value.runId)
    && positiveInteger(value.providerResourceId)
    && positiveInteger(value.selectionId)
}

function isStartStatusResponse(value: unknown): value is StartRenderResponse {
  return isRecord(value)
    && hasExactKeys(value, ['renderId', 'status', 'isExisting'])
    && isUuid(value.renderId)
    && typeof value.status === 'string'
    && statusValues.has(value.status as Status)
    && typeof value.isExisting === 'boolean'
}

function isExpectedStatusResponse(value: unknown, expected: Status): value is WireStatusResponse {
  return isRecord(value) && hasExactKeys(value, ['status']) && value.status === expected
}

function isErrorEnvelope(value: unknown): value is { error: { code: string; message: string } } {
  return isRecord(value)
    && isRecord(value.error)
    && hasExactKeys(value.error, ['code', 'message'])
    && boundedString(value.error.code, 300)
    && boundedString(value.error.message, 2_000)
}

function isRecordDownloadResponse(value: unknown): value is WireDownloadResponse {
  return isRecord(value) && hasExactKeys(value, ['downloadId']) && positiveInteger(value.downloadId)
}

function isCompletedMatchStatus(value: unknown): value is 'completed' | 'degraded' | 'failed' {
  return value === 'completed' || value === 'degraded' || value === 'failed'
}

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599)
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => key in value) && Object.keys(value).every(key => allowed.has(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value)
}

function boundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength
}

function httpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
