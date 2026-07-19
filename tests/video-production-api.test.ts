import { describe, expect, it, vi } from 'vitest'
import {
  SubtitleApiError,
  SubtitleApiTransportError,
} from '../src/supabase-api.js'
import {
  VideoProductionApi,
  type CompleteRenderRequest,
  type RecordDownloadRequest,
} from '../src/video-production-api.js'

const config = {
  supabaseUrl: 'https://project.supabase.co/',
  publishableKey: 'publishable-key',
  personalToken: 'personal-token',
}

const renderId = 'd62a53a1-08fb-4bee-a1ed-d8ba13de85f2'
const runId = 'a62a53a1-08fb-4bee-a1ed-d8ba13de85f2'
const sha256 = 'a'.repeat(64)

const candidate = {
  provider: 'vecteezy' as const,
  providerResourceId: 42,
  title: 'A quiet road',
  licenseType: 'free',
  aiGenerated: false,
  orientation: 'landscape',
  fileTypes: [{ extension: 'mp4', sizeInBytes: 1024 }],
  downloadSizes: [{ id: 'download-1', width: 1920, height: 1080 }],
  score: 0.9,
  bestRank: 1,
  matchedBy: ['literal' as const],
  previewUrl: 'https://cdn.example.test/preview.mp4',
}

const sceneMatch = {
  runId,
  status: 'completed' as const,
  planner: { model: 'planner', promptVersion: 'v1', fallbackUsed: false },
  visualIntent: {
    subject: 'a road',
    action: 'stretching ahead',
    setting: 'countryside',
    mood: 'hopeful',
    lighting: 'morning',
    shot: 'wide',
  },
  queries: [{ kind: 'literal' as const, term: 'quiet road', status: 'completed' as const }],
  candidates: [candidate],
}

const metadata: RecordDownloadRequest = {
  renderId,
  selectionId: 9,
  artifactKey: `video-runs/${renderId}/source.mp4`,
  fileType: 'mp4',
  sourceSizeBytes: 1024,
  sourceSha256: sha256,
  width: 1920,
  height: 1080,
  durationMs: 10_000,
  frameRate: 30,
  videoCodec: 'h264',
  audioCodec: 'aac',
  requiresAttribution: true,
  requiredAttributionUrl: 'https://example.test/license',
  quotaLimit: 100,
  quotaRemaining: 99,
}

const complete: CompleteRenderRequest = {
  renderId,
  segments: [0, 1, 2, 3].map(segmentIndex => ({
    segmentIndex: segmentIndex as 0 | 1 | 2 | 3,
    downloadId: segmentIndex + 1,
    timelineStartMs: segmentIndex * 5_000,
    timelineEndMs: (segmentIndex + 1) * 5_000,
    sourceInMs: 0,
    sourceOutMs: 5_000,
    captionKind: segmentIndex === 1 ? 'quote' as const : 'original' as const,
    captionEn: segmentIndex === 1 ? 'source quote' : 'original caption',
    captionZh: 'caption zh',
    sourceTrackId: segmentIndex === 1 ? 7 : null,
    sourceCueIndex: segmentIndex === 1 ? 12 : null,
  })),
  output: {
    artifactKey: `video-runs/${renderId}/output/final.mp4`,
    outputSha256: sha256,
    outputSizeBytes: 2048,
    outputDurationMs: 20_000,
    videoCodec: 'h264',
    audioCodec: 'aac',
    pixelFormat: 'yuv420p',
    ffmpegVersion: '7.1',
    manifestSha256: sha256,
  },
}

const publicStatusResponse = (status: 'planned' | 'downloading' | 'rendering' | 'completed' | 'failed', isExisting?: boolean) => ({
  renderId,
  status,
  ...(isExisting === undefined ? {} : { isExisting }),
})

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function createApi(fetchFn: typeof fetch, delayFn = vi.fn().mockResolvedValue(undefined)): VideoProductionApi {
  return new VideoProductionApi({ ...config, fetchFn, delayFn })
}

describe('VideoProductionApi', () => {
  it('matches a scene with exact URL, authentication headers, and JSON body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(sceneMatch))
    const api = createApi(fetchFn)

    await expect(api.matchScene({ theme: 'Classic cinema', candidateCount: 8 })).resolves.toEqual(sceneMatch)
    expect(fetchFn).toHaveBeenCalledWith(
      'https://project.supabase.co/functions/v1/match-video-assets',
      expect.objectContaining({
        method: 'POST',
        headers: {
          apikey: 'publishable-key',
          'x-subtitle-token': 'personal-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ theme: 'Classic cinema', candidateCount: 8 }),
      }),
    )
  })

  it('selects a candidate through the authenticated selection endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({ runId, providerResourceId: 42, selectionId: 9 }))
    const api = createApi(fetchFn)

    await expect(api.selectCandidate({ runId, providerResourceId: 42, note: 'chosen' }))
      .resolves.toEqual({ selectionId: 9 })
    expect(fetchFn).toHaveBeenCalledWith(
      'https://project.supabase.co/functions/v1/select-video-asset',
      expect.objectContaining({ body: JSON.stringify({ runId, providerResourceId: 42, note: 'chosen' }) }),
    )
  })

  it.each([
    ['start', (api: VideoProductionApi) => api.start({ requestDigest: sha256, theme: 'Classic cinema' }), publicStatusResponse('planned', false), publicStatusResponse('planned', false), { action: 'start', requestDigest: sha256, theme: 'Classic cinema' }],
    ['recordDownload', (api: VideoProductionApi) => api.recordDownload(metadata), { downloadId: 11 }, { renderId, downloadId: 11 }, { action: 'recordDownload', ...metadata }],
    ['beginRender', (api: VideoProductionApi) => api.beginRender(renderId), { status: 'rendering' }, publicStatusResponse('rendering'), { action: 'beginRender', renderId }],
    ['complete', (api: VideoProductionApi) => api.complete(complete), { status: 'completed' }, publicStatusResponse('completed'), { action: 'complete', ...complete }],
    ['fail', (api: VideoProductionApi) => api.fail({ renderId, failureCode: 'render_failure', failureMessage: 'render failed' }), { status: 'failed' }, publicStatusResponse('failed'), { action: 'fail', renderId, failureCode: 'render_failure', failureMessage: 'render failed' }],
    ['retry', (api: VideoProductionApi) => api.retry(renderId), { status: 'planned' }, publicStatusResponse('planned'), { action: 'retry', renderId }],
  ] as const)('sends the %s metadata action with JSON headers', async (_name, call, wireResponse, result, body) => {
    const fetchFn = vi.fn().mockResolvedValue(response(wireResponse))
    const api = createApi(fetchFn)

    await expect(call(api)).resolves.toEqual(result)
    expect(fetchFn).toHaveBeenCalledWith(
      'https://project.supabase.co/functions/v1/video-production-metadata',
      expect.objectContaining({
        method: 'POST',
        headers: {
          apikey: 'publishable-key',
          'x-subtitle-token': 'personal-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    )
  })

  it('keeps provider preview URLs out of metadata request bodies', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({ downloadId: 11 }))
    const api = createApi(fetchFn)

    await api.recordDownload(metadata)

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>
    expect(body).not.toHaveProperty('previewUrl')
    expect(body).not.toHaveProperty('downloadUrl')
    expect(body.requiredAttributionUrl).toBe('https://example.test/license')
  })

  it('accepts downloading as the retained-download retry status', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({ status: 'downloading' }))
    const api = createApi(fetchFn)

    await expect(api.retry(renderId)).resolves.toEqual(publicStatusResponse('downloading'))
  })

  it('validates candidate, selection, and metadata success payloads', async () => {
    const invalidResponses = [
      [response({ ...sceneMatch, candidates: [{ ...candidate, providerResourceId: 0 }] }), (api: VideoProductionApi) => api.matchScene({ theme: 'x', candidateCount: 1 })],
      [response({ runId, providerResourceId: 42, selectionId: '9' }), (api: VideoProductionApi) => api.selectCandidate({ runId, providerResourceId: 42, note: 'x' })],
      [response({ renderId, status: 'unknown' }), (api: VideoProductionApi) => api.start({ requestDigest: sha256, theme: 'x' })],
    ] as const

    for (const [invalidResponse, invoke] of invalidResponses) {
      const fetchFn = vi.fn().mockResolvedValue(invalidResponse)
      const api = createApi(fetchFn)
      const error = await invoke(api).catch(error => error)
      expect(error).toMatchObject({ status: 502, code: 'invalid_response' })
      expect(fetchFn).toHaveBeenCalledTimes(1)
    }
  })

  it('decodes structured Edge errors without exposing the token', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      error: { code: 'invalid_request', message: 'selection is invalid' },
    }, 400))
    const api = createApi(fetchFn)

    const error = await api.selectCandidate({ runId, providerResourceId: 42, note: 'x' }).catch(error => error)

    expect(error).toBeInstanceOf(SubtitleApiError)
    expect(error).toMatchObject({ status: 400, code: 'invalid_request', message: 'selection is invalid' })
    expect(String(error)).not.toContain(config.personalToken)
  })

  it.each([
    ['network', () => { throw new TypeError('offline') }],
    ['429', () => response({ error: { code: 'rate_limited', message: 'slow down' } }, 429)],
    ['5xx', () => response({ error: { code: 'busy', message: 'busy' } }, 503)],
  ])('retries %s failures at most twice', async (_kind, failure) => {
    const fetchFn = vi.fn()
      .mockImplementationOnce(async () => failure())
      .mockImplementationOnce(async () => failure())
      .mockResolvedValueOnce(response({ status: 'planned' }))
    const delayFn = vi.fn().mockResolvedValue(undefined)
    const api = createApi(fetchFn, delayFn)

    await expect(api.retry(renderId)).resolves.toEqual(publicStatusResponse('planned'))
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(delayFn).toHaveBeenNthCalledWith(1, 250)
    expect(delayFn).toHaveBeenNthCalledWith(2, 500)
  })

  it('does not retry non-transient 4xx responses and stops after two retries', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      error: { code: 'forbidden', message: 'forbidden' },
    }, 403))
    const delayFn = vi.fn().mockResolvedValue(undefined)
    const api = createApi(fetchFn, delayFn)

    await expect(api.retry(renderId)).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(delayFn).not.toHaveBeenCalled()

    const exhaustedFetch = vi.fn().mockImplementation(() => response({
      error: { code: 'busy', message: 'busy' },
    }, 500))
    const exhaustedApi = createApi(exhaustedFetch, delayFn)
    await expect(exhaustedApi.retry(renderId)).rejects.toMatchObject({ status: 500, code: 'busy' })
    expect(exhaustedFetch).toHaveBeenCalledTimes(3)
  })

  it('wraps an exhausted network failure as a generic transport error', async () => {
    const networkFailure = new TypeError('token should not be exposed')
    const fetchFn = vi.fn().mockRejectedValue(networkFailure)
    const delayFn = vi.fn().mockResolvedValue(undefined)
    const api = createApi(fetchFn, delayFn)

    const error = await api.retry(renderId).catch(error => error)

    expect(error).toBeInstanceOf(SubtitleApiTransportError)
    expect(error).toMatchObject({ message: 'subtitle API transport request failed' })
    expect(String(error)).not.toContain(config.personalToken)
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(delayFn).toHaveBeenCalledTimes(2)
  })
})
