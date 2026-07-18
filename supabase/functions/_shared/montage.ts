import { assertQueryEmbedding, type MatchSubtitleChunkRow } from './search.ts'

export interface MontageRequest {
  theme: string
  quoteCount: number
  matchThreshold: number
  maxPerMovie: number
  movieIds?: number[]
}

export class MontageRequestError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'english_theme_required' = 'invalid_request',
    message = code === 'english_theme_required' ? 'English themes are required' : 'invalid request',
  ) {
    super(message)
    this.name = 'MontageRequestError'
  }
}

export function parseMontageRequest(value: unknown): MontageRequest {
  const input = object(value)
  const theme = englishTheme(input.theme)
  const quoteCount = input.quoteCount === undefined ? 8 : integerInRange(input.quoteCount, 3, 15)
  const matchThreshold = input.matchThreshold === undefined
    ? 0.72
    : numberInRange(input.matchThreshold, 0, 1)
  const maxPerMovie = input.maxPerMovie === undefined ? 1 : integerInRange(input.maxPerMovie, 1, 3)
  const movieIds = input.movieIds === undefined ? undefined : positiveUniqueIntegers(input.movieIds)

  return {
    theme,
    quoteCount,
    matchThreshold,
    maxPerMovie,
    ...(movieIds === undefined ? {} : { movieIds }),
  }
}

export function assertMontageEmbedding(value: unknown): number[] {
  return assertQueryEmbedding(value)
}

export function buildMontageResponse(theme: string, rows: MatchSubtitleChunkRow[]) {
  return {
    theme,
    copy: rows.map(row => row.text).join('\n\n'),
    quotes: rows.map(row => ({
      text: row.text,
      movieId: row.movie_id,
      movieTitle: row.movie_title,
      releaseYear: row.movie_release_year,
      trackId: row.track_id,
      chunkIndex: row.chunk_index,
      startMs: row.start_ms,
      endMs: row.end_ms,
      firstCueIndex: row.first_cue_index,
      lastCueIndex: row.last_cue_index,
      similarity: row.similarity,
    })),
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MontageRequestError()
  }
  return value as Record<string, unknown>
}

function englishTheme(value: unknown): string {
  if (typeof value !== 'string') {
    throw new MontageRequestError()
  }
  const theme = value.trim()
  if (theme === ''
    || theme.length > 300
    || !/^[\x09-\x0D\x20-\x7E]+$/.test(theme)
    || !/[A-Za-z]/.test(theme)) {
    throw new MontageRequestError('english_theme_required')
  }
  return theme
}

function integerInRange(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum) {
    throw new MontageRequestError()
  }
  return value
}

function numberInRange(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number'
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum) {
    throw new MontageRequestError()
  }
  return value
}

function positiveUniqueIntegers(value: unknown): number[] {
  if (!Array.isArray(value)
    || value.length === 0
    || value.some(item => typeof item !== 'number' || !Number.isSafeInteger(item) || item <= 0)
    || new Set(value).size !== value.length) {
    throw new MontageRequestError()
  }
  return value as number[]
}
