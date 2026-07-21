export interface SubtitleSearchRequest {
  query: string
  limit: number
}

export interface SubtitleLibrarySummary {
  readyTracks: number
  readyMovies: number
}

export interface SubtitleCue {
  index: number
  startMs: number
  endMs: number
  text: string
}

export interface HybridSubtitleSearchResult {
  similarity: number
  rrfScore: number
  semanticRank: number | null
  fullTextRank: number | null
  movie: { id: number; title: string; releaseYear: number | null }
  trackId: number
  chunkIndex: number
  startMs: number
  endMs: number
  timestamp: string
  text: string
  cues: SubtitleCue[]
}

export interface SubtitleSearchResponse {
  originalQuery: string
  normalizedQuery: string
  warning: 'query_normalization_failed' | null
  results: HybridSubtitleSearchResult[]
}

export interface NormalizeSearchInput {
  query: string
  translate(query: string): Promise<string>
}

export interface NormalizedSearchQuery {
  query: string
  warning: 'query_normalization_failed' | null
}

export interface SubtitleLibraryClientConfiguration {
  supabaseUrl: string
  publishableKey: string
  personalToken: string
  ollamaEndpoint: URL
  ollamaModel: string
  fetchFn?: typeof fetch
}

const QUERY_LIMIT = 500
const RESULT_LIMIT = 50
const RESPONSE_LIMIT = 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000

export class SubtitleLibraryClient {
  private readonly fetchFn: typeof fetch
  private readonly hybridSearchUrl: string
  private readonly summaryUrl: string

  constructor(private readonly configuration: SubtitleLibraryClientConfiguration) {
    this.fetchFn = configuration.fetchFn ?? fetch
    const baseUrl = configuration.supabaseUrl.replace(/\/$/, '')
    this.hybridSearchUrl = `${baseUrl}/functions/v1/hybrid-subtitle-search`
    this.summaryUrl = `${baseUrl}/functions/v1/subtitle-library`
  }

  async search(input: SubtitleSearchRequest): Promise<SubtitleSearchResponse> {
    const originalQuery = parseSearchQuery(input.query)
    const limit = parseLimit(input.limit)
    const normalized = await normalizeSearchQuery({
      query: originalQuery,
      translate: async query => await this.translate(query),
    })
    const results = parseHybridSearchResponse(
      await this.request(this.hybridSearchUrl, { query: normalized.query, limit }),
    )
    if (results.length > limit) invalidResponse()
    return {
      originalQuery,
      normalizedQuery: normalized.query,
      warning: normalized.warning,
      results,
    }
  }

  async summary(): Promise<SubtitleLibrarySummary> {
    return parseLibrarySummary(await this.request(this.summaryUrl))
  }

  private async translate(query: string): Promise<string> {
    const response = await this.fetchFn(new URL('/api/generate', this.configuration.ollamaEndpoint.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.configuration.ollamaModel,
        prompt: 'Translate this subtitle-library search query to concise English. Return only JSON with exactly one query string property. Input: ' + JSON.stringify(query),
        stream: false,
        format: 'json',
        think: false,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error('normalization failed')
    const envelope = record(await readJson(response))
    if (typeof envelope.response !== 'string' || 'error' in envelope) throw new Error('normalization failed')
    const output = record(JSON.parse(unwrapJsonFence(envelope.response)))
    if (Object.keys(output).length !== 1 || typeof output.query !== 'string') throw new Error('normalization failed')
    return parseSearchQuery(output.query)
  }

  private async request(url: string, body?: object): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          apikey: this.configuration.publishableKey,
          'x-subtitle-token': this.configuration.personalToken,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      throw new Error('subtitle library request failed')
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('subtitle library request failed')
    }
    try {
      return await readJson(response)
    } catch {
      throw new Error('subtitle library request failed')
    }
  }
}

export async function normalizeSearchQuery(input: NormalizeSearchInput): Promise<NormalizedSearchQuery> {
  if (!/\p{Script=Han}/u.test(input.query)) return { query: input.query, warning: null }
  try {
    return { query: await input.translate(input.query), warning: null }
  } catch {
    return { query: input.query, warning: 'query_normalization_failed' }
  }
}

function parseHybridSearchResponse(value: unknown): HybridSubtitleSearchResult[] {
  const response = record(value)
  if (Object.keys(response).length !== 1 || !Array.isArray(response.results)) invalidResponse()
  return response.results.map(parseHybridSearchResult)
}

function parseHybridSearchResult(value: unknown): HybridSubtitleSearchResult {
  const result = record(value)
  const allowed = new Set([
    'similarity', 'rrfScore', 'semanticRank', 'fullTextRank', 'movie', 'trackId',
    'chunkIndex', 'startMs', 'endMs', 'timestamp', 'text', 'cues',
  ])
  if (Object.keys(result).length !== allowed.size || Object.keys(result).some(key => !allowed.has(key))) invalidResponse()
  const startMs = nonNegativeInteger(result.startMs)
  const endMs = positiveInteger(result.endMs)
  if (endMs <= startMs || typeof result.text !== 'string' || typeof result.timestamp !== 'string'
    || result.timestamp !== timestamp(startMs, endMs)) invalidResponse()
  const semanticRank = rank(result.semanticRank)
  const fullTextRank = rank(result.fullTextRank)
  if (semanticRank === null && fullTextRank === null) invalidResponse()
  const movie = record(result.movie)
  if (Object.keys(movie).length !== 3 || !isPositiveInteger(movie.id) || typeof movie.title !== 'string'
    || (movie.releaseYear !== null && !isInteger(movie.releaseYear))) invalidResponse()
  if (!finiteNumber(result.similarity) || !finiteNumber(result.rrfScore) || !isPositiveInteger(result.trackId)
    || !isNonNegativeInteger(result.chunkIndex) || !Array.isArray(result.cues) || result.cues.length === 0) invalidResponse()
  const cues = result.cues.map(parseCue)
  if (cues.some((cue, index) => index > 0 && cue.index !== cues[index - 1].index + 1)) invalidResponse()
  return {
    similarity: result.similarity,
    rrfScore: result.rrfScore,
    semanticRank,
    fullTextRank,
    movie: { id: movie.id, title: movie.title, releaseYear: movie.releaseYear },
    trackId: result.trackId,
    chunkIndex: result.chunkIndex,
    startMs,
    endMs,
    timestamp: result.timestamp,
    text: result.text,
    cues,
  }
}

function parseCue(value: unknown): SubtitleCue {
  const cue = record(value)
  if (Object.keys(cue).length !== 4 || !isNonNegativeInteger(cue.index) || !isNonNegativeInteger(cue.startMs)
    || !isPositiveInteger(cue.endMs) || cue.endMs <= cue.startMs || typeof cue.text !== 'string') invalidResponse()
  return { index: cue.index, startMs: cue.startMs, endMs: cue.endMs, text: cue.text }
}

function parseLibrarySummary(value: unknown): SubtitleLibrarySummary {
  const summary = record(value)
  if (Object.keys(summary).length !== 2 || !isNonNegativeInteger(summary.readyTracks)
    || !isNonNegativeInteger(summary.readyMovies)) invalidResponse()
  return { readyTracks: summary.readyTracks, readyMovies: summary.readyMovies }
}

async function readJson(response: Response): Promise<unknown> {
  const body = await response.text()
  if (Buffer.byteLength(body) > RESPONSE_LIMIT) throw new Error('response too large')
  return JSON.parse(body)
}

function parseSearchQuery(value: string): string {
  const query = typeof value === 'string' ? value.trim() : ''
  if (query.length === 0 || query.length > QUERY_LIMIT) throw new Error('invalid subtitle library search query')
  return query
}

function parseLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > RESULT_LIMIT) {
    throw new Error('invalid subtitle library search limit')
  }
  return value
}

function rank(value: unknown): number | null {
  if (value === null) return null
  if (!isPositiveInteger(value)) invalidResponse()
  return value
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidResponse()
  return value as Record<string, unknown>
}

function invalidResponse(): never {
  throw new Error('subtitle library search returned an invalid response')
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isPositiveInteger(value: unknown): value is number {
  return isInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0
}

function positiveInteger(value: unknown): number {
  if (!isPositiveInteger(value)) invalidResponse()
  return value
}

function nonNegativeInteger(value: unknown): number {
  if (!isNonNegativeInteger(value)) invalidResponse()
  return value
}

function timestamp(startMs: number, endMs: number): string {
  return `${formatTimestamp(startMs)} --> ${formatTimestamp(endMs)}`
}

function formatTimestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000)
  const seconds = Math.floor(milliseconds % 60_000 / 1_000)
  const remainder = milliseconds % 1_000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`
}

function unwrapJsonFence(value: string): string {
  const trimmed = value.trim()
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return match === null ? trimmed : match[1]
}
