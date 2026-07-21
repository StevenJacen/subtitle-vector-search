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
      previewUrl: `https://preview.example/${runId}/${index}.mp4`,
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
    const registry = new PreviewRegistry(() => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    const api = { matchScene: vi.fn().mockResolvedValue(response()), selectCandidate: vi.fn() } as unknown as VideoProductionApi
    const adapter = new VecteezyCandidateAdapter(api, registry)

    const result = await adapter.loadPage({ theme: 'hope', aspectRatio: '16:9', page: 1 })

    expect(result.candidates).toHaveLength(8)
    expect(result.candidates[0].previewId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(JSON.stringify(result)).not.toContain('preview.example')
    expect(registry.resolve('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
      .toBe(`https://preview.example/${run1}/0.mp4`)
  })

  it('ranks recommendations deterministically from provider and media suitability', async () => {
    const payload = response()
    payload.candidates[0] = { ...payload.candidates[0], score: 0.05, bestRank: 8 }
    payload.candidates[1] = { ...payload.candidates[1], score: 0.05, bestRank: 1, licenseType: 'editorial' }
    const api = { matchScene: vi.fn().mockResolvedValue(payload), selectCandidate: vi.fn() } as unknown as VideoProductionApi
    const adapter = new VecteezyCandidateAdapter(api, new PreviewRegistry())

    const landscape = await adapter.loadPage({ theme: 'hope', aspectRatio: '16:9', page: 1 })
    const portrait = await adapter.loadPage({ theme: 'hope', aspectRatio: '9:16', page: 1 })

    expect(landscape.recommended).toEqual({ runId: run1, resourceId: 100 })
    expect(portrait.recommended).toEqual({ runId: run1, resourceId: 103 })
    expect(landscape.candidates.map(item => item.resourceId)).toEqual([100, 101, 102, 103, 104, 105, 106, 107])
  })

  it('selects with the candidate owning run rather than the first page run', async () => {
    const selectCandidate = vi.fn().mockResolvedValue({ selectionId: 9 })
    const api = { matchScene: vi.fn(), selectCandidate } as unknown as VideoProductionApi
    const adapter = new VecteezyCandidateAdapter(api, new PreviewRegistry())
    const laterCandidate = {
      provider: 'vecteezy' as const, resourceId: 208, runId: run2, page: 2,
      title: null, previewId: null, orientation: null, licenseType: null,
      aiGenerated: null, score: 0,
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
    { theme: 'hope', candidateCount: 8, sourceRunId: run1 },
    { theme: 'hope', candidateCount: 8, page: 1, sourceRunId: run1 },
    { text: 'new source', candidateCount: 8, page: 2, sourceRunId: run1 },
    { theme: 'hope', candidateCount: 8, page: 2, sourceRunId: 'not-a-uuid' },
  ])('rejects invalid pagination ownership %#', value => {
    expect(() => parseVideoAssetRequest(value)).toThrow('invalid request')
  })
})
