import type { Cue, SubtitleChunk } from './domain.js'

export interface SubtitleApiConfig {
  supabaseUrl: string
  publishableKey: string
  personalToken: string
  fetchFn?: typeof fetch
}

export interface MovieInput {
  title: string
  releaseYear?: number
  imdbId?: string
}

export interface TrackInput {
  languageCode: string
  source: string
  sourceSha256: string
}

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

  constructor(config: SubtitleApiConfig) {
    this.fetchFn = config.fetchFn ?? fetch
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
      track: input.track,
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

  async search(input: { query: string; limit?: number; movieId?: number }): Promise<SubtitleSearchResult[]> {
    const response = await this.request<{ results: SubtitleSearchResult[] }>(this.searchUrl, input)
    return response.results
  }

  private async request<ResponseBody>(url: string, body: object): Promise<ResponseBody> {
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => undefined) as ErrorEnvelope | ResponseBody | undefined

    if (!response.ok) {
      const error = isErrorEnvelope(payload) ? payload.error : undefined
      throw new SubtitleApiError(
        error?.message ?? `Subtitle API request failed with HTTP ${response.status}`,
        response.status,
        error?.code ?? 'request_failed',
      )
    }

    return payload as ResponseBody
  }
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
