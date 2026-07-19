import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.110.2'
import type { TokenEnvironment } from '../_shared/auth.ts'
import { createVideoProductionRepository } from '../_shared/video-production-repository.ts'
import { handleVideoProductionRequest } from '../_shared/video-production-handler.ts'

Deno.serve(async request => await handleVideoProductionRequest(
  request,
  Deno.env,
  () => createProductionRepository(Deno.env),
))

function createProductionRepository(environment: TokenEnvironment) {
  const client = createClient(
    requiredEnvironment(environment, 'SUPABASE_URL'),
    requiredEnvironment(environment, 'SUPABASE_SERVICE_ROLE_KEY'),
  )
  return createVideoProductionRepository(client)
}

function requiredEnvironment(environment: TokenEnvironment, name: string): string {
  const value = environment.get(name)
  if (value === undefined || value.trim() === '') {
    throw new Error('missing configuration')
  }
  return value
}
