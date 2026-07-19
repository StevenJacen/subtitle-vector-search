import { describe, expect, it } from 'vitest'
import type { Cue } from '../src/domain.js'
import type { SubtitleSearchResult } from '../src/supabase-api.js'
import { QuoteSelectionError, selectExactQuote } from '../src/quote-selection.js'

function searchResult(overrides: Partial<SubtitleSearchResult> & { cues: Cue[] }): SubtitleSearchResult {
  return {
    similarity: 0.83,
    movie: { id: 2, title: 'Synthetic Film', releaseYear: 1994 },
    trackId: 7,
    chunkIndex: 0,
    startMs: overrides.cues[0]?.startMs ?? 0,
    endMs: overrides.cues.at(-1)?.endMs ?? 1_000,
    timestamp: 'chunk timestamp must not replace cue timestamp',
    text: overrides.cues.map(cue => cue.text).join(' '),
    ...overrides,
  }
}

function cue(index: number, text: string, startMs = 120_000, endMs = startMs + 5_000): Cue {
  return { index, startMs, endMs, text }
}

describe('selectExactQuote', () => {
  it('returns the exact selected cue text and exact cue timestamp', () => {
    const result = searchResult({
      similarity: 0.83,
      movie: { id: 2, title: 'Synthetic Film', releaseYear: 1994 },
      trackId: 7,
      cues: [cue(31, '  Hope remains with us.  ')],
    })

    expect(selectExactQuote([result])).toEqual({
      text: '  Hope remains with us.  ',
      similarity: 0.83,
      movieId: 2,
      movieTitle: 'Synthetic Film',
      releaseYear: 1994,
      trackId: 7,
      cueIndex: 31,
      startMs: 120_000,
      endMs: 125_000,
      timestamp: '00:02:00.000 --> 00:02:05.000',
    })
  })

  it('accepts preferred cues with 5 to 18 English words and at most eight seconds', () => {
    const accepted = searchResult({ cues: [
      cue(1, "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen", 0, 8_000),
    ] })

    expect(selectExactQuote([accepted]).cueIndex).toBe(1)
  })

  it.each([
    ['two words', 'one two', 0, 5_000],
    ['twenty-five words', 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five', 0, 5_000],
    ['over ten seconds', 'one two three four five', 0, 10_001],
  ])('rejects cue with %s in both selection passes', (_label, text, startMs, endMs) => {
    expect(() => selectExactQuote([searchResult({ cues: [cue(1, text, startMs, endMs)] })]))
      .toThrowError(QuoteSelectionError)
  })

  it.each([
    '[MUSIC]',
    '[door closes]',
    'JOHN:',
  ])('rejects sound-only brackets and label-only cues: %s', text => {
    expect(() => selectExactQuote([searchResult({ cues: [cue(1, text)] })]))
      .toThrowError(QuoteSelectionError)
  })

  it('orders preferred candidates by similarity descending', () => {
    const lower = searchResult({ similarity: 0.75, cues: [cue(1, 'lower similarity quote here today')] })
    const higher = searchResult({ similarity: 0.91, cues: [cue(2, 'higher similarity quote here today')] })

    expect(selectExactQuote([lower, higher]).cueIndex).toBe(2)
  })

  it('breaks equal-similarity ties by shorter cue duration', () => {
    const longer = searchResult({ similarity: 0.8, cues: [cue(1, 'same score quote here today', 0, 8_000)] })
    const shorter = searchResult({ similarity: 0.8, cues: [cue(2, 'same score quote here today', 10_000, 14_000)] })

    expect(selectExactQuote([longer, shorter]).cueIndex).toBe(2)
  })

  it('breaks remaining ties by movie, track, then cue identifiers', () => {
    const candidates = [
      searchResult({ movie: { id: 3, title: 'Later Film', releaseYear: null }, trackId: 1, cues: [cue(1, 'same score quote here today')] }),
      searchResult({ movie: { id: 2, title: 'Earlier Film', releaseYear: null }, trackId: 9, cues: [cue(4, 'same score quote here today')] }),
      searchResult({ movie: { id: 2, title: 'Earlier Film', releaseYear: null }, trackId: 7, cues: [cue(5, 'same score quote here today')] }),
      searchResult({ movie: { id: 2, title: 'Earlier Film', releaseYear: null }, trackId: 7, cues: [cue(2, 'same score quote here today')] }),
    ].map(result => ({ ...result, similarity: 0.8 }))

    expect(selectExactQuote(candidates)).toMatchObject({ movieId: 2, trackId: 7, cueIndex: 2 })
  })

  it('deduplicates the same track and cue before selecting', () => {
    const duplicate = searchResult({ similarity: 0.95, trackId: 7, cues: [cue(2, 'duplicate quote remains here today')] })
    const sameCueLowerRank = searchResult({ similarity: 0.2, trackId: 7, cues: [cue(2, 'duplicate quote remains here today')] })
    const other = searchResult({ similarity: 0.9, trackId: 7, cues: [cue(3, 'other quote remains here today')] })

    expect(selectExactQuote([sameCueLowerRank, other, duplicate])).toMatchObject({
      text: 'duplicate quote remains here today',
      similarity: 0.95,
      trackId: 7,
      cueIndex: 2,
    })
  })

  it('uses one relaxed pass for 3 to 24 words and at most ten seconds', () => {
    const relaxed = searchResult({ cues: [cue(1, 'three words only', 0, 10_000)] })

    expect(selectExactQuote([relaxed])).toMatchObject({ text: 'three words only', cueIndex: 1 })
  })

  it('does not use relaxed candidates when a preferred candidate exists', () => {
    const preferred = searchResult({ similarity: 0.2, cues: [cue(1, 'five words make a quote', 0, 5_000)] })
    const relaxed = searchResult({ similarity: 0.99, cues: [cue(2, 'three words only', 0, 10_000)] })

    expect(selectExactQuote([relaxed, preferred]).cueIndex).toBe(1)
  })

  it('throws a controlled no_usable_quote error when both passes fail', () => {
    try {
      selectExactQuote([searchResult({ cues: [cue(1, '[MUSIC]', 0, 20_000)] })])
      throw new Error('expected quote selection to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(QuoteSelectionError)
      expect(error).toMatchObject({ code: 'no_usable_quote' })
      expect((error as Error).message).toBe('no usable quote')
    }
  })
})
