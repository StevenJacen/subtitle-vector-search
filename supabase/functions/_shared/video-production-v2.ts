import type { DownloadMetadata } from './video-production.ts'
import { VideoProductionError } from './video-production.ts'

export interface RenderSegmentInputV2 {
  segmentIndex: number
  downloadId: number
  timelineStartMs: number
  timelineEndMs: number
  sourceInMs: number
  sourceOutMs: number
  captionEn: string
  captionZh: string
  sourceTrackId: number
  sourceCueIndex: number
}

export interface RenderOutputInputV2 {
  artifactKey: string
  outputSha256: string
  outputSizeBytes: number
  outputDurationMs: number
  width: number
  height: number
  videoCodec: 'h264'
  audioCodec: null
  pixelFormat: 'yuv420p'
  ffmpegVersion: string
  manifestSha256: string
}

export type VideoProductionV2Request =
  | { action: 'startV2'; requestDigest: string; theme: string; aspectRatio: '9:16' | '16:9'; width: number; height: number; sceneCount: number; sourceTrackId: number; sourceStartCueIndex: number; sourceEndCueIndex: number; expectedDurationMs: number }
  | ({ action: 'recordDownloadV2'; renderId: string; selectionId: number; reservationId: string } & DownloadMetadata)
  | { action: 'beginRenderV2'; renderId: string }
  | { action: 'completeV2'; renderId: string; segments: RenderSegmentInputV2[]; output: RenderOutputInputV2 }
  | { action: 'failV2'; renderId: string; failureCode: string; failureMessage: string }
  | { action: 'retryV2'; renderId: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/
const ARTIFACT_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const FAILURE_CODES = new Set(['download_failure', 'source_validation_failure', 'render_failure', 'metadata_failure'])
const FORBIDDEN_KEY = /(?:url|token|secret|authorization|api[_-]?key|access[_-]?key|credential|password)/i
const SENSITIVE_URL_VOCABULARY = /(?:signed|status|download|media|signature|x-amz-[a-z0-9-]*|x-goog-[a-z0-9-]*|api[_-]?key|access[_-]?key|token|secret|credential|policy|expires|key-pair-id|authorization|(?:^|[^a-z0-9])(?:sig|auth)(?:$|[^a-z0-9]))/i

export function parseVideoProductionV2Request(value: unknown): VideoProductionV2Request {
  rejectForbiddenKeys(value)
  const input = object(value)
  switch (input.action) {
    case 'startV2': return parseStart(input)
    case 'recordDownloadV2': return parseDownload(input)
    case 'beginRenderV2':
    case 'retryV2':
      exactKeys(input, ['action', 'renderId'])
      return { action: input.action, renderId: uuid(input.renderId) }
    case 'completeV2': return parseComplete(input)
    case 'failV2': return parseFail(input)
    default: throw invalidRequest()
  }
}

function parseStart(input: Record<string, unknown>): Extract<VideoProductionV2Request, { action: 'startV2' }> {
  exactKeys(input, [
    'action', 'requestDigest', 'theme', 'aspectRatio', 'width', 'height', 'sceneCount',
    'sourceTrackId', 'sourceStartCueIndex', 'sourceEndCueIndex', 'expectedDurationMs',
  ])
  const validDimensions = (input.aspectRatio === '16:9' && input.width === 1920 && input.height === 1080)
    || (input.aspectRatio === '9:16' && input.width === 1080 && input.height === 1920)
  if (!sha256(input.requestDigest)
    || !boundedText(input.theme, 300)
    || !validDimensions
    || !integerInRange(input.sceneCount, 5, 10)
    || !positiveInteger(input.sourceTrackId)
    || !nonnegativeInteger(input.sourceStartCueIndex)
    || !nonnegativeInteger(input.sourceEndCueIndex)
    || input.sourceEndCueIndex !== input.sourceStartCueIndex + input.sceneCount - 1
    || !integerInRange(input.expectedDurationMs, 15_000, 60_000)) {
    throw invalidRequest()
  }
  return input as unknown as Extract<VideoProductionV2Request, { action: 'startV2' }>
}

function parseDownload(input: Record<string, unknown>): Extract<VideoProductionV2Request, { action: 'recordDownloadV2' }> {
  exactKeys(input, [
    'action', 'renderId', 'selectionId', 'reservationId', 'artifactKey', 'fileType',
    'sourceSizeBytes', 'sourceSha256', 'width', 'height', 'durationMs', 'frameRate',
    'videoCodec', 'audioCodec', 'requiresAttribution', 'requiredAttributionUrl',
    'quotaLimit', 'quotaRemaining',
  ])
  const renderId = uuid(input.renderId)
  const reservationId = uuid(input.reservationId)
  if (!positiveInteger(input.selectionId)) throw invalidRequest()
  return {
    action: 'recordDownloadV2',
    renderId,
    selectionId: input.selectionId,
    reservationId,
    ...downloadMetadata(input),
  }
}

function parseComplete(input: Record<string, unknown>): Extract<VideoProductionV2Request, { action: 'completeV2' }> {
  exactKeys(input, ['action', 'renderId', 'segments', 'output'])
  const renderId = uuid(input.renderId)
  if (!Array.isArray(input.segments) || !integerInRange(input.segments.length, 5, 10)) throw invalidRequest()
  const segments = input.segments.map((value, index) => parseSegment(value, index))
  return { action: 'completeV2', renderId, segments, output: parseOutput(input.output) }
}

function parseSegment(value: unknown, expectedIndex: number): RenderSegmentInputV2 {
  const input = object(value)
  exactKeys(input, [
    'segmentIndex', 'downloadId', 'timelineStartMs', 'timelineEndMs', 'sourceInMs',
    'sourceOutMs', 'captionEn', 'captionZh', 'sourceTrackId', 'sourceCueIndex',
  ])
  if (input.segmentIndex !== expectedIndex
    || !positiveInteger(input.downloadId)
    || !nonnegativeInteger(input.timelineStartMs)
    || !positiveInteger(input.timelineEndMs)
    || input.timelineEndMs <= input.timelineStartMs
    || !nonnegativeInteger(input.sourceInMs)
    || !positiveInteger(input.sourceOutMs)
    || input.sourceOutMs <= input.sourceInMs
    || !boundedText(input.captionEn, 10_000)
    || !boundedText(input.captionZh, 2_000)
    || !positiveInteger(input.sourceTrackId)
    || !nonnegativeInteger(input.sourceCueIndex)) {
    throw invalidRequest()
  }
  return input as unknown as RenderSegmentInputV2
}

function parseOutput(value: unknown): RenderOutputInputV2 {
  const input = object(value)
  exactKeys(input, [
    'artifactKey', 'outputSha256', 'outputSizeBytes', 'outputDurationMs', 'width', 'height',
    'videoCodec', 'audioCodec', 'pixelFormat', 'ffmpegVersion', 'manifestSha256',
  ])
  const validDimensions = (input.width === 1920 && input.height === 1080)
    || (input.width === 1080 && input.height === 1920)
  if (!workbenchArtifactKey(input.artifactKey)
    || !sha256(input.outputSha256)
    || !positiveInteger(input.outputSizeBytes)
    || !positiveInteger(input.outputDurationMs)
    || !validDimensions
    || input.videoCodec !== 'h264'
    || input.audioCodec !== null
    || input.pixelFormat !== 'yuv420p'
    || !boundedText(input.ffmpegVersion, 500)
    || !sha256(input.manifestSha256)) {
    throw invalidRequest()
  }
  return input as unknown as RenderOutputInputV2
}

function parseFail(input: Record<string, unknown>): Extract<VideoProductionV2Request, { action: 'failV2' }> {
  exactKeys(input, ['action', 'renderId', 'failureCode', 'failureMessage'])
  if (typeof input.failureCode !== 'string'
    || !FAILURE_CODES.has(input.failureCode)
    || !boundedText(input.failureMessage, 500)) {
    throw invalidRequest()
  }
  return {
    action: 'failV2', renderId: uuid(input.renderId),
    failureCode: input.failureCode, failureMessage: input.failureMessage,
  }
}

function downloadMetadata(input: Record<string, unknown>): DownloadMetadata {
  const quotaLimit = nullableNonnegativeInteger(input.quotaLimit)
  const quotaRemaining = nullableNonnegativeInteger(input.quotaRemaining)
  if (input.fileType !== 'mp4'
    || !workbenchArtifactKey(input.artifactKey)
    || !positiveInteger(input.sourceSizeBytes)
    || !sha256(input.sourceSha256)
    || !positiveInteger(input.width)
    || !positiveInteger(input.height)
    || !positiveInteger(input.durationMs)
    || !positiveNumber(input.frameRate)
    || !boundedText(input.videoCodec, 200)
    || !(input.audioCodec === null || boundedText(input.audioCodec, 200))
    || typeof input.requiresAttribution !== 'boolean'
    || (quotaLimit === null) !== (quotaRemaining === null)
    || (quotaLimit !== null && quotaRemaining !== null && quotaRemaining > quotaLimit)) {
    throw invalidRequest()
  }
  let requiredAttributionUrl: string | null
  if (input.requiresAttribution) {
    if (!stableAttributionUrl(input.requiredAttributionUrl)) throw invalidRequest()
    requiredAttributionUrl = input.requiredAttributionUrl
  } else {
    if (input.requiredAttributionUrl !== null) throw invalidRequest()
    requiredAttributionUrl = null
  }
  return {
    artifactKey: input.artifactKey as string,
    fileType: 'mp4',
    sourceSizeBytes: input.sourceSizeBytes as number,
    sourceSha256: input.sourceSha256 as string,
    width: input.width as number,
    height: input.height as number,
    durationMs: input.durationMs as number,
    frameRate: input.frameRate as number,
    videoCodec: input.videoCodec as string,
    audioCodec: input.audioCodec as string | null,
    requiresAttribution: input.requiresAttribution,
    requiredAttributionUrl,
    quotaLimit,
    quotaRemaining,
  }
}

function rejectForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectForbiddenKeys)
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key) && key !== 'requiredAttributionUrl') throw invalidRequest()
    rejectForbiddenKeys(nested)
  }
}

function stableAttributionUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_000) return false
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') return false
    return !SENSITIVE_URL_VOCABULARY.test(decodeUrlComponents(value))
  } catch {
    return false
  }
}

function decodeUrlComponents(value: string): string {
  let decoded = value
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    } catch {
      break
    }
  }
  return decoded
}

function workbenchArtifactKey(value: unknown): value is string {
  if (typeof value !== 'string' || !ARTIFACT_KEY.test(value) || /(^|\/)\.\.(\/|$)/.test(value)) return false
  const match = /^video-runs\/([^/]+)\/(.+)$/.exec(value)
  if (match === null || !UUID.test(match[1])) return false
  return match[2].split('/').every(segment => segment !== '' && segment !== '.')
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).length !== allowed.length || Object.keys(value).some(key => !allowed.includes(key))) throw invalidRequest()
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidRequest()
  return value as Record<string, unknown>
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalidRequest()
  return value.toLowerCase()
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value)
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maximum
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function integerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER
}

function nullableNonnegativeInteger(value: unknown): number | null {
  if (value === null) return null
  if (!nonnegativeInteger(value)) throw invalidRequest()
  return value
}

function invalidRequest(): VideoProductionError {
  return new VideoProductionError(400, 'invalid_request', 'invalid request')
}
