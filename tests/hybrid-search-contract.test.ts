import { describe, expect, it } from 'vitest'
import {
  mapHybridSearchResults,
  type HybridMatchSubtitleChunkRow,
} from '../supabase/functions/_shared/hybrid-search.js'

const row: HybridMatchSubtitleChunkRow = {
  movie_id: 2,
  movie_title: 'Synthetic Film',
  movie_release_year: 2030,
  track_id: 3,
  chunk_index: 4,
  start_ms: 1_000,
  end_ms: 2_000,
  text: 'Love survives time.',
  first_cue_index: 5,
  last_cue_index: 5,
  similarity: 0.83,
  rrf_score: 0.052,
  semantic_rank: 2,
  full_text_rank: 1,
}

const cues = [
  {
    track_id: 3,
    cue_index: 5,
    start_ms: 1_000,
    end_ms: 2_000,
    text: 'Love survives time.',
  },
]

describe('hybrid search response mapping', () => {
  it('preserves source cues and adds RRF diagnostics', () => {
    expect(mapHybridSearchResults([row], cues)).toEqual([{
      similarity: 0.83,
      rrfScore: 0.052,
      semanticRank: 2,
      fullTextRank: 1,
      movie: { id: 2, title: 'Synthetic Film', releaseYear: 2030 },
      trackId: 3,
      chunkIndex: 4,
      startMs: 1_000,
      endMs: 2_000,
      timestamp: '00:00:01.000 --> 00:00:02.000',
      text: 'Love survives time.',
      cues: [{ index: 5, startMs: 1_000, endMs: 2_000, text: 'Love survives time.' }],
    }])
  })

  it('accepts a result produced by only one retrieval path', () => {
    expect(mapHybridSearchResults([{ ...row, full_text_rank: null }], cues)[0]).toMatchObject({
      semanticRank: 2,
      fullTextRank: null,
    })
    expect(mapHybridSearchResults([{ ...row, semantic_rank: null }], cues)[0]).toMatchObject({
      semanticRank: null,
      fullTextRank: 1,
    })
  })

  it.each([
    { rrf_score: Number.NaN },
    { rrf_score: Number.POSITIVE_INFINITY },
    { semantic_rank: 0 },
    { semantic_rank: -1 },
    { semantic_rank: 1.5 },
    { full_text_rank: 0 },
    { full_text_rank: -1 },
    { full_text_rank: 1.5 },
    { semantic_rank: null, full_text_rank: null },
  ])('rejects invalid hybrid diagnostics %#', invalid => {
    expect(() => mapHybridSearchResults([{ ...row, ...invalid }], cues))
      .toThrow('invalid hybrid search result')
  })
})
