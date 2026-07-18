import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.110.2'
import type { TokenEnvironment } from '../_shared/auth.ts'
import { errorResponse, handleAuthenticatedRequest, jsonResponse } from '../_shared/http.ts'
import { createVideoAssetRepository } from '../_shared/video-asset-repository.ts'
import { parseSelectionRequest, VideoAssetError } from '../_shared/video-assets.ts'

Deno.serve(async request => {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'only POST is supported')
  }

  return await handleAuthenticatedRequest(request, Deno.env, async () => {
    try {
      const input = parseSelectionRequest(await request.json())
      const repository = createSelectionRepository(Deno.env)
      const selection = await repository.selectCandidate(input)
      return jsonResponse({
        runId: input.runId,
        providerResourceId: input.providerResourceId,
        selectionId: selection.selectionId,
      })
    } catch (error) {
      if (isCandidateOwnershipError(error)) {
        return errorResponse(404, 'candidate_not_found', 'candidate not found')
      }
      if (error instanceof VideoAssetError || error instanceof SyntaxError) {
        return errorResponse(400, 'invalid_request', 'invalid request')
      }
      return errorResponse(500, 'selection_failed', 'selection failed')
    }
  })
})

function createSelectionRepository(environment: TokenEnvironment) {
  const client = createClient(
    requiredEnvironment(environment, 'SUPABASE_URL'),
    requiredEnvironment(environment, 'SUPABASE_SERVICE_ROLE_KEY'),
  )
  return createVideoAssetRepository({
    from: client.from.bind(client),
    async rpc(name, arguments_) {
      const result = await client.rpc(name, arguments_)
      if (name === 'select_video_asset' && isCandidateOwnershipError(result.error)) {
        throw new VideoAssetError(404, 'candidate_not_found', 'candidate not found')
      }
      return result
    },
  })
}

function requiredEnvironment(environment: TokenEnvironment, name: string): string {
  const value = environment.get(name)
  if (value === undefined || value.trim() === '') {
    throw new Error('missing configuration')
  }
  return value
}

function isCandidateOwnershipError(error: unknown): boolean {
  if (error instanceof VideoAssetError) {
    return error.status === 404 && error.code === 'candidate_not_found'
  }
  if (typeof error !== 'object' || error === null || Array.isArray(error)) {
    return false
  }
  return (error as { code?: unknown }).code === 'P0002'
}
