import {
  VideoAssetError,
  type QueryKind,
  type VideoAssetProvider,
  type VideoAssetRunStatus,
  type VideoAssetSelectionRequest,
  type VisualIntent,
} from './video-assets.ts'
import type { StableVecteezyResource } from './vecteezy.ts'

export interface ChunkPlanningContext {
  sourceText: string
  contextText?: string
  movieTitle: string
}

export interface BeginRunInput {
  subtitleChunkId?: number
  inputKind: 'chunk' | 'text' | 'theme'
  inputDigest: string
  theme?: string
  candidateCount: number
  plannerModel: string
  promptVersion: string
}

export interface BeginRunResult {
  runId: string
  status: VideoAssetRunStatus
  isExisting: boolean
}

export interface PersistedVideoAssetQuery {
  kind: QueryKind
  term: string
  status: 'completed' | 'failed'
  filters: Record<string, unknown>
  providerTotal: number | null
}

export interface PersistedVideoAssetCandidate extends StableVecteezyResource {
  provider: VideoAssetProvider
  score: number
  bestRank: number
  matchedBy: QueryKind[]
}

export interface PersistedVideoAssetRun {
  runId: string
  status: Exclude<VideoAssetRunStatus, 'planning' | 'failed'>
  inputKind: 'chunk' | 'text' | 'theme'
  theme: string | null
  planner: {
    model: string
    promptVersion: string
    fallbackUsed: boolean
  }
  visualIntent: VisualIntent
  queries: PersistedVideoAssetQuery[]
  candidates: PersistedVideoAssetCandidate[]
}

export interface FinishRunQuery extends PersistedVideoAssetQuery {
  weight: number
  filters: Record<string, unknown>
  providerTotal: number | null
  elapsedMs: number
  errorCode?: string
}

export interface FinishRunCandidate extends PersistedVideoAssetCandidate {}

export interface FinishRunInput {
  runId: string
  status: Exclude<VideoAssetRunStatus, 'planning'>
  fallbackUsed: boolean
  visualIntent: VisualIntent | null
  plannerElapsedMs: number
  totalElapsedMs: number
  failureCode: string | null
  queries: FinishRunQuery[]
  candidates: FinishRunCandidate[]
}

export interface VisualConceptMatch {
  conceptKey: string
  description: string
  literalQuery: string
  actionQuery: string
  metaphorQuery: string
  similarity: number
}

export interface VideoAssetRepository {
  loadChunkContext(chunkId: number): Promise<ChunkPlanningContext | null>
  beginRun(input: BeginRunInput): Promise<BeginRunResult>
  loadRun(runId: string): Promise<PersistedVideoAssetRun>
  finishRun(input: FinishRunInput): Promise<void>
  matchVisualConcept(embedding: number[]): Promise<VisualConceptMatch | null>
  selectCandidate(input: VideoAssetSelectionRequest): Promise<{ selectionId: number }>
}

interface DatabaseResult {
  data: unknown
  error: unknown
}

interface SupabaseRepositoryClient {
  from(table: string): any
  rpc(name: string, arguments_: Record<string, unknown>): PromiseLike<DatabaseResult>
}

export function createVideoAssetRepository(client: SupabaseRepositoryClient): VideoAssetRepository {
  return {
    async loadChunkContext(chunkId) {
      const chunk = row(await database(client
        .from('subtitle_chunks')
        .select('track_id, text, first_cue_index, last_cue_index')
        .eq('id', chunkId)
        .maybeSingle()))
      if (chunk === null) return null

      const trackId = integer(chunk.track_id)
      const firstCueIndex = integer(chunk.first_cue_index)
      const lastCueIndex = integer(chunk.last_cue_index)
      const sourceText = string(chunk.text)
      const track = row(await database(client
        .from('subtitle_tracks')
        .select('status, movies(title)')
        .eq('id', trackId)
        .maybeSingle()))
      if (track === null || track.status !== 'ready') return null

      const movie = record(track.movies)
      const movieTitle = string(movie.title)
      const cues = rows(await database(client
        .from('subtitle_cues')
        .select('cue_index, text')
        .eq('track_id', trackId)
        .gte('cue_index', Math.max(0, firstCueIndex - 1))
        .lte('cue_index', lastCueIndex + 1)
        .order('cue_index', { ascending: true })))
      const adjacentText = cues
        .filter(cue => cue.cue_index === firstCueIndex - 1 || cue.cue_index === lastCueIndex + 1)
        .map(cue => string(cue.text))
        .join('\n')

      return {
        sourceText,
        ...(adjacentText === '' ? {} : { contextText: adjacentText }),
        movieTitle,
      }
    },

    async beginRun(input) {
      const result = rows(await beginRunDatabase(client.rpc('begin_video_search_run', {
        p_subtitle_chunk_id: input.subtitleChunkId ?? null,
        p_input_kind: input.inputKind,
        p_input_digest: input.inputDigest,
        p_theme: input.theme ?? null,
        p_candidate_count: input.candidateCount,
        p_planner_model: input.plannerModel,
        p_prompt_version: input.promptVersion,
      }), input.subtitleChunkId !== undefined))[0]
      if (result === undefined) throw databaseFailure()
      return {
        runId: string(result.run_id),
        status: runStatus(result.status),
        isExisting: boolean(result.is_existing),
      }
    },

    async loadRun(runId) {
      const [runData, queryData, candidateData] = await Promise.all([
        database(client.from('video_search_runs')
          .select('id, status, input_kind, theme, planner_model, prompt_version, fallback_used, visual_intent')
          .eq('id', runId)
          .single()),
        database(client.from('video_search_queries')
          .select('kind, term, status, filters, provider_total')
          .eq('run_id', runId)
          .order('id', { ascending: true })),
        database(client.from('video_search_candidates')
          .select('provider, provider_resource_id, title, content_type, license_type, ai_generated, orientation, tags, file_types, download_sizes, fused_score, best_rank, matched_query_kinds')
          .eq('run_id', runId)
          .order('fused_score', { ascending: false })
          .order('best_rank', { ascending: true })
          .order('provider_resource_id', { ascending: true })),
      ])
      const run = requiredRow(runData)
      const status = runStatus(run.status)
      if (status !== 'completed' && status !== 'degraded') throw databaseFailure()

      return {
        runId: string(run.id),
        status,
        inputKind: inputKind(run.input_kind),
        theme: nullableString(run.theme),
        planner: {
          model: string(run.planner_model),
          promptVersion: string(run.prompt_version),
          fallbackUsed: boolean(run.fallback_used),
        },
        visualIntent: visualIntent(run.visual_intent),
        queries: rows(queryData).map(query => ({
          kind: queryKind(query.kind),
          term: string(query.term),
          status: queryStatus(query.status),
          filters: jsonObject(query.filters),
          providerTotal: nullableNonNegativeInteger(query.provider_total),
        })),
        candidates: rows(candidateData).map(candidate => ({
          provider: provider(candidate.provider),
          providerResourceId: positiveInteger(candidate.provider_resource_id),
          title: nullableString(candidate.title),
          contentType: video(candidate.content_type),
          licenseType: nullableString(candidate.license_type),
          aiGenerated: nullableBoolean(candidate.ai_generated),
          orientation: nullableString(candidate.orientation),
          tags: stringArray(candidate.tags),
          fileTypes: fileTypes(candidate.file_types),
          downloadSizes: downloadSizes(candidate.download_sizes),
          score: finiteNumber(candidate.fused_score),
          bestRank: positiveInteger(candidate.best_rank),
          matchedBy: queryKindArray(candidate.matched_query_kinds),
        })),
      }
    },

    async finishRun(input) {
      await database(client.rpc('finish_video_search_run', {
        p_run_id: input.runId,
        p_status: input.status,
        p_fallback_used: input.fallbackUsed,
        p_visual_intent: input.visualIntent,
        p_planner_elapsed_ms: input.plannerElapsedMs,
        p_total_elapsed_ms: input.totalElapsedMs,
        p_failure_code: input.failureCode,
        p_queries: input.queries.map(query => ({
          kind: query.kind,
          term: query.term,
          weight: query.weight,
          filters: query.filters,
          provider_total: query.providerTotal,
          status: query.status,
          elapsed_ms: query.elapsedMs,
        })),
        p_candidates: input.candidates.map(candidate => ({
          provider: candidate.provider,
          provider_resource_id: candidate.providerResourceId,
          title: candidate.title,
          content_type: candidate.contentType,
          license_type: candidate.licenseType,
          ai_generated: candidate.aiGenerated,
          orientation: candidate.orientation,
          tags: candidate.tags,
          file_types: candidate.fileTypes,
          download_sizes: candidate.downloadSizes,
          fused_score: candidate.score,
          best_rank: candidate.bestRank,
          matched_query_kinds: candidate.matchedBy,
        })),
      }))
    },

    async matchVisualConcept(embedding) {
      const result = rows(await database(client.rpc('match_visual_concept', {
        query_embedding: embedding,
      })))[0]
      if (result === undefined) return null
      return {
        conceptKey: string(result.concept_key),
        description: string(result.description),
        literalQuery: string(result.literal_query),
        actionQuery: string(result.action_query),
        metaphorQuery: string(result.metaphor_query),
        similarity: finiteNumber(result.similarity),
      }
    },

    async selectCandidate(input) {
      const result = rows(await selectionDatabase(client.rpc('select_video_asset', {
        p_run_id: input.runId,
        p_provider_resource_id: input.providerResourceId,
        p_note: input.note,
      })))[0]
      if (result === undefined) throw databaseFailure()
      return { selectionId: positiveInteger(result.selection_id) }
    },
  }
}

async function database(result: DatabaseResult | PromiseLike<DatabaseResult>): Promise<unknown> {
  let resolved: DatabaseResult
  try {
    resolved = await result
  } catch {
    throw databaseFailure()
  }
  if (resolved.error !== null) throw databaseFailure()
  return resolved.data
}

async function selectionDatabase(
  result: DatabaseResult | PromiseLike<DatabaseResult>,
): Promise<unknown> {
  let resolved: DatabaseResult
  try {
    resolved = await result
  } catch {
    throw databaseFailure()
  }
  if (resolved.error !== null) {
    if (databaseErrorCode(resolved.error) === 'P0002') {
      throw new VideoAssetError(404, 'candidate_not_found', 'candidate not found')
    }
    if (databaseErrorCode(resolved.error) === 'P0007') {
      throw new VideoAssetError(409, 'selection_locked', 'selected asset is already downloaded')
    }
    throw databaseFailure()
  }
  return resolved.data
}

async function beginRunDatabase(
  result: DatabaseResult | PromiseLike<DatabaseResult>,
  hasSubtitleChunkId: boolean,
): Promise<unknown> {
  let resolved: DatabaseResult
  try {
    resolved = await result
  } catch {
    throw databaseFailure()
  }
  if (resolved.error !== null) {
    if (hasSubtitleChunkId && databaseErrorCode(resolved.error) === '23503') {
      throw new VideoAssetError(404, 'subtitle_chunk_not_ready', 'subtitle chunk is not available')
    }
    throw databaseFailure()
  }
  return resolved.data
}

function databaseErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return null
  const code = (error as Record<string, unknown>).code
  return typeof code === 'string' ? code : null
}

function row(value: unknown): Record<string, unknown> | null {
  return value === null ? null : requiredRow(value)
}

function requiredRow(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw databaseFailure()
  return value as Record<string, unknown>
}

function rows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw databaseFailure()
  return value.map(requiredRow)
}

function record(value: unknown): Record<string, unknown> {
  return requiredRow(value)
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw databaseFailure()
  return value
}

function nullableString(value: unknown): string | null {
  if (value === null) return null
  return string(value)
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw databaseFailure()
  return value
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === null) return null
  return boolean(value)
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw databaseFailure()
  return value
}

function positiveInteger(value: unknown): number {
  const result = integer(value)
  if (result <= 0) throw databaseFailure()
  return result
}

function finiteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw databaseFailure()
  return value
}

function nullableNonNegativeInteger(value: unknown): number | null {
  if (value === null) return null
  const result = integer(value)
  if (result < 0) throw databaseFailure()
  return result
}

function jsonObject(value: unknown): Record<string, unknown> {
  return { ...record(value) }
}

function inputKind(value: unknown): 'chunk' | 'text' | 'theme' {
  if (value === 'chunk' || value === 'text' || value === 'theme') return value
  throw databaseFailure()
}

function runStatus(value: unknown): VideoAssetRunStatus {
  if (value !== 'planning' && value !== 'completed' && value !== 'degraded' && value !== 'failed') {
    throw databaseFailure()
  }
  return value
}

function queryStatus(value: unknown): 'completed' | 'failed' {
  if (value !== 'completed' && value !== 'failed') throw databaseFailure()
  return value
}

function queryKind(value: unknown): QueryKind {
  if (value !== 'literal' && value !== 'action' && value !== 'metaphor') throw databaseFailure()
  return value
}

function queryKindArray(value: unknown): QueryKind[] {
  if (!Array.isArray(value)) throw databaseFailure()
  return value.map(queryKind)
}

function provider(value: unknown): VideoAssetProvider {
  if (value !== 'vecteezy') throw databaseFailure()
  return value
}

function video(value: unknown): 'video' {
  if (value !== 'video') throw databaseFailure()
  return value
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw databaseFailure()
  return value
}

function fileTypes(value: unknown): Array<{ extension: string; sizeInBytes: number }> {
  if (!Array.isArray(value)) throw databaseFailure()
  return value.map(item => {
    const input = requiredRow(item)
    return { extension: string(input.extension), sizeInBytes: positiveInteger(input.sizeInBytes) }
  })
}

function downloadSizes(value: unknown): Array<{ id: string; width: number; height: number }> {
  if (!Array.isArray(value)) throw databaseFailure()
  return value.map(item => {
    const input = requiredRow(item)
    return {
      id: string(input.id),
      width: positiveInteger(input.width),
      height: positiveInteger(input.height),
    }
  })
}

function visualIntent(value: unknown): VisualIntent {
  const input = requiredRow(value)
  return {
    subject: string(input.subject),
    action: string(input.action),
    setting: string(input.setting),
    mood: string(input.mood),
    lighting: string(input.lighting),
    shot: string(input.shot),
  }
}

function databaseFailure(): Error {
  return new Error('database operation failed')
}
