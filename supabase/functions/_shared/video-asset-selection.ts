import type { TokenEnvironment } from './auth.ts'
import { errorResponse, handleAuthenticatedRequest, jsonResponse } from './http.ts'
import type { VideoAssetRepository } from './video-asset-repository.ts'
import { parseSelectionRequest, VideoAssetError } from './video-assets.ts'

type SelectionRepository = Pick<VideoAssetRepository, 'selectCandidate'>

export async function handleSelectVideoAssetRequest(
  request: Request,
  environment: TokenEnvironment,
  createRepository: () => SelectionRepository,
): Promise<Response> {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'only POST is supported')
  }

  return await handleAuthenticatedRequest(request, environment, async () => {
    try {
      const input = parseSelectionRequest(await request.json())
      const selection = await createRepository().selectCandidate(input)
      return jsonResponse({
        runId: input.runId,
        providerResourceId: input.providerResourceId,
        selectionId: selection.selectionId,
      })
    } catch (error) {
      if (error instanceof VideoAssetError
        && error.status === 404
        && error.code === 'candidate_not_found') {
        return errorResponse(404, 'candidate_not_found', 'candidate not found')
      }
      if (error instanceof VideoAssetError
        && error.status === 409
        && error.code === 'selection_locked') {
        return errorResponse(409, 'selection_locked', 'selected asset is already downloaded')
      }
      if (error instanceof VideoAssetError
        && error.status === 400
        && error.code === 'invalid_request') {
        return errorResponse(400, 'invalid_request', 'invalid request')
      }
      if (error instanceof SyntaxError) {
        return errorResponse(400, 'invalid_request', 'invalid request')
      }
      return errorResponse(500, 'selection_failed', 'selection failed')
    }
  })
}
