import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.110.2'
import {
  assertMontageEmbedding,
  buildMontageResponse,
  MontageRequestError,
  parseMontageRequest,
} from '../_shared/montage.ts'
import type { MatchSubtitleChunkRow } from '../_shared/search.ts'
import { errorResponse, handleAuthenticatedRequest, jsonResponse } from '../_shared/http.ts'

const embeddingSession = new Supabase.ai.Session('gte-small')

Deno.serve(async request => {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'only POST is supported')
  }

  return await handleAuthenticatedRequest(request, Deno.env, async () => {
    try {
      const input = parseMontageRequest(await request.json())
      const embedding = assertMontageEmbedding(
        await embeddingSession.run(input.theme, { mean_pool: true, normalize: true }),
      )
      const client = createClient(
        requiredEnvironment('SUPABASE_URL'),
        requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      )
      const result = await client.rpc('search_movie_quote_montage', {
        query_embedding: embedding,
        match_threshold: input.matchThreshold,
        match_count: input.quoteCount,
        max_per_movie: input.maxPerMovie,
        filter_movie_ids: input.movieIds ?? null,
      })
      if (result.error !== null) {
        throw new Error('database operation failed')
      }
      return jsonResponse(buildMontageResponse(input.theme, result.data as MatchSubtitleChunkRow[]))
    } catch (error) {
      if (error instanceof MontageRequestError) {
        return errorResponse(400, error.code, error.message)
      }
      if (error instanceof SyntaxError) {
        return errorResponse(400, 'invalid_request', 'invalid request')
      }
      return errorResponse(500, 'montage_failed', 'movie quote montage failed')
    }
  })
})

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)
  if (value === undefined || value.trim() === '') {
    throw new Error('missing configuration')
  }
  return value
}
