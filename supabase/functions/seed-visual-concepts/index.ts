import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.110.2'
import { errorResponse, handleAuthenticatedRequest, jsonResponse } from '../_shared/http.ts'
import { seedVisualConcepts } from '../_shared/visual-concept-seeds.ts'

Deno.serve(async request => {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'only POST is supported')
  }

  return await handleAuthenticatedRequest(request, Deno.env, async () => {
    try {
      const session = new Supabase.ai.Session('gte-small')
      const client = createClient(
        requiredEnvironment('SUPABASE_URL'),
        requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      )
      const result = await seedVisualConcepts({
        session,
        client,
      })
      return jsonResponse(result)
    } catch {
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
