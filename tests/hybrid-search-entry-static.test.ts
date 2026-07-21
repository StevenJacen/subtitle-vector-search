import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const entryPath = resolve(
  process.cwd(),
  'supabase/functions/hybrid-subtitle-search/index.ts',
)

describe('hybrid subtitle search Edge entry', () => {
  it('uses pinned Supabase imports and authenticates before inference', () => {
    const source = readFileSync(entryPath, 'utf8')

    expect(source).toContain("import 'jsr:@supabase/functions-js/edge-runtime.d.ts'")
    expect(source).toContain("from 'npm:@supabase/supabase-js@2.110.2'")
    expect(source).toContain("new Supabase.ai.Session('gte-small')")
    expect(source).toContain('parseHybridSearchRequest')
    expect(source).toContain('parseHybridSearchRequest(await request.json())')
    expect(source).toContain('handleAuthenticatedRequest(request, Deno.env')
    expect(source.indexOf('handleAuthenticatedRequest(request, Deno.env'))
      .toBeLessThan(source.indexOf('embeddingSession.run'))
    expect(source).toContain(
      "embeddingSession.run(input.query, { mean_pool: true, normalize: true })",
    )
  })

  it('calls the private RRF RPC with the fixed experiment controls', () => {
    const source = readFileSync(entryPath, 'utf8')

    expect(source).toContain("client.rpc('hybrid_match_subtitle_chunks'")
    for (const parameter of [
      'query_text: input.query',
      'query_embedding: embedding',
      'match_count: input.limit',
      'full_text_weight: 1',
      'semantic_weight: 2',
      'rrf_k: 50',
      'filter_movie_id: input.movieId ?? null',
    ]) {
      expect(source).toContain(parameter)
    }
  })

  it('hydrates only matched cue ranges and returns controlled errors', () => {
    const source = readFileSync(entryPath, 'utf8')

    expect(source).toContain(".from('subtitle_cues')")
    expect(source).toContain(".eq('track_id', row.track_id)")
    expect(source).toContain(".gte('cue_index', row.first_cue_index)")
    expect(source).toContain(".lte('cue_index', row.last_cue_index)")
    expect(source).toContain("errorResponse(405, 'method_not_allowed'")
    expect(source).toContain("errorResponse(422, 'empty_ready_track'")
    expect(source).toContain('errorResponse(400, error.code, error.message)')
    expect(source).toContain("errorResponse(500, 'hybrid_search_failed'")
    expect(source).not.toContain('console.log')
    expect(source).not.toContain('console.error')
  })
})
