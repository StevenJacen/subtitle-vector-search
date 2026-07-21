import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.110.2'
import {
  mapHybridSearchResults,
  type HybridMatchSubtitleChunkRow,
} from '../_shared/hybrid-search.ts'
import {
  assertQueryEmbedding,
  parseHybridSearchRequest,
  type SearchRequest,
  type SubtitleCueRow,
  SearchRequestError,
} from '../_shared/search.ts'
import { errorResponse, handleAuthenticatedRequest, jsonResponse } from '../_shared/http.ts'

const embeddingSession = new Supabase.ai.Session('gte-small')

Deno.serve(async request => {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'only POST is supported')
  }

  return await handleAuthenticatedRequest(request, Deno.env, async () => {
    try {
      const input = parseHybridSearchRequest(await request.json())
      const client = createServiceClient()
      return jsonResponse(await hybridSearch(client, input))
    } catch (error) {
      if (error instanceof EmptyReadyTrackError) {
        return errorResponse(422, 'empty_ready_track', 'no ready subtitle track is available')
      }
      if (error instanceof SearchRequestError) {
        return errorResponse(400, error.code, error.message)
      }
      if (error instanceof SyntaxError) {
        return errorResponse(400, 'invalid_request', 'invalid request')
      }
      return errorResponse(500, 'hybrid_search_failed', 'hybrid subtitle search failed')
    }
  })
})

function createServiceClient() {
  return createClient(
    requiredEnvironment('SUPABASE_URL'),
    requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
  )
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)
  if (value === undefined || value.trim() === '') {
    throw new Error('missing configuration')
  }
  return value
}

async function hybridSearch(
  client: any,
  input: SearchRequest,
): Promise<{ results: ReturnType<typeof mapHybridSearchResults> }> {
  const embedding = assertQueryEmbedding(
    await embeddingSession.run(input.query, { mean_pool: true, normalize: true }),
  )
  const rows = await data<HybridMatchSubtitleChunkRow[]>(client.rpc('hybrid_match_subtitle_chunks', {
    query_text: input.query,
    query_embedding: embedding,
    match_count: input.limit,
    full_text_weight: 1,
    semantic_weight: 2,
    rrf_k: 50,
    filter_movie_id: input.movieId ?? null,
  }))

  if (rows.length === 0) {
    await requireReadyTrack(client, input.movieId)
    return { results: [] }
  }

  const cueRows = (await Promise.all(rows.map(async row => await data<SubtitleCueRow[]>(
    client
      .from('subtitle_cues')
      .select('track_id, cue_index, start_ms, end_ms, text')
      .eq('track_id', row.track_id)
      .gte('cue_index', row.first_cue_index)
      .lte('cue_index', row.last_cue_index)
      .order('cue_index', { ascending: true }),
  )))).flat()

  return { results: mapHybridSearchResults(rows, cueRows) }
}

async function requireReadyTrack(client: any, movieId: number | undefined): Promise<void> {
  let query = client
    .from('subtitle_tracks')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'ready')
  if (movieId !== undefined) {
    query = query.eq('movie_id', movieId)
  }
  const result = await query
  if (result.error !== null || result.count === null) {
    throw new Error('database operation failed')
  }
  if (result.count === 0) {
    throw new EmptyReadyTrackError()
  }
}

async function data<T>(query: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  const result = await query
  if (result.error !== null) {
    throw new Error('database operation failed')
  }
  return result.data
}

class EmptyReadyTrackError extends Error {}
