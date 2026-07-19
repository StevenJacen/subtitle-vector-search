import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.110.2'
import { errorResponse, handleAuthenticatedRequest, jsonResponse } from '../_shared/http.ts'
import { seedVisualConcepts, VisualConceptSeedIndexError } from '../_shared/visual-concept-seeds.ts'

const embeddingSession = new Supabase.ai.Session('gte-small')

Deno.serve(async request => {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'only POST is supported')
  }

  return await handleAuthenticatedRequest(request, Deno.env, async () => {
    try {
      const index = new URL(request.url).searchParams.get('index')
      const client = createClient(
        requiredEnvironment('SUPABASE_URL'),
        requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      )
      const result = await seedVisualConcepts({
        session: embeddingSession,
        client,
      }, index)
      return jsonResponse(result)
    } catch (error) {
      if (error instanceof VisualConceptSeedIndexError) {
        return errorResponse(400, 'invalid_seed_index', 'index must be an integer from 0 to 23')
      }
      return errorResponse(500, 'visual_concept_seed_failed', 'visual concept seed failed')
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
