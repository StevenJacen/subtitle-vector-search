import {
  VideoAssetError,
  type QueryKind,
  type VideoAssetCandidate,
  type VideoAssetMatchResponse,
  type VideoAssetRequest,
  type VisualPlan,
} from './video-assets.ts'
import type { VisualPlannerInput } from './video-planner.ts'
import type {
  FinishRunCandidate,
  FinishRunQuery,
  PersistedVideoAssetCandidate,
  PersistedVideoAssetRun,
  VideoAssetRepository,
} from './video-asset-repository.ts'
import type { FusedCandidate, VecteezyLane } from './weighted-rrf.ts'
import type { VecteezySearchResource } from './vecteezy.ts'

const PLANNER_MODEL = 'gemma4:12b'
const PROMPT_VERSION = 'visual-plan-v1'
const RETRY_AFTER_SECONDS = 3
const QUERY_FILTERS = {
  contentType: 'video',
  licenseType: 'commercial',
  duration: '3_15',
  familyFriendly: true,
  perPage: 10,
} as const
const LANE_DEFINITIONS: Array<{ kind: QueryKind; weight: number }> = [
  { kind: 'literal', weight: 0.4 },
  { kind: 'action', weight: 0.4 },
  { kind: 'metaphor', weight: 0.2 },
]

interface ProviderSearchResult {
  resources: VecteezySearchResource[]
  totalResources: number | null
}

export interface VideoAssetMatchingDependencies {
  repository: VideoAssetRepository
  sha256(value: string): Promise<string>
  plan(input: VisualPlannerInput): Promise<{ plan: VisualPlan; fallbackUsed: boolean }>
  search(term: string, kind: QueryKind, page?: number): Promise<ProviderSearchResult>
  detail(providerResourceId: number): Promise<VecteezySearchResource>
  fuse(lanes: VecteezyLane[], candidateCount: number): FusedCandidate[]
  now(): number
}

export async function matchVideoAssets(
  request: VideoAssetRequest,
  dependencies: VideoAssetMatchingDependencies,
): Promise<VideoAssetMatchResponse> {
  const inputKind = request.subtitleChunkId !== undefined
    ? 'chunk'
    : request.text !== undefined ? 'text' : 'theme'
  const inputDigest = await requestDigest(request, inputKind, dependencies.sha256)
  const begin = await dependencies.repository.beginRun({
    ...(request.subtitleChunkId === undefined ? {} : { subtitleChunkId: request.subtitleChunkId }),
    inputKind,
    inputDigest,
    ...(request.theme === undefined ? {} : { theme: request.theme }),
    candidateCount: request.candidateCount,
    plannerModel: PLANNER_MODEL,
    promptVersion: PROMPT_VERSION,
  })

  if (begin.isExisting) {
    if (begin.status === 'planning') {
      throw Object.assign(
        new VideoAssetError(409, 'run_in_progress', 'video asset search is in progress'),
        { retryAfterSeconds: RETRY_AFTER_SECONDS },
      )
    }
    if (begin.status === 'completed' || begin.status === 'degraded') {
      const persisted = await dependencies.repository.loadRun(begin.runId)
      const refreshed = await refreshPersistedRun(persisted, dependencies)
      return withPagination(
        refreshed,
        request,
        persistedHasNextPage(persisted, request.page),
      )
    }
  }

  const totalStartedAt = dependencies.now()
  let planned: { plan: VisualPlan; fallbackUsed: boolean }
  let plannerElapsedMs = 0
  if (request.sourceRunId !== undefined) {
    try {
      const sourceRun = await dependencies.repository.loadRun(request.sourceRunId)
      if (!isExplicitRootRun(sourceRun, request.theme)) {
        throw new Error('invalid source run')
      }
      planned = {
        plan: {
          visualIntent: sourceRun.visualIntent,
          queries: sourceRun.queries.map(query => ({ kind: query.kind, term: query.term })),
        },
        fallbackUsed: sourceRun.planner.fallbackUsed,
      }
    } catch {
      await dependencies.repository.finishRun({
        runId: begin.runId,
        status: 'failed',
        fallbackUsed: false,
        visualIntent: null,
        plannerElapsedMs: 0,
        totalElapsedMs: elapsed(dependencies, totalStartedAt),
        failureCode: 'source_run_unavailable',
        queries: failedQueries('source_run_unavailable', 'source run unavailable', 0, request.page),
        candidates: [],
      })
      throw new VideoAssetError(422, 'source_run_unavailable', 'source video search run is unavailable')
    }
  } else {
    let source: VisualPlannerInput
    try {
      source = await planningSource(request, dependencies.repository)
    } catch (error) {
      const missingChunk = error instanceof VideoAssetError && error.code === 'subtitle_chunk_not_ready'
      const failureCode = missingChunk ? error.code : 'source_context_failed'
      const controlled = missingChunk ? error : new Error('database operation failed')
      await dependencies.repository.finishRun({
        runId: begin.runId,
        status: 'failed',
        fallbackUsed: false,
        visualIntent: null,
        plannerElapsedMs: 0,
        totalElapsedMs: elapsed(dependencies, totalStartedAt),
        failureCode,
        queries: failedQueries(
          failureCode,
          missingChunk ? 'subtitle chunk unavailable' : 'source context unavailable',
          0,
          request.page,
        ),
        candidates: [],
      })
      throw controlled
    }
    const plannerStartedAt = dependencies.now()
    try {
      planned = await dependencies.plan(source)
    } catch (error) {
      const controlled = plannerError(error)
      plannerElapsedMs = elapsed(dependencies, plannerStartedAt)
      await dependencies.repository.finishRun({
        runId: begin.runId,
        status: 'failed',
        fallbackUsed: false,
        visualIntent: null,
        plannerElapsedMs,
        totalElapsedMs: elapsed(dependencies, totalStartedAt),
        failureCode: controlled.code,
        queries: failedQueries(controlled.code, 'planner unavailable', plannerElapsedMs, request.page),
        candidates: [],
      })
      throw controlled
    }
    plannerElapsedMs = elapsed(dependencies, plannerStartedAt)
  }

  const laneResults = await Promise.allSettled(LANE_DEFINITIONS.map(async lane => {
    const query = requiredQuery(planned.plan, lane.kind)
    const startedAt = dependencies.now()
    try {
      return {
        lane,
        query,
        result: request.page === undefined
          ? await dependencies.search(query.term, lane.kind)
          : await dependencies.search(query.term, lane.kind, request.page),
        elapsedMs: elapsed(dependencies, startedAt),
      }
    } catch {
      throw new LaneFailure(elapsed(dependencies, startedAt))
    }
  }))

  const queryRows = laneResults.map((result, index): FinishRunQuery => {
    const lane = LANE_DEFINITIONS[index]
    const query = requiredQuery(planned.plan, lane.kind)
    if (result.status === 'fulfilled') {
      return {
        ...query,
        weight: lane.weight,
        filters: queryFilters(
          request.page,
          providerHasNextPage(result.value.result, request.page),
        ),
        providerTotal: result.value.result.totalResources,
        status: 'completed',
        elapsedMs: result.value.elapsedMs,
      }
    }
    return {
      ...query,
      weight: lane.weight,
      filters: queryFilters(request.page, false),
      providerTotal: null,
      status: 'failed',
      elapsedMs: result.reason instanceof LaneFailure ? result.reason.elapsedMs : 0,
      errorCode: 'provider_unavailable',
    }
  })
  const successfulLanes = laneResults.flatMap(result => result.status === 'fulfilled'
    ? [{
        kind: result.value.lane.kind,
        weight: result.value.lane.weight,
        resources: result.value.result.resources,
      }]
    : [])

  if (successfulLanes.length < 2) {
    await dependencies.repository.finishRun({
      runId: begin.runId,
      status: 'failed',
      fallbackUsed: planned.fallbackUsed,
      visualIntent: planned.plan.visualIntent,
      plannerElapsedMs,
      totalElapsedMs: elapsed(dependencies, totalStartedAt),
      failureCode: 'provider_unavailable',
      queries: queryRows,
      candidates: [],
    })
    throw providerError()
  }

  const fused = dependencies.fuse(successfulLanes, request.candidateCount)
  const validCandidateCount = request.page !== undefined && request.page > 1
    ? fused.length >= 1 && fused.length <= request.candidateCount
    : fused.length === request.candidateCount
  if (!validCandidateCount) {
    await dependencies.repository.finishRun({
      runId: begin.runId,
      status: 'failed',
      fallbackUsed: planned.fallbackUsed,
      visualIntent: planned.plan.visualIntent,
      plannerElapsedMs,
      totalElapsedMs: elapsed(dependencies, totalStartedAt),
      failureCode: 'provider_unavailable',
      queries: queryRows,
      candidates: [],
    })
    throw providerError()
  }
  const candidates = await enrichFreshCandidates(fused, dependencies)
  const status = planned.fallbackUsed || successfulLanes.length < LANE_DEFINITIONS.length
    ? 'degraded'
    : 'completed'
  await dependencies.repository.finishRun({
    runId: begin.runId,
    status,
    fallbackUsed: planned.fallbackUsed,
    visualIntent: planned.plan.visualIntent,
    plannerElapsedMs,
    totalElapsedMs: elapsed(dependencies, totalStartedAt),
    failureCode: null,
    queries: queryRows,
    candidates: candidates.map(candidate => candidate.persisted),
  })

  const response: VideoAssetMatchResponse = {
    runId: begin.runId,
    status,
    planner: {
      model: PLANNER_MODEL,
      promptVersion: PROMPT_VERSION,
      fallbackUsed: planned.fallbackUsed,
    },
    visualIntent: planned.plan.visualIntent,
    queries: responseQueries(queryRows),
    candidates: candidates.map(candidate => responseCandidate(candidate.persisted, candidate.previewUrl)),
  }
  return withPagination(response, request, queryAuditHasNextPage(queryRows, request.page))
}

async function planningSource(
  request: VideoAssetRequest,
  repository: VideoAssetRepository,
): Promise<VisualPlannerInput> {
  if (request.subtitleChunkId !== undefined) {
    const context = await repository.loadChunkContext(request.subtitleChunkId)
    if (context === null) {
      throw new VideoAssetError(404, 'subtitle_chunk_not_ready', 'subtitle chunk is not available')
    }
    return {
      sourceText: context.sourceText,
      ...(context.contextText === undefined ? {} : { contextText: context.contextText }),
      ...(request.theme === undefined ? {} : { theme: request.theme }),
      movieTitle: context.movieTitle,
      forbiddenTerms: [context.movieTitle],
    }
  }

  return {
    sourceText: request.text ?? request.theme as string,
    ...(request.theme === undefined ? {} : { theme: request.theme }),
    forbiddenTerms: [],
  }
}

async function requestDigest(
  request: VideoAssetRequest,
  inputKind: 'chunk' | 'text' | 'theme',
  sha256: VideoAssetMatchingDependencies['sha256'],
): Promise<string> {
  const canonical = JSON.stringify(request.page === undefined
    ? {
        version: 1,
        promptVersion: PROMPT_VERSION,
        sourceKind: inputKind,
        ...(request.subtitleChunkId === undefined
          ? request.text === undefined ? {} : { sourceText: request.text }
          : { sourceId: request.subtitleChunkId }),
        theme: request.theme ?? null,
        candidateCount: request.candidateCount,
      }
    : request.sourceRunId !== undefined
      ? {
          version: 2,
          promptVersion: PROMPT_VERSION,
          sourceRunId: request.sourceRunId,
          theme: request.theme,
          page: request.page,
          candidateCount: request.candidateCount,
        }
      : {
          version: 2,
          promptVersion: PROMPT_VERSION,
          sourceKind: inputKind,
          ...(request.subtitleChunkId === undefined
            ? request.text === undefined ? {} : { sourceText: request.text }
            : { sourceId: request.subtitleChunkId }),
          theme: request.theme ?? null,
          candidateCount: request.candidateCount,
          page: request.page,
        })
  let digest: string
  try {
    digest = (await sha256(canonical)).toLowerCase()
  } catch {
    throw new VideoAssetError(500, 'request_digest_failed', 'video asset request digest failed')
  }
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new VideoAssetError(500, 'request_digest_failed', 'video asset request digest failed')
  }
  return digest
}

async function refreshPersistedRun(
  run: PersistedVideoAssetRun,
  dependencies: VideoAssetMatchingDependencies,
): Promise<VideoAssetMatchResponse> {
  const details = await loadDetails(
    run.candidates.map(candidate => candidate.providerResourceId),
    dependencies,
  )
  const candidates = run.candidates.map((candidate, index) => {
    const detail = details[index]
    if (detail.status !== 'fulfilled'
      || detail.value.stable.providerResourceId !== candidate.providerResourceId) {
      return responseCandidate(candidate, null)
    }
    return responseCandidate(mergeStableCandidate(candidate, detail.value), detail.value.ephemeral.previewUrl)
  })

  return {
    runId: run.runId,
    status: run.status,
    planner: run.planner,
    visualIntent: run.visualIntent,
    queries: run.queries.map(query => ({
      kind: query.kind,
      term: query.term,
      status: query.status,
      ...(query.status === 'failed' ? { errorCode: 'provider_unavailable' } : {}),
    })),
    candidates,
  }
}

async function enrichFreshCandidates(
  fused: FusedCandidate[],
  dependencies: VideoAssetMatchingDependencies,
): Promise<Array<{ persisted: FinishRunCandidate; previewUrl: string | null }>> {
  const details = await loadDetails(
    fused.map(candidate => candidate.providerResourceId),
    dependencies,
  )
  return fused.map((candidate, index) => {
    const detail = details[index]
    const resource = detail.status === 'fulfilled'
      && detail.value.stable.providerResourceId === candidate.providerResourceId
      ? mergeResource(candidate.resource, detail.value)
      : withoutDetailMetadata(candidate.resource)
    return {
      persisted: {
        ...resource.stable,
        provider: 'vecteezy',
        score: candidate.score,
        bestRank: candidate.bestRank,
        matchedBy: candidate.matchedBy,
      },
      previewUrl: resource.ephemeral.previewUrl,
    }
  })
}

async function loadDetails(
  providerResourceIds: number[],
  dependencies: VideoAssetMatchingDependencies,
): Promise<Array<PromiseSettledResult<VecteezySearchResource>>> {
  const results = Array<PromiseSettledResult<VecteezySearchResource>>(providerResourceIds.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < providerResourceIds.length) {
      const index = nextIndex++
      try {
        results[index] = { status: 'fulfilled', value: await dependencies.detail(providerResourceIds[index]) }
      } catch {
        results[index] = { status: 'rejected', reason: undefined }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, providerResourceIds.length) }, worker))
  return results
}

function withoutDetailMetadata(resource: VecteezySearchResource): VecteezySearchResource {
  return {
    stable: {
      ...resource.stable,
      licenseType: null,
      orientation: null,
      tags: [],
      fileTypes: [],
      downloadSizes: [],
    },
    ephemeral: resource.ephemeral,
  }
}

function mergeResource(
  current: VecteezySearchResource,
  detail: VecteezySearchResource,
): VecteezySearchResource {
  return {
    stable: {
      ...current.stable,
      licenseType: detail.stable.licenseType,
      orientation: detail.stable.orientation,
      tags: detail.stable.tags,
      fileTypes: detail.stable.fileTypes,
      downloadSizes: detail.stable.downloadSizes,
    },
    ephemeral: detail.ephemeral,
  }
}

function mergeStableCandidate(
  current: PersistedVideoAssetCandidate,
  detail: VecteezySearchResource,
): PersistedVideoAssetCandidate {
  return {
    ...current,
    licenseType: detail.stable.licenseType,
    orientation: detail.stable.orientation,
    tags: detail.stable.tags,
    fileTypes: detail.stable.fileTypes,
    downloadSizes: detail.stable.downloadSizes,
  }
}

function responseCandidate(candidate: PersistedVideoAssetCandidate, previewUrl: string | null): VideoAssetCandidate {
  return {
    provider: candidate.provider,
    providerResourceId: candidate.providerResourceId,
    title: candidate.title,
    licenseType: candidate.licenseType,
    aiGenerated: candidate.aiGenerated,
    orientation: candidate.orientation,
    fileTypes: candidate.fileTypes,
    downloadSizes: candidate.downloadSizes,
    score: candidate.score,
    bestRank: candidate.bestRank,
    matchedBy: candidate.matchedBy,
    previewUrl,
  }
}

function responseQueries(queries: FinishRunQuery[]): VideoAssetMatchResponse['queries'] {
  return queries.map(query => ({
    kind: query.kind,
    term: query.term,
    status: query.status,
    ...(query.errorCode === undefined ? {} : { errorCode: query.errorCode }),
  }))
}

function requiredQuery(plan: VisualPlan, kind: QueryKind) {
  const query = plan.queries.find(query => query.kind === kind)
  if (query === undefined) {
    throw new VideoAssetError(502, 'planner_unavailable', 'visual planner unavailable')
  }
  return query
}

function failedQueries(errorCode: string, term: string, elapsedMs: number, page?: number): FinishRunQuery[] {
  return LANE_DEFINITIONS.map(lane => ({
    kind: lane.kind,
    term,
    weight: lane.weight,
    filters: queryFilters(page, false),
    providerTotal: null,
    status: 'failed',
    elapsedMs,
    errorCode,
  }))
}

function queryFilters(page?: number, hasNextPage = false): Record<string, unknown> {
  return page === undefined ? QUERY_FILTERS : { ...QUERY_FILTERS, page, hasNextPage }
}

function withPagination(
  response: VideoAssetMatchResponse,
  request: VideoAssetRequest,
  hasNextPage: boolean,
): VideoAssetMatchResponse {
  return request.page === undefined
    ? response
    : { ...response, page: request.page, hasNextPage }
}

function providerHasNextPage(
  provider: ProviderSearchResult,
  page?: number,
): boolean {
  if (page === undefined || page >= 100) return false
  return provider.totalResources === null
    ? provider.resources.length >= QUERY_FILTERS.perPage
    : page * QUERY_FILTERS.perPage < provider.totalResources
}

function queryAuditHasNextPage(queries: readonly PersistedVideoAssetRun['queries'][number][], page?: number): boolean {
  return page !== undefined && queries.some(query => (
    query.filters.page === page && query.filters.hasNextPage === true
  ))
}

function persistedHasNextPage(run: PersistedVideoAssetRun, page?: number): boolean {
  return queryAuditHasNextPage(run.queries, page)
}

function isExplicitRootRun(run: PersistedVideoAssetRun, theme?: string): boolean {
  return theme !== undefined
    && run.inputKind === 'theme'
    && run.theme === theme
    && run.queries.length === LANE_DEFINITIONS.length
    && LANE_DEFINITIONS.every(lane => run.queries.some(query => (
      query.kind === lane.kind
      && query.filters.page === 1
      && typeof query.filters.hasNextPage === 'boolean'
    )))
}

function plannerError(error: unknown): VideoAssetError {
  if (error instanceof VideoAssetError
    && (error.code === 'planner_unavailable' || error.code === 'planner_configuration_error')) {
    return error
  }
  return new VideoAssetError(502, 'planner_unavailable', 'visual planner unavailable')
}

function providerError(): VideoAssetError {
  return new VideoAssetError(502, 'provider_unavailable', 'video provider unavailable')
}

function elapsed(dependencies: VideoAssetMatchingDependencies, startedAt: number): number {
  return Math.max(0, Math.round(dependencies.now() - startedAt))
}

class LaneFailure extends Error {
  constructor(readonly elapsedMs: number) {
    super('provider lane failed')
  }
}
