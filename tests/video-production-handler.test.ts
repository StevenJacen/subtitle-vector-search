import { describe, expect, it, vi } from 'vitest'
import {
  createVideoProductionRepository,
  type VideoProductionRepository,
} from '../supabase/functions/_shared/video-production-repository.js'
import { handleVideoProductionRequest } from '../supabase/functions/_shared/video-production-handler.js'
import { VideoProductionError, type VideoProductionRequest } from '../supabase/functions/_shared/video-production.js'

const renderId = 'd62a53a1-08fb-4bee-a1ed-d8ba13de85f2'
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
})

describe('video production repository', () => {
  it.each([
    ['start', input('start'), 'start_video_render', { p_request_digest: sha256, p_theme: 'Classic cinema' }, [{ render_id: renderId, status: 'planned', is_existing: false }]],
    ['recordDownload', input('recordDownload'), 'record_video_asset_download', expect.any(Object), [{ render_id: renderId, download_id: 4 }]],
    ['beginRender', input('beginRender'), 'begin_video_render', { p_render_id: renderId }, [{ status: 'rendering' }]],
    ['complete', input('complete'), 'complete_video_render', expect.any(Object), [{ status: 'completed' }]],
    ['fail', input('fail'), 'fail_video_render', { p_render_id: renderId, p_failure_code: 'render_failure', p_failure_message: 'video render failed' }, [{ status: 'failed' }]],
    ['retry', input('retry'), 'retry_video_render', { p_render_id: renderId }, [{ status: 'planned' }]],
  ] as const)('uses %s RPC with snake_case payload', async (method, value, rpcName, payload, data) => {
    const rpc = vi.fn().mockResolvedValue({ data, error: null })
    const repo = createVideoProductionRepository({ rpc })

    await (method === 'start' ? repo.start(value as Extract<VideoProductionRequest, { action: 'start' }>)
      : method === 'recordDownload' ? repo.recordDownload(value as Extract<VideoProductionRequest, { action: 'recordDownload' }>)
      : method === 'beginRender' ? repo.beginRender(renderId)
      : method === 'complete' ? repo.complete(value as Extract<VideoProductionRequest, { action: 'complete' }>)
      : method === 'fail' ? repo.fail(value as Extract<VideoProductionRequest, { action: 'fail' }>)
      : repo.retry(renderId))

    expect(rpc).toHaveBeenCalledWith(rpcName, payload)
    if (method === 'recordDownload') expect(rpc.mock.calls[0][1]).toEqual({ p_render_id: renderId, p_selection_id: 1, p_artifact_key: `video-runs/${renderId}/source.mp4`, p_file_type: 'mp4', p_source_size_bytes: 1, p_source_sha256: sha256, p_width: 1, p_height: 1, p_duration_ms: 1, p_frame_rate: 1, p_video_codec: 'h264', p_audio_codec: null, p_requires_attribution: false, p_required_attribution_url: null, p_quota_limit: null, p_quota_remaining: null })
    if (method === 'complete') expect(rpc.mock.calls[0][1]).toEqual(expect.objectContaining({ p_render_id: renderId, p_segments: expect.any(Array), p_output: expect.objectContaining({ artifact_key: `video-runs/${renderId}/output.mp4`, output_sha256: sha256 }) }))
  })

  it.each([
    ['P0002', 404, 'render_not_found'], ['P0003', 409, 'invalid_render_state'], ['P0004', 409, 'metadata_conflict'], ['P0005', 422, 'incomplete_render'], ['P0006', 422, 'quote_mismatch'],
  ])('maps SQLSTATE %s without exposing raw database details', async (sqlstate, status, code) => {
    const secret = `raw database details ${sqlstate}`
    const repo = createVideoProductionRepository({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: sqlstate, message: secret } }) })

    await expect(repo.start(input('start'))).rejects.toStrictEqual(new VideoProductionError(status, code, code.replaceAll('_', ' ')))
    await expect(repo.start(input('start'))).rejects.not.toThrow(secret)
  })
})
