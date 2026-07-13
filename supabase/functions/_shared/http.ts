import { authenticateRequest, type TokenEnvironment } from './auth.ts'

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status)
}

export async function handleAuthenticatedRequest(
  request: Request,
  environment: TokenEnvironment,
  onAuthenticated: () => Promise<Response>,
): Promise<Response> {
  const authentication = await authenticateRequest(request, environment)
  if (!authentication.ok) {
    return errorResponse(401, authentication.error.code, authentication.error.message)
  }
  return await onAuthenticated()
}
