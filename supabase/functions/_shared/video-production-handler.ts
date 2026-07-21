import type { TokenEnvironment } from './auth.ts'
import { errorResponse, handleAuthenticatedRequest, jsonResponse } from './http.ts'
import type { VideoProductionRepository } from './video-production-repository.ts'
import { parseVideoProductionRequest, VideoProductionError } from './video-production.ts'
import { parseVideoProductionV2Request } from './video-production-v2.ts'

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
      const value: unknown = await request.json()
      const action = typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>).action
        : undefined
      const input = typeof action === 'string' && action.endsWith('V2')
        ? parseVideoProductionV2Request(value)
        : parseVideoProductionRequest(value)
      const repository = createRepository()
      switch (input.action) {
        case 'start': return jsonResponse(await repository.start(input))
        case 'recordDownload': return jsonResponse(await repository.recordDownload(input))
        case 'beginRender': return jsonResponse(await repository.beginRender(input.renderId))
        case 'complete': return jsonResponse(await repository.complete(input))
        case 'fail': return jsonResponse(await repository.fail(input))
        case 'retry': return jsonResponse(await repository.retry(input.renderId))
        case 'startV2': return jsonResponse(await repository.startV2(input))
        case 'recordDownloadV2': return jsonResponse(await repository.recordDownloadV2(input))
        case 'beginRenderV2': return jsonResponse(await repository.beginRenderV2(input.renderId))
        case 'completeV2': return jsonResponse(await repository.completeV2(input))
        case 'failV2': return jsonResponse(await repository.failV2(input))
        case 'retryV2': return jsonResponse(await repository.retryV2(input.renderId))
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
