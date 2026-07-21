import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectReadyMovieIds, READY_TRACK_PAGE_SIZE } from '../supabase/functions/_shared/subtitle-library.js'

const entryPath = resolve(process.cwd(), 'supabase/functions/subtitle-library/index.ts')

describe('subtitle library Edge entry', () => {
  it('returns sanitized ready-library counts behind personal-token auth', () => {
    expect(existsSync(entryPath)).toBe(true)
    const source = readFileSync(entryPath, 'utf8')

    expect(source).toContain("Deno.serve(async request =>")
    expect(source).toContain("errorResponse(405, 'method_not_allowed'")
    expect(source).toContain('handleAuthenticatedRequest(request, Deno.env')
    expect(source.indexOf('handleAuthenticatedRequest(request, Deno.env'))
      .toBeLessThan(source.indexOf('createServiceClient()'))
    expect(source).toContain("required('SUPABASE_SERVICE_ROLE_KEY')")
    expect(source).toContain(".from('subtitle_tracks')")
    expect(source).toContain(".eq('status', 'ready')")
    expect(source).toContain(".select('movie_id', { count: 'exact' })")
    expect(source).toContain(".range(offset, offset + READY_TRACK_PAGE_SIZE - 1)")
    expect(source).toContain('return jsonResponse({ readyTracks: tracks.count ?? 0, readyMovies: movies.size })')
    expect(source).not.toContain('serviceRoleKey:')
    expect(source).not.toContain('jsonResponse({ tracks')
    expect(source).not.toContain('console.log')
    expect(source).not.toContain('console.error')
  })

  it('collects ready movie IDs from every bounded PostgREST page', async () => {
    const page = Array.from({ length: READY_TRACK_PAGE_SIZE }, (_, index) => ({ movie_id: index + 1 }))
    const loadPage = async (offset: number) => offset === 0
      ? page
      : [{ movie_id: READY_TRACK_PAGE_SIZE }, { movie_id: READY_TRACK_PAGE_SIZE + 1 }]

    await expect(collectReadyMovieIds(loadPage)).resolves.toEqual(new Set(
      Array.from({ length: READY_TRACK_PAGE_SIZE + 1 }, (_, index) => index + 1),
    ))
  })
})
