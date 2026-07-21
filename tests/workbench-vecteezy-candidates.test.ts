import { describe, expect, it, vi } from 'vitest'
import {
  PreviewRegistry,
  VecteezyCandidateAdapter,
} from '../src/workbench/vecteezy-candidates.js'
import type { VideoProductionApi } from '../src/video-production-api.js'
import {
  parseVideoAssetRequest,
  type VideoAssetMatchResponse,
} from '../supabase/functions/_shared/video-assets.js'

const run1 = '11111111-1111-4111-8111-111111111111'
const run2 = '22222222-2222-4222-8222-222222222222'

function response(runId = run1, page = 1): VideoAssetMatchResponse {
  return {
    runId,
    status: 'completed',
    planner: { model: 'planner', promptVersion: 'v1', fallbackUsed: false },
    visualIntent: {
      subject: 'person', action: 'walking', setting: 'road', mood: 'hopeful',
      lighting: 'morning', shot: 'wide',
    },
    queries: [
      { kind: 'literal', term: 'person walking road', status: 'completed' },
      { kind: 'action', term: 'walking toward sunrise', status: 'completed' },
      { kind: 'metaphor', term: 'open road sunrise', status: 'completed' },
    ],
    candidates: Array.from({ length: 8 }, (_, index) => ({
      provider: 'vecteezy' as const,
      providerResourceId: page * 100 + index,
      title: `Resource ${index}`,
      licenseType: index === 1 ? 'editorial' : 'commercial',
      aiGenerated: index === 2,
      orientation: index === 3 ? 'portrait' : 'landscape',
      fileTypes: index === 4 ? [{ extension: 'webm', sizeInBytes: 100 }] : [{ extension: 'mp4', sizeInBytes: 100 }],
      downloadSizes: [{ id: 'hd', width: 1920, height: 1080 }],
      score: index === 7 ? 0.02 : 0.01,
      bestRank: index + 1,
      matchedBy: ['literal' as const],
      previewUrl: `https://media.vecteezy.com/${runId}/${index}.mp4`,
    })),
    page,
    hasNextPage: page < 3,
  }
}

describe('local Vecteezy candidate adapter', () => {
  it('requests eight candidates by page and chains later pages to the source run', async () => {
    const matchScene = vi.fn()
      .mockResolvedValueOnce(response(run1, 1))
      .mockResolvedValueOnce(response(run2, 2))
    const api = { matchScene, selectCandidate: vi.fn() } as unknown as VideoProductionApi
    const adapter = new VecteezyCandidateAdapter(api, new PreviewRegistry())

    await adapter.loadPage({ theme: 'hope', aspectRatio: '16:9', page: 1 })
    await adapter.loadPage({ theme: 'hope', aspectRatio: '16:9', page: 2, sourceRunId: run1 })

    expect(matchScene).toHaveBeenNthCalledWith(1, { theme: 'hope', candidateCount: 8, page: 1 })
    expect(matchScene).toHaveBeenNthCalledWith(2, {
      theme: 'hope', candidateCount: 8, page: 2, sourceRunId: run1,
    })
  })

  it('keeps raw preview URLs only in the registry and returns UUID preview IDs', async () => {
    let nextId = 0
    const registry = new PreviewRegistry({
      createId: () => `${String(++nextId).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    })
    const api = { matchScene: vi.fn().mockResolvedValue(response()), selectCandidate: vi.fn() } as unknown as VideoProductionApi
    const adapter = new VecteezyCandidateAdapter(api, registry)

    const result = await adapter.loadPage({ theme: 'hope', aspectRatio: '16:9', page: 1 })

    expect(result.candidates).toHaveLength(8)
    expect(result.candidates[0].previewId).toBe('00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(JSON.stringify(result)).not.toContain('media.vecteezy.com')
    expect(registry.resolve('00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
      .toBe(`https://media.vecteezy.com/${run1}/0.mp4`)
  })

  it.each([
    'http://media.vecteezy.com/preview.mp4',
    'https://vecteezy.com.example.test/preview.mp4',
    'https://example.test/preview.mp4',
    'https://localhost/preview.mp4',
    'https://127.0.0.1/preview.mp4',
    'https://user:secret@media.vecteezy.com/preview.mp4',
    'https://media.vecteezy.com:8443/preview.mp4',
  ])('rejects unsafe default preview URL %s', url => {
    const registry = new PreviewRegistry()
    expect(() => registry.register(url)).toThrowError(expect.objectContaining({ code: 'preview_url_forbidden' }))
  })

  it('supports an injected URL policy and retries UUID collisions without reusing an old URL', () => {
    const ids = [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]
    const registry = new PreviewRegistry({
      createId: () => ids.shift() as string,
      allowUrl: url => url.hostname === 'preview.test',
    })

    const first = registry.register('https://preview.test/first.mp4')
    const second = registry.register('https://preview.test/second.mp4')

    expect(first).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(second).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    expect(registry.resolve(first as string)).toBe('https://preview.test/first.mp4')
    expect(registry.resolve(second as string)).toBe('https://preview.test/second.mp4')
  })

  it('fails predictably after limited UUID collision retries', () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const registry = new PreviewRegistry({ createId: () => id, allowUrl: () => true })
    registry.register('https://preview.test/first.mp4')

    expect(() => registry.register('https://preview.test/second.mp4'))
      .toThrowError(expect.objectContaining({ code: 'preview_id_collision' }))
    expect(registry.resolve(id)).toBe('https://preview.test/first.mp4')
  })

  it('ranks recommendations deterministically from provider and media suitability', async () => {
    const payload = response()
    payload.candidates[0] = { ...payload.candidates[0], score: 0.05, bestRank: 8 }
    payload.candidates[1] = { ...payload.candidates[1], score: 0.05, bestRank: 1, licenseType: 'editorial' }
    payload.candidates[3] = { ...payload.candidates[3], score: 0.05 }
    const api = { matchScene: vi.fn().mockResolvedValue(payload), selectCandidate: vi.fn() } as unknown as VideoProductionApi
    const adapter = new VecteezyCandidateAdapter(api, new PreviewRegistry())

    const landscape = await adapter.loadPage({ theme: 'hope', aspectRatio: '16:9', page: 1 })
    const portrait = await adapter.loadPage({ theme: 'hope', aspectRatio: '9:16', page: 1 })

    expect(landscape.recommended).toEqual({ runId: run1, resourceId: 100 })
    expect(portrait.recommended).toEqual({ runId: run1, resourceId: 103 })
    expect(landscape.candidates.map(item => item.resourceId)).toEqual([100, 101, 102, 103, 104, 105, 106, 107])
  })

  it('keeps provider relevance dominant and grants licenses only by exact normalized value', async () => {
    const payload = response()
    payload.candidates[0] = {
      ...payload.candidates[0], score: 0.050001, orientation: 'portrait',
      fileTypes: [{ extension: 'webm', sizeInBytes: 100 }], licenseType: 'non-commercial',
      aiGenerated: true, bestRank: 8,
    }
    payload.candidates[1] = {
      ...payload.candidates[1], score: 0.05, orientation: 'landscape',
      fileTypes: [{ extension: 'mp4', sizeInBytes: 100 }], licenseType: ' COMMERCIAL ',
      aiGenerated: false, bestRank: 1,
    }
    const api = { matchScene: vi.fn().mockResolvedValue(payload), selectCandidate: vi.fn() } as unknown as VideoProductionApi
    const adapter = new VecteezyCandidateAdapter(api, new PreviewRegistry())

    const result = await adapter.loadPage({ theme: 'hope', aspectRatio: '16:9', page: 1 })

    expect(result.recommended).toEqual({ runId: run1, resourceId: 100 })
    expect(result.candidates[0].suitabilityScore).toBeLessThan(result.candidates[1].suitabilityScore)
  })

  it('accepts one to eight candidates only on later pages', async () => {
    const one = response(run2, 2)
    one.candidates = one.candidates.slice(0, 1)
    const api = { matchScene: vi.fn().mockResolvedValue(one), selectCandidate: vi.fn() } as unknown as VideoProductionApi
    const adapter = new VecteezyCandidateAdapter(api, new PreviewRegistry())

    await expect(adapter.loadPage({ theme: 'hope', aspectRatio: '16:9', page: 2, sourceRunId: run1 }))
      .resolves.toEqual(expect.objectContaining({ candidates: expect.any(Array) }))

    const empty = { ...one, candidates: [] }
    const emptyAdapter = new VecteezyCandidateAdapter(
      { matchScene: vi.fn().mockResolvedValue(empty), selectCandidate: vi.fn() } as unknown as VideoProductionApi,
      new PreviewRegistry(),
    )
    await expect(emptyAdapter.loadPage({ theme: 'hope', aspectRatio: '16:9', page: 2, sourceRunId: run1 }))
      .rejects.toThrow('invalid paged candidate response')
  })

  it('selects with the candidate owning run rather than the first page run', async () => {
    const selectCandidate = vi.fn().mockResolvedValue({ selectionId: 9 })
    const api = { matchScene: vi.fn(), selectCandidate } as unknown as VideoProductionApi
    const adapter = new VecteezyCandidateAdapter(api, new PreviewRegistry())
    const laterCandidate = {
      provider: 'vecteezy' as const, resourceId: 208, runId: run2, page: 2,
      title: null, previewId: null, orientation: null, licenseType: null,
      aiGenerated: null, score: 0, suitabilityScore: 0, providerRank: 1,
    }

    await expect(adapter.select(laterCandidate, 'scene 2')).resolves.toEqual({ selectionId: 9 })
    expect(selectCandidate).toHaveBeenCalledWith({ runId: run2, providerResourceId: 208, note: 'scene 2' })
  })
})

describe('workbench candidate request contract', () => {
  it('accepts explicit first and later pages while retaining the legacy default', () => {
    expect(parseVideoAssetRequest({ theme: 'hope' })).toEqual({ theme: 'hope', candidateCount: 8 })
    expect(parseVideoAssetRequest({ theme: 'hope', candidateCount: 8, page: 1 })).toEqual({
      theme: 'hope', candidateCount: 8, page: 1,
    })
    expect(parseVideoAssetRequest({
      theme: 'hope', candidateCount: 8, page: 100, sourceRunId: run1,
    })).toEqual({ theme: 'hope', candidateCount: 8, page: 100, sourceRunId: run1 })
  })

  it.each([
    { theme: 'hope', candidateCount: 8, page: 0 },
    { theme: 'hope', candidateCount: 8, page: 101 },
    { theme: 'hope', candidateCount: 8, page: 1.5 },
    { theme: 'hope', candidateCount: 7, page: 1 },
    { theme: 'hope', candidateCount: 8, page: 2 },
    { candidateCount: 8, page: 2, sourceRunId: run1 },
    { theme: 'hope', candidateCount: 8, sourceRunId: run1 },
    { theme: 'hope', candidateCount: 8, page: 1, sourceRunId: run1 },
    { text: 'new source', candidateCount: 8, page: 2, sourceRunId: run1 },
    { theme: 'hope', candidateCount: 8, page: 2, sourceRunId: 'not-a-uuid' },
  ])('rejects invalid pagination ownership %#', value => {
    expect(() => parseVideoAssetRequest(value)).toThrow('invalid request')
  })
})
