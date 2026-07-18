import { describe, expect, it, vi } from 'vitest'
import {
  createVideoAssetRepository,
  type VideoAssetRepository,
} from '../supabase/functions/_shared/video-asset-repository.js'
import { handleSelectVideoAssetRequest } from '../supabase/functions/_shared/video-asset-selection.js'
import { VideoAssetError } from '../supabase/functions/_shared/video-assets.js'

const runId = 'd62a53a1-08fb-4bee-a1ed-d8ba13de85f2'
const environment = {
  get(name: string): string | undefined {
    return name === 'SUBTITLE_PERSONAL_TOKEN' ? 'correct-token' : undefined
  },
}

function request(body: unknown, token?: string, method = 'POST'): Request {
  return new Request('https://example.test/functions/v1/select-video-asset', {
    method,
    headers: token === undefined ? {} : { 'x-subtitle-token': token },
    ...((method === 'GET' || method === 'HEAD') ? {} : {
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  })
}

function selectionRepository(selectionId = 9): Pick<VideoAssetRepository, 'selectCandidate'> {
  return { selectCandidate: vi.fn().mockResolvedValue({ selectionId }) }
}

describe('manual video asset selection handler', () => {
  it('rejects missing or wrong tokens before parsing JSON or constructing dependencies', async () => {
    for (const token of [undefined, 'wrong-token']) {
      const incoming = request({ runId, providerResourceId: 42, note: 'opening' }, token)
      const json = vi.fn(incoming.json.bind(incoming))
      Object.defineProperty(incoming, 'json', { value: json })
      const createRepository = vi.fn(() => selectionRepository())

      const response = await handleSelectVideoAssetRequest(incoming, environment, createRepository)

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({
        error: { code: 'unauthorized', message: 'invalid subtitle token' },
      })
      expect(json).not.toHaveBeenCalled()
      expect(createRepository).not.toHaveBeenCalled()
    }
  })

  it.each([
    { runId: 'not-a-uuid', providerResourceId: 42, note: 'opening' },
    { runId, providerResourceId: 0, note: 'opening' },
    { runId, providerResourceId: 42, note: 'x'.repeat(501) },
  ])('returns the exact 400 contract for invalid selection input', async input => {
    const createRepository = vi.fn(() => selectionRepository())

    const response = await handleSelectVideoAssetRequest(request(input, 'correct-token'), environment, createRepository)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'invalid_request', message: 'invalid request' },
    })
    expect(createRepository).not.toHaveBeenCalled()
  })

  it('returns the exact 400 contract for malformed JSON', async () => {
    const createRepository = vi.fn(() => selectionRepository())

    const response = await handleSelectVideoAssetRequest(request('{', 'correct-token'), environment, createRepository)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'invalid_request', message: 'invalid request' },
    })
    expect(createRepository).not.toHaveBeenCalled()
  })

  it('returns the current selection ID for an owned candidate', async () => {
    const repository = selectionRepository(9)

    const response = await handleSelectVideoAssetRequest(request({
      runId,
      providerResourceId: 42,
      note: 'replacement',
    }, 'correct-token'), environment, () => repository)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ runId, providerResourceId: 42, selectionId: 9 })
    expect(repository.selectCandidate).toHaveBeenCalledWith({ runId, providerResourceId: 42, note: 'replacement' })
  })

  it('maps an owned-candidate P0002 to the exact candidate 404 contract', async () => {
    const rawDetails = 'candidate does not belong to run 9'
    const repository = createVideoAssetRepository({
      from: vi.fn(),
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { code: 'P0002', message: rawDetails, details: 'provider_resource_id=42' },
      }),
    })

    const response = await handleSelectVideoAssetRequest(request({
      runId,
      providerResourceId: 42,
      note: 'replacement',
    }, 'correct-token'), environment, () => repository)

    expect(response.status).toBe(404)
    const body = await response.text()
    expect(JSON.parse(body)).toEqual({
      error: { code: 'candidate_not_found', message: 'candidate not found' },
    })
    expect(body).not.toContain(rawDetails)
  })

  it.each([
    new Error('repository details must not escape'),
    new VideoAssetError(409, 'unexpected_repository_error', 'repository details must not escape'),
  ])('maps other repository failures to the exact stable 500 contract', async error => {
    const repository: Pick<VideoAssetRepository, 'selectCandidate'> = {
      selectCandidate: vi.fn().mockRejectedValue(error),
    }

    const response = await handleSelectVideoAssetRequest(request({
      runId,
      providerResourceId: 42,
      note: 'replacement',
    }, 'correct-token'), environment, () => repository)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'selection_failed', message: 'selection failed' },
    })
  })

  it('returns the existing 405 method contract', async () => {
    const createRepository = vi.fn(() => selectionRepository())

    const response = await handleSelectVideoAssetRequest(
      request({ runId, providerResourceId: 42, note: 'opening' }, 'correct-token', 'GET'),
      environment,
      createRepository,
    )

    expect(response.status).toBe(405)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'method_not_allowed', message: 'only POST is supported' },
    })
    expect(createRepository).not.toHaveBeenCalled()
  })
})
