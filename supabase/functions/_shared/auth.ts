export interface TokenEnvironment {
  get(name: string): string | undefined
}

export type AuthenticationResult =
  | { ok: true }
  | { ok: false; error: { code: 'unauthorized'; message: 'invalid subtitle token' } }

const unauthorized: AuthenticationResult = {
  ok: false,
  error: { code: 'unauthorized', message: 'invalid subtitle token' },
}

export async function authenticateRequest(
  request: Request,
  environment: TokenEnvironment,
): Promise<AuthenticationResult> {
  const expectedToken = environment.get('SUBTITLE_PERSONAL_TOKEN')
  const receivedToken = request.headers.get('x-subtitle-token')

  if (expectedToken === undefined || expectedToken.trim() === '' || receivedToken === null) {
    return unauthorized
  }

  return await constantTimeTokenEquals(expectedToken, receivedToken) ? { ok: true } : unauthorized
}

export async function constantTimeTokenEquals(expected: string, received: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [expectedHash, receivedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
    crypto.subtle.digest('SHA-256', encoder.encode(received)),
  ])
  const expectedBytes = new Uint8Array(expectedHash)
  const receivedBytes = new Uint8Array(receivedHash)
  let difference = 0

  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= expectedBytes[index] ^ receivedBytes[index]
  }

  return difference === 0
}
