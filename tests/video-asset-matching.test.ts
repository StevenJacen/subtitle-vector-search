import { describe, expect, it, vi } from 'vitest'
import {
  createVideoAssetRepository,
  type BeginRunInput,
  type FinishRunInput,
  type PersistedVideoAssetRun,
  type VideoAssetRepository,
} from '../supabase/functions/_shared/video-asset-repository.js'
import {
  matchVideoAssets,
  type VideoAssetMatchingDependencies,
} from '../supabase/functions/_shared/video-asset-matching.js'
import { fuseVecteezyLanes } from '../supabase/functions/_shared/weighted-rrf.js'
import type { VisualPlan } from '../supabase/functions/_shared/video-assets.js'
import type { VecteezySearchResource } from '../supabase/functions/_shared/vecteezy.js'

const runId = 'd62a53a1-08fb-4bee-a1ed-d8ba13de85f2'
const digest = 'a'.repeat(64)
const rawSource = 'PRIVATE dialogue that must not reach persistence'

const plan: VisualPlan = {
  visualIntent: {
    subject: 'solitary person',
    action: 'opening curtains',
    setting: 'quiet room at dawn',
    mood: 'renewed hope',
    lighting: 'soft sunrise',
    shot: 'medium cinematic shot',
  },
  queries: [
    { kind: 'literal', term: 'person opening curtains sunrise room video' },
    { kind: 'action', term: 'person stepping into morning light video' },
    { kind: 'metaphor', term: 'seedling after rain sunrise macro video' },
  ],
}

function resource(id: number, previewUrl = `https://preview.example/${id}.mp4`): VecteezySearchResource {
  return {
    stable: {
      providerResourceId: id,
      title: `Resource ${id}`,
      contentType: 'video',
      licenseType: 'commercial',
      aiGenerated: false,
      orientation: 'horizontal',
      tags: ['sunrise'],
      fileTypes: [{ extension: 'mp4', sizeInBytes: id * 100 }],
      downloadSizes: [{ id: String(id), width: 1920, height: 1080 }],
    },
    ephemeral: { previewUrl, thumbnailUrl: `https://thumbnail.example/${id}.jpg` },
  }
}

function persistedRun(overrides: Partial<PersistedVideoAssetRun> = {}): PersistedVideoAssetRun {
  return {
    runId,
    status: 'completed',
    planner: { model: 'gemma4:12b', promptVersion: 'visual-plan-v1', fallbackUsed: false },
    visualIntent: plan.visualIntent,
    queries: plan.queries.map(query => ({ ...query, status: 'completed' as const })),
    candidates: [1, 2].map(id => ({
      ...resource(id).stable,
      provider: 'vecteezy' as const,
      score: 0.01 / id,
      bestRank: id,
      matchedBy: ['literal' as const],
    })),
    ...overrides,
  }
}

function repository(overrides: Partial<VideoAssetRepository> = {}): VideoAssetRepository {
  return {
    loadChunkContext: vi.fn().mockResolvedValue(null),
    beginRun: vi.fn().mockResolvedValue({ runId, status: 'planning', isExisting: false }),
    loadRun: vi.fn().mockResolvedValue(persistedRun()),
    finishRun: vi.fn().mockResolvedValue(undefined),
    matchVisualConcept: vi.fn().mockResolvedValue(null),
    selectCandidate: vi.fn().mockResolvedValue({ selectionId: 1 }),
    ...overrides,
  }
}

function dependencies(
  repositoryValue: VideoAssetRepository,
  overrides: Partial<VideoAssetMatchingDependencies> = {},
): VideoAssetMatchingDependencies {
  let milliseconds = 100
  return {
    repository: repositoryValue,
    sha256: vi.fn().mockResolvedValue(digest.toUpperCase()),
    plan: vi.fn().mockResolvedValue({ plan, fallbackUsed: false }),
    search: vi.fn().mockImplementation(async (_term: string, kind) => ({
      resources: [resource(kind === 'literal' ? 1 : kind === 'action' ? 2 : 3)],
      totalResources: 1,
    })),
    detail: vi.fn().mockImplementation(async id => resource(id, `https://fresh.example/${id}.mp4`)),
    fuse: fuseVecteezyLanes,
    now: vi.fn(() => milliseconds += 10),
    ...overrides,
  }
}

describe('video asset matching orchestration', () => {
  it('completes a fresh three-lane run and persists only stable candidate data', async () => {
    const repo = repository()
    const deps = dependencies(repo)

    const result = await matchVideoAssets({ text: rawSource, theme: 'hope', candidateCount: 5 }, deps)

    expect(deps.sha256).toHaveBeenCalledWith(JSON.stringify({
      version: 1,
      promptVersion: 'visual-plan-v1',
      sourceKind: 'text',
      sourceText: rawSource,
      theme: 'hope',
      candidateCount: 5,
    }))
    expect(repo.beginRun).toHaveBeenCalledWith({
      inputKind: 'text',
      inputDigest: digest,
      theme: 'hope',
      candidateCount: 5,
      plannerModel: 'gemma4:12b',
      promptVersion: 'visual-plan-v1',
    })
    expect(deps.search).toHaveBeenCalledTimes(3)
    expect(deps.detail).toHaveBeenCalledTimes(3)
    expect(result.status).toBe('completed')
    expect(result.queries).toHaveLength(3)
    expect(result.queries.every(query => query.status === 'completed')).toBe(true)
    expect(result.candidates.map(candidate => candidate.previewUrl)).toEqual([
      'https://fresh.example/1.mp4',
      'https://fresh.example/2.mp4',
      'https://fresh.example/3.mp4',
    ])

    const finishInput = vi.mocked(repo.finishRun).mock.calls[0][0]
    expect(finishInput.status).toBe('completed')
    expect(finishInput.queries).toHaveLength(3)
    expect(JSON.stringify(finishInput)).not.toContain('preview.example')
    expect(JSON.stringify(finishInput)).not.toContain('fresh.example')
    expect(JSON.stringify(finishInput)).not.toContain('thumbnail.example')
    expect(JSON.stringify([vi.mocked(repo.beginRun).mock.calls, finishInput])).not.toContain(rawSource)
  })

  it('marks a fallback plan as degraded', async () => {
    const repo = repository()
    const deps = dependencies(repo, {
      plan: vi.fn().mockResolvedValue({ plan, fallbackUsed: true }),
    })

    const result = await matchVideoAssets({ text: 'English source', candidateCount: 5 }, deps)

    expect(result.status).toBe('degraded')
    expect(result.planner.fallbackUsed).toBe(true)
    expect(repo.finishRun).toHaveBeenCalledWith(expect.objectContaining({
      status: 'degraded',
      fallbackUsed: true,
    }))
  })

  it('keeps a fresh candidate but clears detail-owned metadata when detail fails', async () => {
    const repo = repository()
    const deps = dependencies(repo, {
      detail: vi.fn().mockRejectedValue(new Error('detail response leaked')),
    })

    const result = await matchVideoAssets({ text: 'English source', candidateCount: 5 }, deps)

    expect(result.status).toBe('completed')
    expect(result.candidates[0]).toEqual(expect.objectContaining({
      providerResourceId: 1,
      licenseType: null,
      orientation: null,
      fileTypes: [],
      downloadSizes: [],
      previewUrl: 'https://preview.example/1.mp4',
    }))
    expect(repo.finishRun).toHaveBeenCalledWith(expect.objectContaining({
      candidates: expect.arrayContaining([expect.objectContaining({
        providerResourceId: 1,
        licenseType: null,
        orientation: null,
        tags: [],
        fileTypes: [],
        downloadSizes: [],
      })]),
    }))
  })

  it('enriches retained candidates with at most four concurrent detail calls', async () => {
    let active = 0
    let maximumActive = 0
    const repo = repository()
    const deps = dependencies(repo, {
      search: vi.fn().mockResolvedValue({
        resources: Array.from({ length: 10 }, (_, index) => resource(index + 1)),
        totalResources: 10,
      }),
      detail: vi.fn().mockImplementation(async (id: number) => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise(resolve => setTimeout(resolve, 1))
        active -= 1
        return resource(id)
      }),
    })

    const result = await matchVideoAssets({ text: 'English source', candidateCount: 10 }, deps)

    expect(result.candidates).toHaveLength(10)
    expect(deps.detail).toHaveBeenCalledTimes(10)
    expect(maximumActive).toBeLessThanOrEqual(4)
  })

  it('persists one failed lane and returns a degraded run', async () => {
    const repo = repository()
    const search = vi.fn().mockImplementation(async (_term: string, kind: string) => {
      if (kind === 'metaphor') throw new Error('provider leaked a response body')
      return { resources: [resource(kind === 'literal' ? 1 : 2)], totalResources: 7 }
    })
    const deps = dependencies(repo, { search })

    const result = await matchVideoAssets({ text: 'English source', candidateCount: 5 }, deps)

    expect(result.status).toBe('degraded')
    expect(result.queries).toEqual([
      expect.objectContaining({ kind: 'literal', status: 'completed' }),
      expect.objectContaining({ kind: 'action', status: 'completed' }),
      expect.objectContaining({ kind: 'metaphor', status: 'failed', errorCode: 'provider_unavailable' }),
    ])
    expect(repo.finishRun).toHaveBeenCalledWith(expect.objectContaining({
      status: 'degraded',
      queries: expect.arrayContaining([
        expect.objectContaining({ kind: 'metaphor', status: 'failed', errorCode: 'provider_unavailable' }),
      ]),
    }))
  })

  it('finishes failed and throws a controlled 502 when two lanes fail', async () => {
    const repo = repository()
    const search = vi.fn().mockImplementation(async (_term: string, kind: string) => {
      if (kind !== 'literal') throw new Error(`provider leaked ${rawSource}`)
      return { resources: [resource(1)], totalResources: 1 }
    })
    const deps = dependencies(repo, { search })

    const promise = matchVideoAssets({ text: rawSource, candidateCount: 5 }, deps)

    await expect(promise).rejects.toMatchObject({
      status: 502,
      code: 'provider_unavailable',
      message: 'video provider unavailable',
    })
    await expect(promise).rejects.not.toThrow(rawSource)
    expect(repo.finishRun).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      failureCode: 'provider_unavailable',
      candidates: [],
      queries: expect.arrayContaining([
        expect.objectContaining({ kind: 'literal', status: 'completed' }),
        expect.objectContaining({ kind: 'action', status: 'failed' }),
        expect.objectContaining({ kind: 'metaphor', status: 'failed' }),
      ]),
    }))
  })

  it('reuses a completed run, skips planning and search, and refreshes persisted IDs only', async () => {
    const stored = persistedRun()
    const repo = repository({
      beginRun: vi.fn().mockResolvedValue({ runId, status: 'completed', isExisting: true }),
      loadRun: vi.fn().mockResolvedValue(stored),
    })
    const deps = dependencies(repo)

    const result = await matchVideoAssets({ subtitleChunkId: 42, candidateCount: 5 }, deps)

    expect(repo.loadChunkContext).not.toHaveBeenCalled()
    expect(deps.plan).not.toHaveBeenCalled()
    expect(deps.search).not.toHaveBeenCalled()
    expect(repo.finishRun).not.toHaveBeenCalled()
    expect(deps.detail).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deps.detail).mock.calls.map(call => call[0])).toEqual([1, 2])
    expect(result.status).toBe('completed')
    expect(result.candidates[0].previewUrl).toBe('https://fresh.example/1.mp4')
  })

  it('reuses a degraded chunk run without loading chunk context', async () => {
    const stored = persistedRun({
      status: 'degraded',
      planner: { model: 'gemma4:12b', promptVersion: 'visual-plan-v1', fallbackUsed: true },
      queries: [
        { ...plan.queries[0], status: 'completed' },
        { ...plan.queries[1], status: 'completed' },
        { ...plan.queries[2], status: 'failed' },
      ],
    })
    const repo = repository({
      beginRun: vi.fn().mockResolvedValue({ runId, status: 'degraded', isExisting: true }),
      loadRun: vi.fn().mockResolvedValue(stored),
    })
    const deps = dependencies(repo)

    const result = await matchVideoAssets({ subtitleChunkId: 42, candidateCount: 5 }, deps)

    expect(repo.loadChunkContext).not.toHaveBeenCalled()
    expect(deps.plan).not.toHaveBeenCalled()
    expect(deps.search).not.toHaveBeenCalled()
    expect(repo.finishRun).not.toHaveBeenCalled()
    expect(result.status).toBe('degraded')
    expect(result.queries[2]).toEqual({ ...plan.queries[2], status: 'failed', errorCode: 'provider_unavailable' })
  })

  it('throws a controlled 409 with retry metadata for an active run', async () => {
    const repo = repository({
      beginRun: vi.fn().mockResolvedValue({ runId, status: 'planning', isExisting: true }),
    })
    const deps = dependencies(repo)

    await expect(matchVideoAssets({ subtitleChunkId: 42, candidateCount: 5 }, deps)).rejects.toMatchObject({
      status: 409,
      code: 'run_in_progress',
      message: 'video asset search is in progress',
      retryAfterSeconds: 3,
    })
    expect(repo.loadChunkContext).not.toHaveBeenCalled()
    expect(repo.loadRun).not.toHaveBeenCalled()
    expect(deps.plan).not.toHaveBeenCalled()
    expect(deps.search).not.toHaveBeenCalled()
  })

  it('plans a ready chunk with one cue on each side and forbids its movie title', async () => {
    const repo = repository({
      loadChunkContext: vi.fn().mockResolvedValue({
        sourceText: 'The selected subtitle chunk.',
        contextText: 'Cue immediately before.\nCue immediately after.',
        movieTitle: 'Private Movie Title',
      }),
    })
    const deps = dependencies(repo)

    await matchVideoAssets({ subtitleChunkId: 42, theme: 'hope', candidateCount: 5 }, deps)

    expect(repo.loadChunkContext).toHaveBeenCalledWith(42)
    expect(vi.mocked(repo.beginRun).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(repo.loadChunkContext).mock.invocationCallOrder[0])
    expect(deps.plan).toHaveBeenCalledWith({
      sourceText: 'The selected subtitle chunk.',
      contextText: 'Cue immediately before.\nCue immediately after.',
      theme: 'hope',
      movieTitle: 'Private Movie Title',
      forbiddenTerms: ['Private Movie Title'],
    })
    expect(repo.beginRun).toHaveBeenCalledWith(expect.objectContaining({
      subtitleChunkId: 42,
      inputKind: 'chunk',
      inputDigest: digest,
    }))
  })

  it('finishes a fresh missing or non-ready chunk before rethrowing 404', async () => {
    const repo = repository({ loadChunkContext: vi.fn().mockResolvedValue(null) })
    const deps = dependencies(repo)

    await expect(matchVideoAssets({ subtitleChunkId: 404, candidateCount: 5 }, deps)).rejects.toMatchObject({
      status: 404,
      code: 'subtitle_chunk_not_ready',
      message: 'subtitle chunk is not available',
    })
    expect(repo.beginRun).toHaveBeenCalledOnce()
    expect(repo.loadChunkContext).toHaveBeenCalledWith(404)
    expect(vi.mocked(repo.beginRun).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(repo.loadChunkContext).mock.invocationCallOrder[0])
    expect(repo.finishRun).toHaveBeenCalledWith(expect.objectContaining({
      runId,
      status: 'failed',
      fallbackUsed: false,
      visualIntent: null,
      plannerElapsedMs: 0,
      failureCode: 'subtitle_chunk_not_ready',
      queries: expect.arrayContaining([
        expect.objectContaining({ kind: 'literal', status: 'failed' }),
        expect.objectContaining({ kind: 'action', status: 'failed' }),
        expect.objectContaining({ kind: 'metaphor', status: 'failed' }),
      ]),
      candidates: [],
    }))
    expect(deps.plan).not.toHaveBeenCalled()
  })

  it('maps only a beginRun chunk foreign-key error to controlled 404 without finishing', async () => {
    const rawDetails = 'insert on video_search_runs violates subtitle chunk foreign key'
    const client = {
      from: vi.fn(),
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { code: '23503', message: rawDetails, details: 'subtitle_chunk_id=404' },
      }),
    }
    const deps = dependencies(createVideoAssetRepository(client))

    const promise = matchVideoAssets({ subtitleChunkId: 404, candidateCount: 5 }, deps)

    await expect(promise).rejects.toMatchObject({
      status: 404,
      code: 'subtitle_chunk_not_ready',
      message: 'subtitle chunk is not available',
    })
    await expect(promise).rejects.not.toThrow(rawDetails)
    expect(client.from).not.toHaveBeenCalled()
    expect(client.rpc).toHaveBeenCalledTimes(1)
    expect(client.rpc).toHaveBeenCalledWith('begin_video_search_run', expect.any(Object))
  })

  it('finishes malformed fresh source context before rethrowing the fixed database error', async () => {
    const chunkQuery = query({ data: {
      track_id: 'malformed database value',
      text: 'Selected chunk',
      first_cue_index: 10,
      last_cue_index: 11,
    }, error: null })
    const rpc = vi.fn().mockImplementation(async (name: string) => name === 'begin_video_search_run'
      ? { data: [{ run_id: runId, status: 'planning', is_existing: false }], error: null }
      : { data: null, error: null })
    const deps = dependencies(createVideoAssetRepository({
      from: vi.fn(() => chunkQuery),
      rpc,
    }))

    const promise = matchVideoAssets({ subtitleChunkId: 42, candidateCount: 5 }, deps)

    await expect(promise).rejects.toStrictEqual(new Error('database operation failed'))
    const finishCall = rpc.mock.calls.find(call => call[0] === 'finish_video_search_run')
    expect(finishCall).toBeDefined()
    expect(finishCall?.[1]).toEqual(expect.objectContaining({
      p_run_id: runId,
      p_status: 'failed',
      p_fallback_used: false,
      p_visual_intent: null,
      p_planner_elapsed_ms: 0,
      p_failure_code: 'source_context_failed',
      p_candidates: [],
    }))
    expect(finishCall?.[1].p_queries).toHaveLength(3)
    expect(finishCall?.[1].p_queries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'literal', status: 'failed' }),
      expect.objectContaining({ kind: 'action', status: 'failed' }),
      expect.objectContaining({ kind: 'metaphor', status: 'failed' }),
    ]))
    expect(deps.plan).not.toHaveBeenCalled()
    expect(deps.search).not.toHaveBeenCalled()
  })

  it('finishes planner failures and suppresses planner details and source text', async () => {
    const repo = repository()
    const deps = dependencies(repo, {
      plan: vi.fn().mockRejectedValue(new Error(`planner leaked ${rawSource}`)),
    })

    const promise = matchVideoAssets({ text: rawSource, candidateCount: 5 }, deps)

    await expect(promise).rejects.toMatchObject({
      status: 502,
      code: 'planner_unavailable',
      message: 'visual planner unavailable',
    })
    await expect(promise).rejects.not.toThrow(rawSource)
    expect(repo.finishRun).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      failureCode: 'planner_unavailable',
      candidates: [],
      queries: expect.arrayContaining([
        expect.objectContaining({ kind: 'literal', status: 'failed' }),
        expect.objectContaining({ kind: 'action', status: 'failed' }),
        expect.objectContaining({ kind: 'metaphor', status: 'failed' }),
      ]),
    }))
    expect(JSON.stringify(vi.mocked(repo.finishRun).mock.calls)).not.toContain(rawSource)
  })
})

interface QueryResult {
  data: unknown
  error: unknown
}

function query(result: QueryResult) {
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'gte', 'lte', 'order']) {
    builder[method] = vi.fn(() => builder)
  }
  builder.single = vi.fn(async () => result)
  builder.maybeSingle = vi.fn(async () => result)
  builder.then = (resolve: (value: QueryResult) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject)
  return builder
}

function rejectingQuery(error: Error) {
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'order']) {
    builder[method] = vi.fn(() => builder)
  }
  builder.single = vi.fn(async () => await Promise.reject(error))
  builder.then = (resolve: (value: QueryResult) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.reject(error).then(resolve, reject)
  return builder
}

describe('video asset repository', () => {
  it('hydrates a ready chunk and keeps only one adjacent cue on each side', async () => {
    const chunkQuery = query({ data: {
      track_id: 7,
      text: 'Selected chunk',
      first_cue_index: 10,
      last_cue_index: 11,
    }, error: null })
    const trackQuery = query({ data: { status: 'ready', movies: { title: 'Movie Title' } }, error: null })
    const cueQuery = query({ data: [
      { cue_index: 9, text: 'Before' },
      { cue_index: 10, text: 'Inside one' },
      { cue_index: 11, text: 'Inside two' },
      { cue_index: 12, text: 'After' },
    ], error: null })
    const client = {
      from: vi.fn((table: string) => ({
        subtitle_chunks: chunkQuery,
        subtitle_tracks: trackQuery,
        subtitle_cues: cueQuery,
      })[table]),
      rpc: vi.fn(),
    }

    const repo = createVideoAssetRepository(client)

    await expect(repo.loadChunkContext(99)).resolves.toEqual({
      sourceText: 'Selected chunk',
      contextText: 'Before\nAfter',
      movieTitle: 'Movie Title',
    })
    expect(client.from).toHaveBeenCalledWith('subtitle_chunks')
    expect(client.from).toHaveBeenCalledWith('subtitle_tracks')
    expect(client.from).toHaveBeenCalledWith('subtitle_cues')
  })

  it('maps lifecycle, concept, and selection RPCs from camelCase to snake_case', async () => {
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'begin_video_search_run') {
        return { data: [{ run_id: runId, status: 'planning', is_existing: false }], error: null }
      }
      if (name === 'match_visual_concept') {
        return { data: [{
          concept_key: 'hope',
          description: 'Hopeful scene.',
          literal_query: 'literal video',
          action_query: 'action video',
          metaphor_query: 'metaphor video',
          similarity: 0.9,
        }], error: null }
      }
      if (name === 'select_video_asset') {
        return { data: [{ selection_id: 77 }], error: null }
      }
      return { data: null, error: null }
    })
    const repo = createVideoAssetRepository({ from: vi.fn(), rpc })
    const beginInput: BeginRunInput = {
      subtitleChunkId: 42,
      inputKind: 'chunk',
      inputDigest: digest,
      theme: 'hope',
      candidateCount: 5,
      plannerModel: 'gemma4:12b',
      promptVersion: 'visual-plan-v1',
    }
    const finishInput: FinishRunInput = {
      runId,
      status: 'degraded',
      fallbackUsed: false,
      visualIntent: plan.visualIntent,
      plannerElapsedMs: 20,
      totalElapsedMs: 40,
      failureCode: null,
      queries: plan.queries.map((item, index) => ({
        ...item,
        weight: index === 2 ? 0.2 : 0.4,
        filters: { contentType: 'video' as const },
        providerTotal: 2,
        status: index === 2 ? 'failed' as const : 'completed' as const,
        elapsedMs: 10,
      })),
      candidates: [{
        ...resource(1).stable,
        provider: 'vecteezy',
        score: 0.01,
        bestRank: 1,
        matchedBy: ['literal'],
      }],
    }

    await expect(repo.beginRun(beginInput)).resolves.toEqual({ runId, status: 'planning', isExisting: false })
    await expect(repo.finishRun(finishInput)).resolves.toBeUndefined()
    await expect(repo.matchVisualConcept([0.1, 0.2])).resolves.toEqual({
      conceptKey: 'hope',
      description: 'Hopeful scene.',
      literalQuery: 'literal video',
      actionQuery: 'action video',
      metaphorQuery: 'metaphor video',
      similarity: 0.9,
    })
    await expect(repo.selectCandidate({ runId, providerResourceId: 1, note: 'chosen' })).resolves.toEqual({
      selectionId: 77,
    })

    expect(rpc).toHaveBeenCalledWith('begin_video_search_run', {
      p_subtitle_chunk_id: 42,
      p_input_kind: 'chunk',
      p_input_digest: digest,
      p_theme: 'hope',
      p_candidate_count: 5,
      p_planner_model: 'gemma4:12b',
      p_prompt_version: 'visual-plan-v1',
    })
    expect(rpc).toHaveBeenCalledWith('finish_video_search_run', expect.objectContaining({
      p_run_id: runId,
      p_status: 'degraded',
      p_fallback_used: false,
      p_visual_intent: plan.visualIntent,
      p_planner_elapsed_ms: 20,
      p_total_elapsed_ms: 40,
      p_failure_code: null,
      p_queries: expect.arrayContaining([expect.objectContaining({ provider_total: 2, elapsed_ms: 10 })]),
      p_candidates: expect.arrayContaining([expect.objectContaining({
        provider_resource_id: 1,
        content_type: 'video',
        fused_score: 0.01,
        best_rank: 1,
        matched_query_kinds: ['literal'],
      })]),
    }))
    expect(rpc).toHaveBeenCalledWith('match_visual_concept', { query_embedding: [0.1, 0.2] })
    expect(rpc).toHaveBeenCalledWith('select_video_asset', {
      p_run_id: runId,
      p_provider_resource_id: 1,
      p_note: 'chosen',
    })
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('preview.example')
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('thumbnail.example')
  })

  it('returns the RPC selection ID so a replacement keeps the current selection row', async () => {
    const repo = createVideoAssetRepository({
      from: vi.fn(),
      rpc: vi.fn().mockResolvedValue({ data: [{ selection_id: 9 }], error: null }),
    })

    await expect(repo.selectCandidate({ runId, providerResourceId: 42, note: 'replacement' }))
      .resolves.toEqual({ selectionId: 9 })
  })

  it('maps only the selection ownership SQLSTATE to a controlled candidate 404', async () => {
    const rawDetails = 'candidate does not belong to run 9'
    const repo = createVideoAssetRepository({
      from: vi.fn(),
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { code: 'P0002', message: rawDetails, details: 'provider_resource_id=42' },
      }),
    })

    const promise = repo.selectCandidate({ runId, providerResourceId: 42, note: 'replacement' })

    await expect(promise).rejects.toMatchObject({
      status: 404,
      code: 'candidate_not_found',
      message: 'candidate not found',
    })
    await expect(promise).rejects.not.toThrow(rawDetails)
  })

  it('hydrates persisted run rows and derives controlled failed-lane codes', async () => {
    const runQuery = query({ data: {
      id: runId,
      status: 'degraded',
      planner_model: 'gemma4:12b',
      prompt_version: 'visual-plan-v1',
      fallback_used: false,
      visual_intent: plan.visualIntent,
    }, error: null })
    const queriesQuery = query({ data: [
      { kind: 'literal', term: plan.queries[0].term, status: 'completed' },
      { kind: 'action', term: plan.queries[1].term, status: 'completed' },
      { kind: 'metaphor', term: plan.queries[2].term, status: 'failed' },
    ], error: null })
    const candidatesQuery = query({ data: [{
      provider: 'vecteezy',
      provider_resource_id: 1,
      title: 'Resource 1',
      content_type: 'video',
      license_type: 'commercial',
      ai_generated: false,
      orientation: 'horizontal',
      tags: ['sunrise'],
      file_types: [{ extension: 'mp4', sizeInBytes: 100 }],
      download_sizes: [{ id: '1', width: 1920, height: 1080 }],
      fused_score: 0.01,
      best_rank: 1,
      matched_query_kinds: ['literal'],
    }], error: null })
    const client = {
      from: vi.fn((table: string) => ({
        video_search_runs: runQuery,
        video_search_queries: queriesQuery,
        video_search_candidates: candidatesQuery,
      })[table]),
      rpc: vi.fn(),
    }

    await expect(createVideoAssetRepository(client).loadRun(runId)).resolves.toEqual({
      runId,
      status: 'degraded',
      planner: { model: 'gemma4:12b', promptVersion: 'visual-plan-v1', fallbackUsed: false },
      visualIntent: plan.visualIntent,
      queries: [
        { ...plan.queries[0], status: 'completed' },
        { ...plan.queries[1], status: 'completed' },
        { ...plan.queries[2], status: 'failed' },
      ],
      candidates: [{
        provider: 'vecteezy',
        providerResourceId: 1,
        title: 'Resource 1',
        contentType: 'video',
        licenseType: 'commercial',
        aiGenerated: false,
        orientation: 'horizontal',
        tags: ['sunrise'],
        fileTypes: [{ extension: 'mp4', sizeInBytes: 100 }],
        downloadSizes: [{ id: '1', width: 1920, height: 1080 }],
        score: 0.01,
        bestRank: 1,
        matchedBy: ['literal'],
      }],
    })
  })

  it('suppresses every raw PostgREST error', async () => {
    const secret = 'raw database policy details'
    const client = {
      from: vi.fn(() => query({ data: null, error: new Error(secret) })),
      rpc: vi.fn().mockResolvedValue({ data: null, error: new Error(secret) }),
    }
    const repo = createVideoAssetRepository(client)

    await expect(repo.loadChunkContext(1)).rejects.toThrow('database operation failed')
    await expect(repo.loadChunkContext(1)).rejects.not.toThrow(secret)
    await expect(repo.beginRun({
      inputKind: 'text',
      inputDigest: digest,
      candidateCount: 5,
      plannerModel: 'gemma4:12b',
      promptVersion: 'visual-plan-v1',
    })).rejects.toThrow('database operation failed')
    await expect(repo.beginRun({
      inputKind: 'text',
      inputDigest: digest,
      candidateCount: 5,
      plannerModel: 'gemma4:12b',
      promptVersion: 'visual-plan-v1',
    })).rejects.not.toThrow(secret)
  })

  it('suppresses a rejected beginRun RPC promise', async () => {
    const repo = createVideoAssetRepository({
      from: vi.fn(),
      rpc: vi.fn().mockRejectedValue(new Error('rejected begin details')),
    })

    const promise = repo.beginRun({
      inputKind: 'text',
      inputDigest: digest,
      candidateCount: 5,
      plannerModel: 'gemma4:12b',
      promptVersion: 'visual-plan-v1',
    })

    await expect(promise).rejects.toStrictEqual(new Error('database operation failed'))
    await expect(promise).rejects.not.toThrow('rejected begin details')
  })

  it('suppresses a rejected finishRun RPC promise', async () => {
    const repo = createVideoAssetRepository({
      from: vi.fn(),
      rpc: vi.fn().mockRejectedValue(new Error('rejected finish details')),
    })

    const promise = repo.finishRun({
      runId,
      status: 'failed',
      fallbackUsed: false,
      visualIntent: null,
      plannerElapsedMs: 0,
      totalElapsedMs: 0,
      failureCode: 'planner_unavailable',
      queries: plan.queries.map((query, index) => ({
        ...query,
        weight: index === 2 ? 0.2 : 0.4,
        filters: { contentType: 'video' },
        providerTotal: null,
        status: 'failed',
        elapsedMs: 0,
      })),
      candidates: [],
    })

    await expect(promise).rejects.toStrictEqual(new Error('database operation failed'))
    await expect(promise).rejects.not.toThrow('rejected finish details')
  })

  it('suppresses a rejected matchVisualConcept RPC promise', async () => {
    const repo = createVideoAssetRepository({
      from: vi.fn(),
      rpc: vi.fn().mockRejectedValue(new Error('rejected concept details')),
    })

    const promise = repo.matchVisualConcept([0.1, 0.2])

    await expect(promise).rejects.toStrictEqual(new Error('database operation failed'))
    await expect(promise).rejects.not.toThrow('rejected concept details')
  })

  it('suppresses a rejected selectCandidate RPC promise', async () => {
    const repo = createVideoAssetRepository({
      from: vi.fn(),
      rpc: vi.fn().mockRejectedValue(new Error('rejected selection details')),
    })

    const promise = repo.selectCandidate({ runId, providerResourceId: 1, note: 'chosen' })

    await expect(promise).rejects.toStrictEqual(new Error('database operation failed'))
    await expect(promise).rejects.not.toThrow('rejected selection details')
  })

  it('suppresses rejected PostgREST hydration promises', async () => {
    const secret = 'rejected database transport details'
    const client = {
      from: vi.fn(() => rejectingQuery(new Error(secret))),
      rpc: vi.fn(),
    }

    const promise = createVideoAssetRepository(client).loadRun(runId)

    await expect(promise).rejects.toThrow('database operation failed')
    await expect(promise).rejects.not.toThrow(secret)
  })
})
