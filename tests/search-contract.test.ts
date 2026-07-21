import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  assertQueryEmbedding,
  mapSearchResults,
  parseHybridSearchRequest,
  parseSearchRequest,
} from '../supabase/functions/_shared/search.js'

const vector = Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0)

describe('search request contract', () => {
  it('rejects blank queries', () => {
    expect(requestErrorFor({ query: '   ' })).toMatchObject({
      code: 'invalid_request',
      message: 'invalid request',
    })
  })

  it('accepts ASCII English queries with contractions and ordinary punctuation', () => {
    expect(parseSearchRequest({ query: "Don't panic - build plan #2!" })).toMatchObject({
      query: "Don't panic - build plan #2!",
    })
  })

  it.each([
    ['Chinese', '希望在困难时期'],
    ['mixed non-ASCII text', 'hope 希望'],
    ['emoji only', '🎬✨'],
    ['numeric only', '2026'],
    ['punctuation only', '?!...'],
  ])('rejects %s queries as English-only input', (_description, query) => {
    expect(requestErrorFor({ query })).toMatchObject({
      code: 'english_query_required',
      message: 'English queries are required',
    })
  })

  it('defaults the limit to ten and clamps it to fifty', () => {
    expect(parseSearchRequest({ query: 'quiet determination' })).toEqual({
      query: 'quiet determination',
      limit: 10,
    })
    expect(parseSearchRequest({ query: 'quiet determination', limit: 99, movieId: 7 })).toEqual({
      query: 'quiet determination',
      limit: 50,
      movieId: 7,
    })
  })

  it('keeps legacy search English-only while accepting bounded Han hybrid queries', () => {
    expect(requestErrorFor({ query: '面对恐惧' })).toMatchObject({
      code: 'english_query_required',
    })
    expect(parseHybridSearchRequest({ query: '面对恐惧', limit: 20, movieId: 7 })).toEqual({
      query: '面对恐惧',
      limit: 20,
      movieId: 7,
    })
    expect(() => parseHybridSearchRequest({ query: 'x'.repeat(501) })).toThrow('invalid request')
  })
})

describe('query embeddings', () => {
  it('accepts only finite 384-dimensional vectors', () => {
    expect(assertQueryEmbedding(vector)).toEqual(vector)
    expect(() => assertQueryEmbedding([...vector.slice(0, 383), Number.NaN])).toThrow('invalid embedding')
  })
})

describe('search result reconstruction', () => {
  it('groups database rows into their exact ranked cue ranges', () => {
    const results = mapSearchResults([
      {
        movie_id: 7,
        movie_title: 'Synthetic Night Walk',
        movie_release_year: 2026,
        track_id: 11,
        chunk_index: 4,
        start_ms: 2_500_000,
        end_ms: 2_505_200,
        text: 'We can keep building the lantern together.',
        first_cue_index: 1,
        last_cue_index: 2,
        similarity: 0.84219,
      },
      {
        movie_id: 7,
        movie_title: 'Synthetic Night Walk',
        movie_release_year: 2026,
        track_id: 11,
        chunk_index: 1,
        start_ms: 25_000,
        end_ms: 28_000,
        text: 'The workshop opens at dawn.',
        first_cue_index: 0,
        last_cue_index: 0,
        similarity: 0.731,
      },
    ], [
      { track_id: 11, cue_index: 0, start_ms: 25_000, end_ms: 28_000, text: 'The workshop opens at dawn.' },
      { track_id: 11, cue_index: 1, start_ms: 2_500_000, end_ms: 2_502_000, text: 'We can keep building.' },
      { track_id: 11, cue_index: 2, start_ms: 2_502_000, end_ms: 2_505_200, text: 'I will carry the lantern.' },
      { track_id: 11, cue_index: 3, start_ms: 2_505_200, end_ms: 2_508_000, text: 'This cue is outside the match.' },
    ])

    expect(results).toEqual([
      {
        similarity: 0.84219,
        movie: { id: 7, title: 'Synthetic Night Walk', releaseYear: 2026 },
        trackId: 11,
        chunkIndex: 4,
        startMs: 2_500_000,
        endMs: 2_505_200,
        timestamp: '00:41:40.000 --> 00:41:45.200',
        text: 'We can keep building the lantern together.',
        cues: [
          { index: 1, startMs: 2_500_000, endMs: 2_502_000, text: 'We can keep building.' },
          { index: 2, startMs: 2_502_000, endMs: 2_505_200, text: 'I will carry the lantern.' },
        ],
      },
      {
        similarity: 0.731,
        movie: { id: 7, title: 'Synthetic Night Walk', releaseYear: 2026 },
        trackId: 11,
        chunkIndex: 1,
        startMs: 25_000,
        endMs: 28_000,
        timestamp: '00:00:25.000 --> 00:00:28.000',
        text: 'The workshop opens at dawn.',
        cues: [{ index: 0, startMs: 25_000, endMs: 28_000, text: 'The workshop opens at dawn.' }],
      },
    ])
  })

  it('preserves exact cue ranges when overlapping ranked chunks fetch a shared cue twice', () => {
    const results = mapSearchResults([
      {
        movie_id: 7,
        movie_title: 'Synthetic Night Walk',
        movie_release_year: null,
        track_id: 11,
        chunk_index: 0,
        start_ms: 0,
        end_ms: 4_000,
        text: 'First overlapping chunk.',
        first_cue_index: 0,
        last_cue_index: 1,
        similarity: 0.9,
      },
      {
        movie_id: 7,
        movie_title: 'Synthetic Night Walk',
        movie_release_year: null,
        track_id: 11,
        chunk_index: 1,
        start_ms: 2_000,
        end_ms: 6_000,
        text: 'Second overlapping chunk.',
        first_cue_index: 1,
        last_cue_index: 2,
        similarity: 0.8,
      },
    ], [
      { track_id: 11, cue_index: 0, start_ms: 0, end_ms: 2_000, text: 'First cue.' },
      { track_id: 11, cue_index: 1, start_ms: 2_000, end_ms: 4_000, text: 'Shared cue.' },
      { track_id: 11, cue_index: 1, start_ms: 2_000, end_ms: 4_000, text: 'Shared cue.' },
      { track_id: 11, cue_index: 2, start_ms: 4_000, end_ms: 6_000, text: 'Last cue.' },
    ])

    expect(results.map(result => result.cues.map(cue => cue.index))).toEqual([[0, 1], [1, 2]])
  })
})

describe('search Edge entry contract', () => {
  it('authenticates before creating the database client or running query inference', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'supabase/functions/search-subtitles/index.ts'),
      'utf8',
    )

    expect(source).toContain("import 'jsr:@supabase/functions-js/edge-runtime.d.ts'")
    expect(source).toContain("new Supabase.ai.Session('gte-small')")
    expect(source).toContain('handleAuthenticatedRequest(request, Deno.env')
    expect(source).toContain("embeddingSession.run(input.query, { mean_pool: true, normalize: true })")
    expect(source).toContain('errorResponse(400, error.code, error.message)')
    expect(source).toContain("client.rpc('match_subtitle_chunks'")
    expect(source).toContain(".eq('track_id', row.track_id)")
    expect(source).toContain(".gte('cue_index', row.first_cue_index)")
    expect(source).toContain(".lte('cue_index', row.last_cue_index)")
  })
})

function requestErrorFor(input: unknown): Error {
  try {
    parseSearchRequest(input)
  } catch (error) {
    if (error instanceof Error) {
      return error
    }
  }
  throw new Error('expected search request validation to fail')
}
