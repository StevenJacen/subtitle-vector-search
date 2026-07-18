import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260718023039_movie_quote_montage.sql'),
  'utf8',
)

describe('movie quote montage migration', () => {
  it('defines a thresholded cosine search over ready subtitle chunks', () => {
    expect(source).toContain('create or replace function public.search_movie_quote_montage')
    expect(source).toContain('chunk.embedding operator(extensions.<=>) query_embedding')
    expect(source).toContain("track.status = 'ready'")
    expect(source).toContain('1 - parameters.threshold')
  })

  it('limits each movie before applying the final result count', () => {
    expect(source).toContain('partition by candidates.movie_id')
    expect(source).toContain('diversified.movie_rank <= parameters.movie_limit')
    expect(source).toContain('limit (select result_count from parameters)')
  })

  it('keeps the RPC security-invoker and service-role only', () => {
    expect(source).toContain('security invoker')
    expect(source).toContain("set search_path = ''")
    expect(source).toContain('revoke all on function public.search_movie_quote_montage')
    expect(source).toContain('to service_role')
    expect(source).not.toContain('security definer')
  })
})
