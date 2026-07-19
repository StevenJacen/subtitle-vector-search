export interface DownloadMetadata {
  artifactKey: string
  fileType: 'mp4'
  sourceSizeBytes: number
  sourceSha256: string
  width: number
  height: number
  durationMs: number
  frameRate: number
  videoCodec: string
  audioCodec: string | null
  requiresAttribution: boolean
  requiredAttributionUrl: string | null
  quotaLimit: number | null
  quotaRemaining: number | null
}

export interface RenderSegmentInput {
  segmentIndex: 0 | 1 | 2 | 3
  downloadId: number
  timelineStartMs: number
  timelineEndMs: number
  sourceInMs: number
  sourceOutMs: number
  captionKind: 'original' | 'quote'
  captionEn: string
  captionZh: string
  sourceTrackId: number | null
  sourceCueIndex: number | null
}

export interface RenderOutputInput {
  artifactKey: string
  outputSha256: string
  outputSizeBytes: number
  outputDurationMs: number
  videoCodec: string
  audioCodec: string
  pixelFormat: string
  ffmpegVersion: string
  manifestSha256: string
}

export type VideoProductionRequest =
  | { action: 'start'; requestDigest: string; theme: string }
  | ({ action: 'recordDownload'; renderId: string; selectionId: number } & DownloadMetadata)
  | { action: 'beginRender'; renderId: string }
  | { action: 'complete'; renderId: string; segments: RenderSegmentInput[]; output: RenderOutputInput }
  | { action: 'fail'; renderId: string; failureCode: string; failureMessage: string }
  | { action: 'retry'; renderId: string }

export class VideoProductionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'VideoProductionError'
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sha256Pattern = /^[0-9a-f]{64}$/
const artifactKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const failureCodes = new Set([
  'download_failure',
  'source_validation_failure',
  'render_failure',
  'metadata_failure',
])

export function parseVideoProductionRequest(value: unknown): VideoProductionRequest {
  rejectForbiddenKeys(value)
  const input = object(value)
  const action = input.action
  if (typeof action !== 'string') throw invalidRequest()

  switch (action) {
    case 'start':
      exactKeys(input, ['action', 'requestDigest', 'theme'])
      if (!sha256(input.requestDigest) || !boundedText(input.theme, 300)) throw invalidRequest()
      return { action, requestDigest: input.requestDigest, theme: input.theme }
    case 'recordDownload':
      exactKeys(input, [
        'action', 'renderId', 'selectionId', 'artifactKey', 'fileType', 'sourceSizeBytes',
        'sourceSha256', 'width', 'height', 'durationMs', 'frameRate', 'videoCodec', 'audioCodec',
        'requiresAttribution', 'requiredAttributionUrl', 'quotaLimit', 'quotaRemaining',
      ])
      if (!positiveInteger(input.selectionId)) throw invalidRequest()
      return { action, renderId: renderId(input.renderId), selectionId: input.selectionId, ...downloadMetadata(input, renderId(input.renderId)) }
    case 'beginRender':
    case 'retry':
      exactKeys(input, ['action', 'renderId'])
      return { action, renderId: renderId(input.renderId) }
    case 'complete': {
      exactKeys(input, ['action', 'renderId', 'segments', 'output'])
      const parsedRenderId = renderId(input.renderId)
      const segments = renderSegments(input.segments)
      if (!Array.isArray(input.output)) {
        return { action, renderId: parsedRenderId, segments, output: renderOutput(input.output, parsedRenderId) }
      }
      throw invalidRequest()
    }
    case 'fail':
      exactKeys(input, ['action', 'renderId', 'failureCode', 'failureMessage'])
      const failureCode = input.failureCode
      const failureMessage = input.failureMessage
      if (typeof failureCode !== 'string'
        || !failureCodes.has(failureCode)
        || !boundedText(failureMessage, 500)) {
        throw invalidRequest()
      }
      return {
        action,
        renderId: renderId(input.renderId),
        failureCode,
        failureMessage,
      }
    default:
      throw invalidRequest()
  }
}

function downloadMetadata(input: Record<string, unknown>, expectedRenderId: string): DownloadMetadata {
  const requiresAttribution = input.requiresAttribution
  const attribution = input.requiredAttributionUrl
  const quotaLimit = nullableNonnegativeInteger(input.quotaLimit)
  const quotaRemaining = nullableNonnegativeInteger(input.quotaRemaining)
  if (input.fileType !== 'mp4'
    || !artifactKey(input.artifactKey, expectedRenderId)
    || !positiveInteger(input.sourceSizeBytes)
    || !sha256(input.sourceSha256)
    || !positiveInteger(input.width)
    || !positiveInteger(input.height)
    || !positiveInteger(input.durationMs)
    || !positiveNumber(input.frameRate)
    || !boundedText(input.videoCodec, 200)
    || !(input.audioCodec === null || boundedText(input.audioCodec, 200))
    || typeof requiresAttribution !== 'boolean'
    || (quotaLimit === null) !== (quotaRemaining === null)
    || (quotaLimit !== null && quotaRemaining !== null && quotaRemaining > quotaLimit)) {
    throw invalidRequest()
  }
  let requiredAttributionUrl: string | null
  if (requiresAttribution) {
    if (!httpsUrl(attribution)) throw invalidRequest()
    requiredAttributionUrl = attribution
  } else {
    if (attribution !== null) throw invalidRequest()
    requiredAttributionUrl = null
  }
  return {
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
    requiresAttribution,
    requiredAttributionUrl,
    quotaLimit,
    quotaRemaining,
  }
}

function renderSegments(value: unknown): RenderSegmentInput[] {
  if (!Array.isArray(value) || value.length !== 4) throw invalidRequest()
  const segments = value.map((item, index) => renderSegment(item, index))
  if (segments.filter(segment => segment.captionKind === 'quote').length !== 1) throw invalidRequest()
  return segments
}

function renderSegment(value: unknown, expectedIndex: number): RenderSegmentInput {
  const input = object(value)
  exactKeys(input, [
    'segmentIndex', 'downloadId', 'timelineStartMs', 'timelineEndMs', 'sourceInMs', 'sourceOutMs',
    'captionKind', 'captionEn', 'captionZh', 'sourceTrackId', 'sourceCueIndex',
  ])
  const captionKind = input.captionKind
  const segmentIndex = input.segmentIndex
  const sourceTrackId = nullableNonnegativeInteger(input.sourceTrackId)
  const sourceCueIndex = nullableNonnegativeInteger(input.sourceCueIndex)
  if (segmentIndex !== expectedIndex
    || !positiveInteger(input.downloadId)
    || !nonnegativeInteger(input.timelineStartMs)
    || !positiveInteger(input.timelineEndMs)
    || !nonnegativeInteger(input.sourceInMs)
    || !positiveInteger(input.sourceOutMs)
    || input.timelineEndMs <= input.timelineStartMs
    || input.sourceOutMs <= input.sourceInMs
    || (captionKind !== 'original' && captionKind !== 'quote')
    || !boundedText(input.captionEn, 10_000)
    || !boundedText(input.captionZh, 10_000)
    || (captionKind === 'quote' && (sourceTrackId === null || sourceCueIndex === null))
    || (captionKind === 'original' && (sourceTrackId !== null || sourceCueIndex !== null))) {
    throw invalidRequest()
  }
  return {
    segmentIndex: expectedIndex as 0 | 1 | 2 | 3,
    downloadId: input.downloadId,
    timelineStartMs: input.timelineStartMs,
    timelineEndMs: input.timelineEndMs,
    sourceInMs: input.sourceInMs,
    sourceOutMs: input.sourceOutMs,
    captionKind,
    captionEn: input.captionEn,
    captionZh: input.captionZh,
    sourceTrackId,
    sourceCueIndex,
  }
}

function renderOutput(value: unknown, expectedRenderId: string): RenderOutputInput {
  const input = object(value)
  exactKeys(input, [
    'artifactKey', 'outputSha256', 'outputSizeBytes', 'outputDurationMs', 'videoCodec', 'audioCodec',
    'pixelFormat', 'ffmpegVersion', 'manifestSha256',
  ])
  if (!artifactKey(input.artifactKey, expectedRenderId)
    || !sha256(input.outputSha256)
    || !positiveInteger(input.outputSizeBytes)
    || !positiveInteger(input.outputDurationMs)
    || !boundedText(input.videoCodec, 200)
    || !boundedText(input.audioCodec, 200)
    || !boundedText(input.pixelFormat, 200)
    || !boundedText(input.ffmpegVersion, 200)
    || !sha256(input.manifestSha256)) {
    throw invalidRequest()
  }
  return {
    artifactKey: input.artifactKey,
    outputSha256: input.outputSha256,
    outputSizeBytes: input.outputSizeBytes,
    outputDurationMs: input.outputDurationMs,
    videoCodec: input.videoCodec,
    audioCodec: input.audioCodec,
    pixelFormat: input.pixelFormat,
    ffmpegVersion: input.ffmpegVersion,
    manifestSha256: input.manifestSha256,
  }
}

function rejectForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectForbiddenKeys)
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLocaleLowerCase('en-US')
    if (normalized === 'url' || normalized === 'signedurl' || normalized === 'statusurl' || normalized === 'downloadurl') {
      throw invalidRequest()
    }
    rejectForbiddenKeys(nested)
  }
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).length !== allowed.length || Object.keys(value).some(key => !allowed.includes(key))) {
    throw invalidRequest()
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidRequest()
  return value as Record<string, unknown>
}

function renderId(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw invalidRequest()
  return value
}

function artifactKey(value: unknown, expectedRenderId: string): value is string {
  if (typeof value !== 'string' || !artifactKeyPattern.test(value) || /(^|\/)\.\.(\/|$)/.test(value)) return false
  const match = /^video-runs\/([^/]+)\/(.+)$/.exec(value)
  return match !== null
    && uuidPattern.test(match[1])
    && match[1].toLocaleLowerCase('en-US') === expectedRenderId.toLocaleLowerCase('en-US')
    && match[2].split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && sha256Pattern.test(value)
}

function httpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function boundedText(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maximumLength
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function nullableNonnegativeInteger(value: unknown): number | null {
  if (value === null) return null
  if (!nonnegativeInteger(value)) throw invalidRequest()
  return value
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
    && value <= Number.MAX_SAFE_INTEGER
}

function invalidRequest(): VideoProductionError {
  return new VideoProductionError(400, 'invalid_request', 'invalid request')
}
