import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.110.2'
import type { TokenEnvironment } from '../_shared/auth.ts'
import { createVideoAssetRepository } from '../_shared/video-asset-repository.ts'
import { handleSelectVideoAssetRequest } from '../_shared/video-asset-selection.ts'

Deno.serve(async request => await handleSelectVideoAssetRequest(
  request,
  Deno.env,
  () => createSelectionRepository(Deno.env),
))

function createSelectionRepository(environment: TokenEnvironment) {
  const client = createClient(
    requiredEnvironment(environment, 'SUPABASE_URL'),
    requiredEnvironment(environment, 'SUPABASE_SERVICE_ROLE_KEY'),
  )
  return createVideoAssetRepository(client)
}

function requiredEnvironment(environment: TokenEnvironment, name: string): string {
  const value = environment.get(name)
  if (value === undefined || value.trim() === '') {
    throw new Error('missing configuration')
  }
  return value
}
