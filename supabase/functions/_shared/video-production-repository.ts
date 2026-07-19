import {
  VideoProductionError,
  type VideoProductionRequest,
} from './video-production.ts'

export interface VideoProductionRepository {
  start(input: Extract<VideoProductionRequest, { action: 'start' }>): Promise<{ renderId: string; status: string; isExisting: boolean }>
  recordDownload(input: Extract<VideoProductionRequest, { action: 'recordDownload' }>): Promise<{ downloadId: number }>
  beginRender(renderId: string): Promise<{ status: 'rendering' }>
  complete(input: Extract<VideoProductionRequest, { action: 'complete' }>): Promise<{ status: 'completed' }>
  fail(input: Extract<VideoProductionRequest, { action: 'fail' }>): Promise<{ status: 'failed' }>
  retry(renderId: string): Promise<{ status: 'planned' | 'downloading' }>
}

interface DatabaseResult {
  data: unknown
  error: unknown
}

interface SupabaseRepositoryClient {
  rpc(name: string, arguments_: Record<string, unknown>): PromiseLike<DatabaseResult>
}

export function createVideoProductionRepository(client: SupabaseRepositoryClient): VideoProductionRepository {
  return {
    async start(input) {
      const result = firstRow(await database(client.rpc('start_video_render', {
        p_request_digest: input.requestDigest,
        p_theme: input.theme,
      })))
      return {
        renderId: uuid(result.render_id),
        status: text(result.status),
        isExisting: boolean(result.is_existing),
      }
    },

    async recordDownload(input) {
      const result = firstRow(await database(client.rpc('record_video_asset_download', {
        p_render_id: input.renderId,
        p_selection_id: input.selectionId,
        p_artifact_key: input.artifactKey,
        p_file_type: input.fileType,
        p_source_size_bytes: input.sourceSizeBytes,
        p_source_sha256: input.sourceSha256,
        p_width: input.width,
        p_height: input.height,
        p_duration_ms: input.durationMs,
        p_frame_rate: input.frameRate,
        p_video_codec: input.videoCodec,
        p_audio_codec: input.audioCodec,
        p_requires_attribution: input.requiresAttribution,
        p_required_attribution_url: input.requiredAttributionUrl,
        p_quota_limit: input.quotaLimit,
        p_quota_remaining: input.quotaRemaining,
      })))
      uuid(result.render_id)
      return { downloadId: positiveInteger(result.download_id) }
    },

    async beginRender(renderId) {
      const result = firstRow(await database(client.rpc('begin_video_render', { p_render_id: renderId })))
      if (result.status !== 'rendering') throw productionFailure()
      return { status: 'rendering' }
    },

    async complete(input) {
      const result = firstRow(await database(client.rpc('complete_video_render', {
        p_render_id: input.renderId,
        p_segments: input.segments.map(segment => ({
          segment_index: segment.segmentIndex,
          download_id: segment.downloadId,
          timeline_start_ms: segment.timelineStartMs,
          timeline_end_ms: segment.timelineEndMs,
          source_in_ms: segment.sourceInMs,
          source_out_ms: segment.sourceOutMs,
          caption_kind: segment.captionKind,
          caption_en: segment.captionEn,
          caption_zh: segment.captionZh,
          source_track_id: segment.sourceTrackId,
          source_cue_index: segment.sourceCueIndex,
        })),
        p_output: {
          artifact_key: input.output.artifactKey,
          output_sha256: input.output.outputSha256,
          output_size_bytes: input.output.outputSizeBytes,
          output_duration_ms: input.output.outputDurationMs,
          video_codec: input.output.videoCodec,
          audio_codec: input.output.audioCodec,
          pixel_format: input.output.pixelFormat,
          ffmpeg_version: input.output.ffmpegVersion,
          manifest_sha256: input.output.manifestSha256,
        },
      })))
      if (result.status !== 'completed') throw productionFailure()
      return { status: 'completed' }
    },

    async fail(input) {
      const result = firstRow(await database(client.rpc('fail_video_render', {
        p_render_id: input.renderId,
        p_failure_code: input.failureCode,
        p_failure_message: input.failureMessage,
      })))
      if (result.status !== 'failed') throw productionFailure()
      return { status: 'failed' }
    },

    async retry(renderId) {
      const result = firstRow(await database(client.rpc('retry_video_render', { p_render_id: renderId })))
      if (result.status !== 'planned' && result.status !== 'downloading') throw productionFailure()
      return { status: result.status }
    },
  }
}

async function database(result: DatabaseResult | PromiseLike<DatabaseResult>): Promise<unknown> {
  let resolved: DatabaseResult
  try {
    resolved = await result
  } catch {
    throw productionFailure()
  }
  if (resolved.error !== null) throw databaseError(resolved.error)
  return resolved.data
}

function databaseError(error: unknown): VideoProductionError {
  switch (databaseErrorCode(error)) {
    case 'P0002': return new VideoProductionError(404, 'render_not_found', 'render not found')
    case 'P0003': return new VideoProductionError(409, 'invalid_render_state', 'invalid render state')
    case 'P0004': return new VideoProductionError(409, 'metadata_conflict', 'metadata conflict')
    case 'P0005': return new VideoProductionError(422, 'incomplete_render', 'incomplete render')
    case 'P0006': return new VideoProductionError(422, 'quote_mismatch', 'quote mismatch')
    default: return productionFailure()
  }
}

function databaseErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return null
  const code = (error as Record<string, unknown>).code
  return typeof code === 'string' ? code : null
}

function firstRow(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) throw productionFailure()
  return record(value[0])
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw productionFailure()
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw productionFailure()
  return value
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw productionFailure()
  }
  return value
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw productionFailure()
  return value
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw productionFailure()
  return value
}

function productionFailure(): VideoProductionError {
  return new VideoProductionError(500, 'production_metadata_failed', 'production metadata failed')
}
