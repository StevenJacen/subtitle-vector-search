import { assertEmbedding } from './embeddings.ts'

export interface SearchRequest {
  query: string
  limit: number
  movieId?: number
}

export interface SearchCue {
  index: number
  startMs: number
  endMs: number
  text: string
}

export interface SearchResult {
  similarity: number
  movie: { id: number; title: string; releaseYear: number | null }
  trackId: number
  chunkIndex: number
  startMs: number
  endMs: number
  timestamp: string
  text: string
  cues: SearchCue[]
}

export interface MatchSubtitleChunkRow {
  movie_id: number
  movie_title: string
  movie_release_year: number | null
  track_id: number
  chunk_index: number
  start_ms: number
  end_ms: number
  text: string
  first_cue_index: number
  last_cue_index: number
  similarity: number
}

export interface SubtitleCueRow {
  track_id: number
  cue_index: number
  start_ms: number
  end_ms: number
  text: string
}

export class SearchContractError extends Error {
  constructor(message = 'invalid search request') {
    super(message)
    this.name = 'SearchContractError'
  }
}

export class SearchRequestError extends SearchContractError {
  constructor() {
    super('invalid search request')
    this.name = 'SearchRequestError'
  }
}

export function parseSearchRequest(value: unknown): SearchRequest {
  const input = object(value)
  const query = nonBlankString(input.query)
  const requestedLimit = input.limit === undefined ? 10 : positiveInteger(input.limit)
  const movieId = input.movieId === undefined ? undefined : positiveInteger(input.movieId)

  return {
    query,
    limit: Math.min(requestedLimit, 50),
    ...(movieId === undefined ? {} : { movieId }),
  }
}

export function assertQueryEmbedding(value: unknown): number[] {
  return assertEmbedding(value)
}

export function mapSearchResults(
  rows: MatchSubtitleChunkRow[],
  cueRows: SubtitleCueRow[],
): SearchResult[] {
  const uniqueCueRows = deduplicateCueRows(cueRows)

  return rows.map(row => {
    assertMatchRow(row)
    const cues = uniqueCueRows
      .filter(cue => cue.track_id === row.track_id
        && cue.cue_index >= row.first_cue_index
        && cue.cue_index <= row.last_cue_index)
      .sort((left, right) => left.cue_index - right.cue_index)
      .map(cue => ({ index: cue.cue_index, startMs: cue.start_ms, endMs: cue.end_ms, text: cue.text }))

    if (cues.length !== row.last_cue_index - row.first_cue_index + 1
      || cues.some((cue, index) => cue.index !== row.first_cue_index + index)) {
      throw new SearchContractError('matched subtitle chunk has incomplete cues')
    }

    return {
      similarity: row.similarity,
      movie: { id: row.movie_id, title: row.movie_title, releaseYear: row.movie_release_year },
      trackId: row.track_id,
      chunkIndex: row.chunk_index,
      startMs: row.start_ms,
      endMs: row.end_ms,
      timestamp: `${formatTimestamp(row.start_ms)} --> ${formatTimestamp(row.end_ms)}`,
      text: row.text,
      cues,
    }
  })
}

function deduplicateCueRows(cueRows: SubtitleCueRow[]): SubtitleCueRow[] {
  const rowsByKey = new Map<string, SubtitleCueRow>()
  for (const cue of cueRows) {
    assertCueRow(cue)
    const key = `${cue.track_id}:${cue.cue_index}`
    const existing = rowsByKey.get(key)
    if (existing !== undefined
      && (existing.start_ms !== cue.start_ms || existing.end_ms !== cue.end_ms || existing.text !== cue.text)) {
      throw new SearchContractError('conflicting subtitle cues')
    }
    rowsByKey.set(key, cue)
  }
  return [...rowsByKey.values()]
}

function assertMatchRow(row: MatchSubtitleChunkRow): void {
  if (!positiveIntegerValue(row.movie_id)
    || typeof row.movie_title !== 'string'
    || (row.movie_release_year !== null && !integerValue(row.movie_release_year))
    || !positiveIntegerValue(row.track_id)
    || !nonNegativeIntegerValue(row.chunk_index)
    || !nonNegativeIntegerValue(row.start_ms)
    || !positiveIntegerValue(row.end_ms)
    || row.end_ms <= row.start_ms
    || typeof row.text !== 'string'
    || !nonNegativeIntegerValue(row.first_cue_index)
    || !nonNegativeIntegerValue(row.last_cue_index)
    || row.last_cue_index < row.first_cue_index
    || typeof row.similarity !== 'number'
    || !Number.isFinite(row.similarity)) {
    throw new SearchContractError('invalid search result')
  }
}

function assertCueRow(row: SubtitleCueRow): void {
  if (!positiveIntegerValue(row.track_id)
    || !nonNegativeIntegerValue(row.cue_index)
    || !nonNegativeIntegerValue(row.start_ms)
    || !positiveIntegerValue(row.end_ms)
    || row.end_ms <= row.start_ms
    || typeof row.text !== 'string') {
    throw new SearchContractError('invalid subtitle cue')
  }
}

function formatTimestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000)
  const seconds = Math.floor(milliseconds % 60_000 / 1_000)
  const remainder = milliseconds % 1_000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SearchRequestError()
  }
  return value as Record<string, unknown>
}

function nonBlankString(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SearchRequestError()
  }
  return value.trim()
}

function positiveInteger(value: unknown): number {
  if (!positiveIntegerValue(value)) {
    throw new SearchRequestError()
  }
  return value
}

function positiveIntegerValue(value: unknown): value is number {
  return integerValue(value) && value > 0
}

function nonNegativeIntegerValue(value: unknown): value is number {
  return integerValue(value) && value >= 0
}

function integerValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}
