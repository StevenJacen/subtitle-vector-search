import type { Cue } from './domain.js'
import { formatTimestamp } from './subtitles.js'
import type { SubtitleSearchResult } from './supabase-api.js'

export interface SelectedQuote {
  text: string
  similarity: number
  movieId: number
  movieTitle: string
  releaseYear: number | null
  trackId: number
  cueIndex: number
  startMs: number
  endMs: number
  timestamp: string
}

export class QuoteSelectionError extends Error {
  readonly code = 'no_usable_quote' as const

  constructor() {
    super('no usable quote')
    this.name = 'QuoteSelectionError'
  }
}

const englishWordPattern = /[A-Za-z]+(?:'[A-Za-z]+)?/g

export function selectExactQuote(results: SubtitleSearchResult[], query = ''): SelectedQuote {
  const queryWords = contentWords(query)
  const preferred = findCandidate(results, queryWords, 5, 18, 8_000)
  const candidate = preferred ?? findCandidate(results, queryWords, 3, 24, 10_000)

  if (candidate === undefined) throw new QuoteSelectionError()

  return {
    text: candidate.cue.text,
    similarity: candidate.result.similarity,
    movieId: candidate.result.movie.id,
    movieTitle: candidate.result.movie.title,
    releaseYear: candidate.result.movie.releaseYear,
    trackId: candidate.result.trackId,
    cueIndex: candidate.cue.index,
    startMs: candidate.cue.startMs,
    endMs: candidate.cue.endMs,
    timestamp: `${formatTimestamp(candidate.cue.startMs)} --> ${formatTimestamp(candidate.cue.endMs)}`,
  }
}

interface Candidate {
  result: SubtitleSearchResult
  cue: Cue
  durationMs: number
  queryHits: number
  resultOrder: number
  order: number
}

const queryStopWords = new Set([
  'a', 'an', 'and', 'after', 'for', 'in', 'of', 'on', 'the', 'through', 'to', 'toward', 'with',
])

function findCandidate(
  results: SubtitleSearchResult[],
  queryWords: Set<string>,
  minimumWords: number,
  maximumWords: number,
  maximumDurationMs: number,
): Candidate | undefined {
  const candidates: Candidate[] = []
  let order = 0

  for (const [resultOrder, result] of results.entries()) {
    for (const cue of result.cues) {
      const trimmedText = cue.text.trim()
      const words = trimmedText.match(englishWordPattern)?.length ?? 0
      const durationMs = cue.endMs - cue.startMs
      if (isRejectedCue(trimmedText)
        || words < minimumWords
        || words > maximumWords
        || durationMs > maximumDurationMs) {
        order += 1
        continue
      }
      candidates.push({
        result,
        cue,
        durationMs,
        queryHits: countQueryHits(trimmedText, queryWords),
        resultOrder,
        order,
      })
      order += 1
    }
  }

  candidates.sort(compareCandidates)
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const key = `${candidate.result.trackId}:${candidate.cue.index}`
    if (seen.has(key)) continue
    seen.add(key)
    return candidate
  }
  return undefined
}

function compareCandidates(left: Candidate, right: Candidate): number {
  const similarity = right.result.similarity - left.result.similarity
  if (similarity !== 0) return similarity

  if (left.resultOrder === right.resultOrder) {
    return right.queryHits - left.queryHits
      || left.cue.index - right.cue.index
      || left.order - right.order
  }

  return left.durationMs - right.durationMs
    || left.result.movie.id - right.result.movie.id
    || left.result.trackId - right.result.trackId
    || left.cue.index - right.cue.index
    || left.order - right.order
}

function contentWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(englishWordPattern) ?? [])
    .filter(word => !queryStopWords.has(word)))
}

function countQueryHits(text: string, queryWords: Set<string>): number {
  let matches = 0
  for (const word of new Set(text.toLowerCase().match(englishWordPattern) ?? [])) {
    if (queryWords.has(word)) matches += 1
  }
  return matches
}

function isRejectedCue(text: string): boolean {
  return text === ''
    || /^(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})$/.test(text)
    || /^[A-Za-z][A-Za-z0-9 .'-]*:$/.test(text)
}
