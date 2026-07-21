import { describe, expect, it, vi } from 'vitest'
import {
  createVideoProductionRepository,
  type VideoProductionRepository,
} from '../supabase/functions/_shared/video-production-repository.js'
import { handleVideoProductionRequest } from '../supabase/functions/_shared/video-production-handler.js'
import { VideoProductionError, type VideoProductionRequest } from '../supabase/functions/_shared/video-production.js'
import type { VideoProductionV2Request } from '../supabase/functions/_shared/video-production-v2.js'

const renderId = 'd62a53a1-08fb-4bee-a1ed-d8ba13de85f2'
const taskId = '8a291fbb-a9e1-42c2-a8d9-fc0817508b7f'
const sha256 = 'a'.repeat(64)
const environment = { get: (name: string) => name === 'SUBTITLE_PERSONAL_TOKEN' ? 'correct-token' : undefined }

function input(action: 'start'): Extract<VideoProductionRequest, { action: 'start' }>
function input(action: 'recordDownload'): Extract<VideoProductionRequest, { action: 'recordDownload' }>
function input(action: 'beginRender'): Extract<VideoProductionRequest, { action: 'beginRender' }>
function input(action: 'complete'): Extract<VideoProductionRequest, { action: 'complete' }>
function input(action: 'fail'): Extract<VideoProductionRequest, { action: 'fail' }>
function input(action: 'retry'): Extract<VideoProductionRequest, { action: 'retry' }>
function input(action: VideoProductionRequest['action']): VideoProductionRequest
function input(action: VideoProductionRequest['action']): VideoProductionRequest {
  switch (action) {
    case 'start': return { action, requestDigest: sha256, theme: 'Classic cinema' }
    case 'recordDownload': return { action, renderId, selectionId: 1, artifactKey: `video-runs/${renderId}/source.mp4`, fileType: 'mp4', sourceSizeBytes: 1, sourceSha256: sha256, width: 1, height: 1, durationMs: 1, frameRate: 1, videoCodec: 'h264', audioCodec: null, requiresAttribution: false, requiredAttributionUrl: null, quotaLimit: null, quotaRemaining: null }
    case 'beginRender': return { action, renderId }
    case 'complete': return { action, renderId, segments: [0, 1, 2, 3].map(index => ({ segmentIndex: index as 0 | 1 | 2 | 3, downloadId: index + 1, timelineStartMs: index, timelineEndMs: index + 1, sourceInMs: 0, sourceOutMs: 1, captionKind: index === 0 ? 'quote' as const : 'original' as const, captionEn: 'caption', captionZh: '字幕', sourceTrackId: index === 0 ? 1 : null, sourceCueIndex: index === 0 ? 1 : null })), output: { artifactKey: `video-runs/${renderId}/output.mp4`, outputSha256: sha256, outputSizeBytes: 1, outputDurationMs: 1, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p', ffmpegVersion: '7.1', manifestSha256: sha256 } }
    case 'fail': return { action, renderId, failureCode: 'render_failure', failureMessage: 'video render failed' }
    case 'retry': return { action, renderId }
  }
}

function request(body: unknown, token = 'correct-token'): Request {
  return new Request('https://example.test/functions/v1/video-production-metadata', {
    method: 'POST', headers: { 'x-subtitle-token': token }, body: JSON.stringify(body),
  })
}

function repository(): VideoProductionRepository {
  return {
    start: vi.fn().mockResolvedValue({ renderId, status: 'planned', isExisting: false }),
    recordDownload: vi.fn().mockResolvedValue({ downloadId: 1 }),
    beginRender: vi.fn().mockResolvedValue({ status: 'rendering' }),
    complete: vi.fn().mockResolvedValue({ status: 'completed' }),
    fail: vi.fn().mockResolvedValue({ status: 'failed' }),
    retry: vi.fn().mockResolvedValue({ status: 'planned' }),
    startV2: vi.fn().mockResolvedValue({ renderId, status: 'planned', isExisting: false }),
    recordDownloadV2: vi.fn().mockResolvedValue({ downloadId: 1 }),
    beginRenderV2: vi.fn().mockResolvedValue({ status: 'rendering' }),
    completeV2: vi.fn().mockResolvedValue({ status: 'completed' }),
    failV2: vi.fn().mockResolvedValue({ status: 'failed' }),
    retryV2: vi.fn().mockResolvedValue({ status: 'planned' }),
  }
}

function v2Input(action: 'startV2'): Extract<VideoProductionV2Request, { action: 'startV2' }>
function v2Input(action: 'recordDownloadV2'): Extract<VideoProductionV2Request, { action: 'recordDownloadV2' }>
function v2Input(action: 'beginRenderV2'): Extract<VideoProductionV2Request, { action: 'beginRenderV2' }>
function v2Input(action: 'completeV2'): Extract<VideoProductionV2Request, { action: 'completeV2' }>
function v2Input(action: 'failV2'): Extract<VideoProductionV2Request, { action: 'failV2' }>
function v2Input(action: 'retryV2'): Extract<VideoProductionV2Request, { action: 'retryV2' }>
function v2Input(action: VideoProductionV2Request['action']): VideoProductionV2Request
function v2Input(action: VideoProductionV2Request['action']): VideoProductionV2Request {
  const reservationId = '4f6bfa4b-5d5a-41f5-9084-c9889bba03fd'
  switch (action) {
    case 'startV2': return { action, requestDigest: sha256, theme: 'hope', aspectRatio: '16:9', width: 1920, height: 1080, sceneCount: 5, sourceTrackId: 7, sourceStartCueIndex: 20, sourceEndCueIndex: 24, expectedDurationMs: 15_000 }
    case 'recordDownloadV2': return { action, renderId, selectionId: 1, reservationId, artifactKey: `video-runs/${taskId}/source.mp4`, fileType: 'mp4', sourceSizeBytes: 1, sourceSha256: sha256, width: 1920, height: 1080, durationMs: 3_000, frameRate: 30, videoCodec: 'h264', audioCodec: null, requiresAttribution: false, requiredAttributionUrl: null, quotaLimit: null, quotaRemaining: null }
    case 'beginRenderV2': return { action, renderId }
    case 'completeV2': return { action, renderId, segments: Array.from({ length: 5 }, (_, index) => ({ segmentIndex: index, downloadId: index + 1, timelineStartMs: index * 3_000, timelineEndMs: (index + 1) * 3_000, sourceInMs: 0, sourceOutMs: 3_000, captionEn: `cue ${index}`, captionZh: `字幕 ${index}`, sourceTrackId: 7, sourceCueIndex: 20 + index })), output: { artifactKey: `video-runs/${taskId}/output.mp4`, outputSha256: sha256, outputSizeBytes: 1, outputDurationMs: 15_000, width: 1920, height: 1080, videoCodec: 'h264', audioCodec: null, pixelFormat: 'yuv420p', ffmpegVersion: '7.1', manifestSha256: sha256 } }
    case 'failV2': return { action, renderId, failureCode: 'render_failure', failureMessage: 'local detail' }
    case 'retryV2': return { action, renderId }
  }
}

describe('video production metadata handler', () => {
  it('authenticates before parsing JSON or creating a repository', async () => {
    const incoming = request(input('start'), 'wrong-token')
    const json = vi.fn(incoming.json.bind(incoming))
    Object.defineProperty(incoming, 'json', { value: json })
    const createRepository = vi.fn(repository)

    const response = await handleVideoProductionRequest(incoming, environment, createRepository)

    expect(response.status).toBe(401)
    expect(json).not.toHaveBeenCalled()
    expect(createRepository).not.toHaveBeenCalled()
  })

  it.each(['start', 'recordDownload', 'beginRender', 'complete', 'fail', 'retry'] as const)(
    'dispatches %s and returns only its stable response metadata',
    async action => {
      const repo = repository()
      const response = await handleVideoProductionRequest(request(input(action)), environment, () => repo)

      expect(response.status).toBe(200)
      expect(repo[action === 'recordDownload' ? 'recordDownload' : action]).toHaveBeenCalledTimes(1)
      await expect(response.json()).resolves.toEqual(action === 'start'
        ? { renderId, status: 'planned', isExisting: false }
        : action === 'recordDownload' ? { downloadId: 1 } : { status: action === 'beginRender' ? 'rendering' : action === 'complete' ? 'completed' : action === 'fail' ? 'failed' : 'planned' })
    },
  )

  it.each([
    [new VideoProductionError(404, 'render_not_found', 'render not found'), 404, 'render_not_found'],
    [new VideoProductionError(409, 'invalid_render_state', 'invalid render state'), 409, 'invalid_render_state'],
    [new VideoProductionError(409, 'metadata_conflict', 'metadata conflict'), 409, 'metadata_conflict'],
    [new VideoProductionError(422, 'incomplete_render', 'incomplete render'), 422, 'incomplete_render'],
    [new VideoProductionError(422, 'quote_mismatch', 'quote mismatch'), 422, 'quote_mismatch'],
  ])('maps controlled production errors', async (error, status, code) => {
    const repo = repository()
    repo.start = vi.fn().mockRejectedValue(error)

    const response = await handleVideoProductionRequest(request(input('start')), environment, () => repo)

    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toEqual({ error: { code, message: code.replaceAll('_', ' ') } })
  })

  it('suppresses raw repository failures', async () => {
    const secret = 'postgres details must not leave this boundary'
    const repo = repository()
    repo.start = vi.fn().mockRejectedValue(new Error(secret))

    const response = await handleVideoProductionRequest(request(input('start')), environment, () => repo)

    expect(response.status).toBe(500)
    const body = await response.text()
    expect(JSON.parse(body)).toEqual({ error: { code: 'production_metadata_failed', message: 'production metadata failed' } })
    expect(body).not.toContain(secret)
  })

  it('returns downloading when a retained-download retry resumes', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ status: 'downloading' }], error: null })
    const repo = createVideoProductionRepository({ rpc })

    const response = await handleVideoProductionRequest(request(input('retry')), environment, () => repo)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'downloading' })
    expect(rpc).toHaveBeenCalledWith('retry_video_render', { p_render_id: renderId })
  })
})

describe('video production repository', () => {
  it.each([
    ['start', input('start'), 'start_video_render', { p_request_digest: sha256, p_theme: 'Classic cinema' }, [{ render_id: renderId, status: 'planned', is_existing: false }]],
    ['recordDownload', input('recordDownload'), 'record_video_asset_download', expect.any(Object), [{ render_id: renderId, download_id: 4 }]],
    ['beginRender', input('beginRender'), 'begin_video_render', { p_render_id: renderId }, [{ status: 'rendering' }]],
    ['fail', input('fail'), 'fail_video_render', { p_render_id: renderId, p_failure_code: 'render_failure', p_failure_message: 'video render failed' }, [{ status: 'failed' }]],
    ['retry', input('retry'), 'retry_video_render', { p_render_id: renderId }, [{ status: 'planned' }]],
  ] as const)('uses %s RPC with snake_case payload', async (method, value, rpcName, payload, data) => {
    const rpc = vi.fn().mockResolvedValue({ data, error: null })
    const repo = createVideoProductionRepository({ rpc })

    await (method === 'start' ? repo.start(value as Extract<VideoProductionRequest, { action: 'start' }>)
      : method === 'recordDownload' ? repo.recordDownload(value as Extract<VideoProductionRequest, { action: 'recordDownload' }>)
      : method === 'beginRender' ? repo.beginRender(renderId)
      : method === 'fail' ? repo.fail(value as Extract<VideoProductionRequest, { action: 'fail' }>)
      : repo.retry(renderId))

    expect(rpc).toHaveBeenCalledWith(rpcName, payload)
    if (method === 'recordDownload') expect(rpc.mock.calls[0][1]).toEqual({ p_render_id: renderId, p_selection_id: 1, p_artifact_key: `video-runs/${renderId}/source.mp4`, p_file_type: 'mp4', p_source_size_bytes: 1, p_source_sha256: sha256, p_width: 1, p_height: 1, p_duration_ms: 1, p_frame_rate: 1, p_video_codec: 'h264', p_audio_codec: null, p_requires_attribution: false, p_required_attribution_url: null, p_quota_limit: null, p_quota_remaining: null })
  })

  it('sends the exact complete_video_render payload', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ status: 'completed' }], error: null })
    const repo = createVideoProductionRepository({ rpc })

    await repo.complete(input('complete'))

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('complete_video_render', {
      p_render_id: renderId,
      p_segments: [
        { segment_index: 0, download_id: 1, timeline_start_ms: 0, timeline_end_ms: 1, source_in_ms: 0, source_out_ms: 1, caption_kind: 'quote', caption_en: 'caption', caption_zh: '\u5b57\u5e55', source_track_id: 1, source_cue_index: 1 },
        { segment_index: 1, download_id: 2, timeline_start_ms: 1, timeline_end_ms: 2, source_in_ms: 0, source_out_ms: 1, caption_kind: 'original', caption_en: 'caption', caption_zh: '\u5b57\u5e55', source_track_id: null, source_cue_index: null },
        { segment_index: 2, download_id: 3, timeline_start_ms: 2, timeline_end_ms: 3, source_in_ms: 0, source_out_ms: 1, caption_kind: 'original', caption_en: 'caption', caption_zh: '\u5b57\u5e55', source_track_id: null, source_cue_index: null },
        { segment_index: 3, download_id: 4, timeline_start_ms: 3, timeline_end_ms: 4, source_in_ms: 0, source_out_ms: 1, caption_kind: 'original', caption_en: 'caption', caption_zh: '\u5b57\u5e55', source_track_id: null, source_cue_index: null },
      ],
      p_output: {
        artifact_key: `video-runs/${renderId}/output.mp4`,
        output_sha256: sha256,
        output_size_bytes: 1,
        output_duration_ms: 1,
        video_codec: 'h264',
        audio_codec: 'aac',
        pixel_format: 'yuv420p',
        ffmpeg_version: '7.1',
        manifest_sha256: sha256,
      },
    })
  })

  it.each([
    ['P0002', 404, 'render_not_found'], ['P0003', 409, 'invalid_render_state'], ['P0004', 409, 'metadata_conflict'], ['P0005', 422, 'incomplete_render'], ['P0006', 422, 'quote_mismatch'],
  ])('maps SQLSTATE %s without exposing raw database details', async (sqlstate, status, code) => {
    const secret = `raw database details ${sqlstate}`
    const repo = createVideoProductionRepository({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: sqlstate, message: secret } }) })

    await expect(repo.start(input('start'))).rejects.toStrictEqual(new VideoProductionError(status, code, code.replaceAll('_', ' ')))
    await expect(repo.start(input('start'))).rejects.not.toThrow(secret)
  })

  it('accepts downloading from retry_video_render for retained downloads', async () => {
    const repo = createVideoProductionRepository({
      rpc: vi.fn().mockResolvedValue({ data: [{ status: 'downloading' }], error: null }),
    })

    await expect(repo.retry(renderId)).resolves.toEqual({ status: 'downloading' })
  })

  it('rejects an invalid retry RPC status with the stable failure', async () => {
    const repo = createVideoProductionRepository({
      rpc: vi.fn().mockResolvedValue({ data: [{ status: 'rendering' }], error: null }),
    })

    await expect(repo.retry(renderId)).rejects.toStrictEqual(
      new VideoProductionError(500, 'production_metadata_failed', 'production metadata failed'),
    )
  })
})

describe('video production v2 metadata path', () => {
  it.each(['startV2', 'recordDownloadV2', 'beginRenderV2', 'completeV2', 'failV2', 'retryV2'] as const)(
    'dispatches %s without changing the response envelope',
    async action => {
      const repo = repository()
      const response = await handleVideoProductionRequest(request(v2Input(action)), environment, () => repo)

      expect(response.status).toBe(200)
      expect(repo[action]).toHaveBeenCalledTimes(1)
      await expect(response.json()).resolves.toEqual(action === 'startV2'
        ? { renderId, status: 'planned', isExisting: false }
        : action === 'recordDownloadV2' ? { downloadId: 1 }
        : { status: action === 'beginRenderV2' ? 'rendering' : action === 'completeV2' ? 'completed' : action === 'failV2' ? 'failed' : 'planned' })
    },
  )

  it('maps v2 calls to exact versioned RPC names and snake_case payloads', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [{ render_id: renderId, status: 'planned', is_existing: false }], error: null })
      .mockResolvedValueOnce({ data: [{ render_id: renderId, download_id: 4 }], error: null })
      .mockResolvedValueOnce({ data: [{ status: 'rendering' }], error: null })
      .mockResolvedValueOnce({ data: [{ status: 'completed' }], error: null })
      .mockResolvedValueOnce({ data: [{ status: 'failed' }], error: null })
      .mockResolvedValueOnce({ data: [{ status: 'downloading' }], error: null })
    const repo = createVideoProductionRepository({ rpc })

    await repo.startV2(v2Input('startV2'))
    await repo.recordDownloadV2(v2Input('recordDownloadV2'))
    await repo.beginRenderV2(renderId)
    await repo.completeV2(v2Input('completeV2'))
    await repo.failV2(v2Input('failV2'))
    await repo.retryV2(renderId)

    expect(rpc.mock.calls.map(call => call[0])).toEqual([
      'start_video_render_v2', 'record_video_asset_download_v2', 'begin_video_render_v2',
      'complete_video_render_v2', 'fail_video_render_v2', 'retry_video_render_v2',
    ])
    expect(rpc.mock.calls[0][1]).toEqual({
      p_request_digest: sha256, p_theme: 'hope', p_aspect_ratio: '16:9', p_width: 1920,
      p_height: 1080, p_scene_count: 5, p_source_track_id: 7,
      p_source_start_cue_index: 20, p_source_end_cue_index: 24, p_expected_duration_ms: 15_000,
    })
    expect(rpc.mock.calls[1][1]).toMatchObject({
      p_render_id: renderId, p_selection_id: 1,
      p_reservation_id: '4f6bfa4b-5d5a-41f5-9084-c9889bba03fd', p_audio_codec: null,
    })
    expect(rpc.mock.calls[3][1]).toMatchObject({
      p_render_id: renderId,
      p_segments: expect.arrayContaining([expect.objectContaining({ segment_index: 0, source_track_id: 7, source_cue_index: 20 })]),
      p_output: expect.objectContaining({ width: 1920, height: 1080, audio_codec: null }),
    })
  })
})
