import type { TokenEnvironment } from './auth.ts'
import { errorResponse, handleAuthenticatedRequest, jsonResponse } from './http.ts'
import type { VideoProductionRepository } from './video-production-repository.ts'
import { parseVideoProductionRequest, VideoProductionError } from './video-production.ts'

export async function handleVideoProductionRequest(
  request: Request,
  environment: TokenEnvironment,
  createRepository: () => VideoProductionRepository,
): Promise<Response> {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'only POST is supported')
  }

  return await handleAuthenticatedRequest(request, environment, async () => {
    try {
      const input = parseVideoProductionRequest(await request.json())
      const repository = createRepository()
      switch (input.action) {
        case 'start': return jsonResponse(await repository.start(input))
        case 'recordDownload': return jsonResponse(await repository.recordDownload(input))
        case 'beginRender': return jsonResponse(await repository.beginRender(input.renderId))
        case 'complete': return jsonResponse(await repository.complete(input))
        case 'fail': return jsonResponse(await repository.fail(input))
        case 'retry': return jsonResponse(await repository.retry(input.renderId))
      }
    } catch (error) {
      if (error instanceof VideoProductionError) {
        return errorResponse(error.status, error.code, error.message)
      }
      if (error instanceof SyntaxError) {
        return errorResponse(400, 'invalid_request', 'invalid request')
      }
      return errorResponse(500, 'production_metadata_failed', 'production metadata failed')
    }
  })
}
