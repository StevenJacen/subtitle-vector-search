import type { Cue, SubtitleChunk } from './domain.js'

export interface SubtitleApiConfig {
  supabaseUrl: string
  publishableKey: string
  personalToken: string
  fetchFn?: typeof fetch
  delayFn?: (milliseconds: number) => Promise<void>
}

export interface MovieInput {
  title: string
  releaseYear?: number
  imdbId: string
}

export interface TrackInput {
  languageCode: string
  source: string
  sourceRef?: string
  sourceFileName?: string
  sourceSha256: string
  rightsStatus?: RightsStatus
}

export type RightsStatus = 'personal_research' | 'licensed' | 'unverified'

export interface StartImportResponse {
  movieId: number
  trackId: number
  existingCueCount: number
  existingChunkCount: number
}

export interface BatchImportResponse {
  acceptedCueCount: number
  acceptedChunkCount: number
}

export interface FinalizeImportResponse {
  trackId: number
  status: 'ready'
}

export interface FailImportResponse {
  trackId: number
  status: 'failed'
}

export interface SubtitleSearchResult {
  similarity: number
  movie: { id: number; title: string; releaseYear: number | null }
  trackId: number
  chunkIndex: number
  startMs: number
  endMs: number
  timestamp: string
  text: string
  cues: Cue[]
}

export class SubtitleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'SubtitleApiError'
  }
}

export class SubtitleApi {
  private readonly fetchFn: typeof fetch
  private readonly ingestUrl: string
  private readonly searchUrl: string
  private readonly delayFn: (milliseconds: number) => Promise<void>

  constructor(config: SubtitleApiConfig) {
    this.fetchFn = config.fetchFn ?? fetch
    this.delayFn = config.delayFn ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
    const baseUrl = config.supabaseUrl.replace(/\/$/, '')
    this.ingestUrl = `${baseUrl}/functions/v1/ingest-subtitles`
    this.searchUrl = `${baseUrl}/functions/v1/search-subtitles`
    this.headers = {
      apikey: config.publishableKey,
      'x-subtitle-token': config.personalToken,
      'content-type': 'application/json',
    }
  }

  private readonly headers: Record<string, string>

  startImport(input: { movie: MovieInput; track: TrackInput }): Promise<StartImportResponse> {
    return this.request(this.ingestUrl, {
      action: 'start',
      movie: input.movie,
      track: { ...input.track, rightsStatus: input.track.rightsStatus ?? 'personal_research' },
    })
  }

  sendBatch(input: { trackId: number; cues: Cue[]; chunks: SubtitleChunk[] }): Promise<BatchImportResponse> {
    return this.request(this.ingestUrl, {
      action: 'batch',
      trackId: input.trackId,
      cues: input.cues,
      chunks: input.chunks,
    })
  }

  finalizeImport(trackId: number): Promise<FinalizeImportResponse> {
    return this.request(this.ingestUrl, { action: 'finalize', trackId })
  }

  failImport(trackId: number): Promise<FailImportResponse> {
    return this.request(this.ingestUrl, { action: 'fail', trackId })
  }

  async search(input: { query: string; limit?: number; movieId?: number }): Promise<SubtitleSearchResult[]> {
    const response = await this.request<unknown>(this.searchUrl, input)
    if (!isSearchResponse(response)) {
      throw new SubtitleApiError('subtitle search returned an invalid response', 502, 'invalid_response')
    }
    return response.results
  }

  private async request<ResponseBody>(url: string, body: object): Promise<ResponseBody> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.fetchFn(url, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify(body),
        })
        const payload = await response.json().catch(() => undefined) as ErrorEnvelope | ResponseBody | undefined

        if (!response.ok) {
          const error = isErrorEnvelope(payload) ? payload.error : undefined
          const requestError = new SubtitleApiError(
            error?.message ?? `Subtitle API request failed with HTTP ${response.status}`,
            response.status,
            error?.code ?? 'request_failed',
          )
          if (!isTransientStatus(response.status) || attempt === 2) {
            throw requestError
          }
        } else {
          return payload as ResponseBody
        }
      } catch (error) {
        if (error instanceof SubtitleApiError || attempt === 2) {
          throw error
        }
      }

      await this.delayFn(250 * (2 ** attempt))
    }
    throw new Error('unreachable')
  }
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500
}

interface ErrorEnvelope {
  error: { code: string; message: string }
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return typeof value === 'object'
    && value !== null
    && 'error' in value
    && typeof value.error === 'object'
    && value.error !== null
    && 'code' in value.error
    && 'message' in value.error
    && typeof value.error.code === 'string'
    && typeof value.error.message === 'string'
}

function isSearchResponse(value: unknown): value is { results: SubtitleSearchResult[] } {
  return isRecord(value) && Array.isArray(value.results) && value.results.every(isSearchResult)
}

function isSearchResult(value: unknown): value is SubtitleSearchResult {
  return isRecord(value)
    && finiteNumber(value.similarity)
    && isRecord(value.movie)
    && positiveInteger(value.movie.id)
    && typeof value.movie.title === 'string'
    && (value.movie.releaseYear === null || integer(value.movie.releaseYear))
    && positiveInteger(value.trackId)
    && nonNegativeInteger(value.chunkIndex)
    && nonNegativeInteger(value.startMs)
    && positiveInteger(value.endMs)
    && value.endMs > value.startMs
    && typeof value.timestamp === 'string'
    && typeof value.text === 'string'
    && Array.isArray(value.cues)
    && value.cues.every(isCue)
}

function isCue(value: unknown): value is Cue {
  return isRecord(value)
    && nonNegativeInteger(value.index)
    && nonNegativeInteger(value.startMs)
    && positiveInteger(value.endMs)
    && value.endMs > value.startMs
    && typeof value.text === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function positiveInteger(value: unknown): value is number {
  return integer(value) && value > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return integer(value) && value >= 0
}
