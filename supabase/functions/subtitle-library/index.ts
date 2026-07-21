import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.110.2'
import { errorResponse, handleAuthenticatedRequest, jsonResponse } from '../_shared/http.ts'

Deno.serve(async request => {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'only POST is supported')
  }

  return await handleAuthenticatedRequest(request, Deno.env, async () => {
    try {
      const client = createServiceClient()
      const tracks = await client
        .from('subtitle_tracks')
        .select('movie_id', { count: 'exact' })
        .eq('status', 'ready')
      if (tracks.error !== null) throw new Error('database operation failed')
      const movies = new Set((tracks.data ?? []).map(row => row.movie_id))
      return jsonResponse({ readyTracks: tracks.count ?? 0, readyMovies: movies.size })
    } catch {
      return errorResponse(500, 'library_summary_failed', 'subtitle library summary failed')
    }
  })
})

function createServiceClient() {
  return createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'))
}

function required(name: string): string {
  const value = Deno.env.get(name)
  if (value === undefined || value.trim() === '') throw new Error('missing configuration')
  return value
}
