import { describe, expect, it } from 'vitest'
import {
  assertMontageEmbedding,
  buildMontageResponse,
  parseMontageRequest,
} from '../supabase/functions/_shared/montage.js'

const row = {
  movie_id: 2,
  movie_title: 'Synthetic Film',
  movie_release_year: 2030,
  track_id: 3,
  chunk_index: 4,
  start_ms: 1_000,
  end_ms: 2_000,
  text: 'We carry the light.',
  first_cue_index: 5,
  last_cue_index: 6,
  similarity: 0.83,
}

describe('montage request', () => {
  it('trims an English theme and supplies defaults', () => {
    expect(parseMontageRequest({ theme: '  love and time  ' })).toEqual({
      theme: 'love and time',
      quoteCount: 8,
      matchThreshold: 0.72,
      maxPerMovie: 1,
    })
  })

  it('accepts every explicit retrieval control', () => {
    expect(parseMontageRequest({
      theme: "Don't give up!",
      quoteCount: 15,
      matchThreshold: 1,
      maxPerMovie: 3,
      movieIds: [2, 5],
    })).toEqual({
      theme: "Don't give up!",
      quoteCount: 15,
      matchThreshold: 1,
      maxPerMovie: 3,
      movieIds: [2, 5],
    })
  })

  it.each([
    {},
    { theme: '' },
    { theme: '2026' },
    { theme: 'hope 希望' },
    { theme: `a${'b'.repeat(300)}` },
    { theme: 'hope', quoteCount: 2 },
    { theme: 'hope', quoteCount: 16 },
    { theme: 'hope', matchThreshold: Number.NaN },
    { theme: 'hope', matchThreshold: -0.1 },
    { theme: 'hope', maxPerMovie: 4 },
    { theme: 'hope', movieIds: [] },
    { theme: 'hope', movieIds: [1, 1] },
    { theme: 'hope', movieIds: [0] },
  ])('rejects invalid input %#', input => {
    expect(() => parseMontageRequest(input)).toThrow()
  })
})

describe('montage embedding and response', () => {
  it('requires a finite 384-dimensional embedding', () => {
    const embedding = Array.from({ length: 384 }, () => 0.25)
    expect(assertMontageEmbedding(embedding)).toEqual(embedding)
    expect(() => assertMontageEmbedding([...embedding.slice(1), Number.NaN])).toThrow('invalid embedding')
  })

  it('maps exact stored text and source fields', () => {
    expect(buildMontageResponse('hope', [row, { ...row, chunk_index: 5, text: 'We begin again.' }])).toEqual({
      theme: 'hope',
      copy: 'We carry the light.\n\nWe begin again.',
      quotes: [
        {
          text: 'We carry the light.', movieId: 2, movieTitle: 'Synthetic Film', releaseYear: 2030,
          trackId: 3, chunkIndex: 4, startMs: 1_000, endMs: 2_000,
          firstCueIndex: 5, lastCueIndex: 6, similarity: 0.83,
        },
        {
          text: 'We begin again.', movieId: 2, movieTitle: 'Synthetic Film', releaseYear: 2030,
          trackId: 3, chunkIndex: 5, startMs: 1_000, endMs: 2_000,
          firstCueIndex: 5, lastCueIndex: 6, similarity: 0.83,
        },
      ],
    })
    expect(buildMontageResponse('hope', [])).toEqual({ theme: 'hope', copy: '', quotes: [] })
  })
})
