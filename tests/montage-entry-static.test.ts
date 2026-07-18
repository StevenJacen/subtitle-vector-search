import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'supabase/functions/movie-quote-montage/index.ts'),
  'utf8',
)

describe('movie quote montage Edge entry', () => {
  it('authenticates before inference and uses the pinned runtime', () => {
    expect(source).toContain("import 'jsr:@supabase/functions-js/edge-runtime.d.ts'")
    expect(source).toContain("from 'npm:@supabase/supabase-js@2.110.2'")
    expect(source).toContain("new Supabase.ai.Session('gte-small')")
    expect(source.indexOf('handleAuthenticatedRequest(request, Deno.env')).toBeLessThan(source.indexOf('embeddingSession.run'))
    expect(source).toContain('{ mean_pool: true, normalize: true }')
  })

  it('calls the private RPC with every retrieval control', () => {
    expect(source).toContain("client.rpc('search_movie_quote_montage'")
    for (const name of ['query_embedding', 'match_threshold', 'match_count', 'max_per_movie', 'filter_movie_ids']) {
      expect(source).toContain(name)
    }
  })

  it('returns stable errors without raw database details', () => {
    expect(source).toContain("errorResponse(500, 'montage_failed', 'movie quote montage failed')")
    expect(source).not.toContain('result.error.message')
  })
})
