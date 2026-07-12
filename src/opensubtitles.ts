const apiBaseUrl = 'https://api.opensubtitles.com/api/v1'
const maxAttempts = 3

export interface SubtitleCandidate {
  subtitleId: string
  fileId: number
  fileName: string
  language: string
}

export interface DownloadedSubtitle {
  fileName: string
  bytes: Uint8Array
}

export interface OpenSubtitlesClientConfig {
  apiKey: string
  token: string
  userAgent: string
  fetchFn?: typeof fetch
  delayFn?: (milliseconds: number) => Promise<void>
}

export class OpenSubtitlesApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: OpenSubtitlesErrorCode,
  ) {
    super(message)
    this.name = 'OpenSubtitlesApiError'
  }
}

type OpenSubtitlesErrorCode = 'unauthorized' | 'forbidden' | 'not_found' | 'not_acceptable' | 'rate_limited' | 'server_error' | 'request_failed'

export class OpenSubtitlesClient {
  private readonly fetchFn: typeof fetch
  private readonly delayFn: (milliseconds: number) => Promise<void>

  constructor(private readonly config: OpenSubtitlesClientConfig) {
    this.fetchFn = config.fetchFn ?? fetch
    this.delayFn = config.delayFn ?? defaultDelay
  }

  async searchEnglishByImdb(imdbId: string): Promise<SubtitleCandidate[]> {
    const url = new URL(`${apiBaseUrl}/subtitles`)
    url.searchParams.set('imdb_id', imdbId)
    url.searchParams.set('languages', 'en')
    const response = await this.request(url.toString())
    const body = await response.json() as SearchResponse
    const candidates = body.data.flatMap(subtitle => subtitle.attributes.files.map(file => ({
      subtitleId: subtitle.id,
      fileId: file.file_id,
      fileName: file.file_name,
      language: subtitle.attributes.language,
    })))

    if (body.data.length > 0 && candidates.length === 0) {
      throw new Error('no downloadable subtitle files found')
    }

    return candidates
  }

  async downloadFile(fileId: number): Promise<DownloadedSubtitle> {
    const response = await this.request(`${apiBaseUrl}/download`, {
      method: 'POST',
      body: JSON.stringify({ file_id: fileId }),
    })
    const body = await response.json() as DownloadResponse
    if (typeof body.link !== 'string' || typeof body.file_name !== 'string') {
      throw new Error('OpenSubtitles download response is missing a file link')
    }

    const fileResponse = await this.fetchFn(body.link)
    if (!fileResponse.ok) {
      throw await this.toError(fileResponse)
    }

    return {
      fileName: body.file_name,
      bytes: new Uint8Array(await fileResponse.arrayBuffer()),
    }
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    let response: Response | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      response = await this.fetchFn(url, {
        ...init,
        headers: {
          'Api-Key': this.config.apiKey,
          Authorization: `Bearer ${this.config.token}`,
          'User-Agent': this.config.userAgent,
          'content-type': 'application/json',
          ...init.headers,
        },
      })

      if (response.ok) return response
      if (!isRetryable(response.status) || attempt === maxAttempts) {
        throw await this.toError(response)
      }

      await this.delayFn(retryDelayMilliseconds(response, attempt))
    }

    throw new Error('OpenSubtitles request did not receive a response')
  }

  private async toError(response: Response): Promise<OpenSubtitlesApiError> {
    const body = await response.json().catch(() => undefined) as { message?: unknown } | undefined
    const message = typeof body?.message === 'string' ? body.message : `OpenSubtitles request failed with HTTP ${response.status}`
    return new OpenSubtitlesApiError(message, response.status, errorCodeForStatus(response.status))
  }
}

interface SearchResponse {
  data: Array<{
    id: string
    attributes: {
      language: string
      files: Array<{ file_id: number; file_name: string }>
    }
  }>
}

interface DownloadResponse {
  link?: unknown
  file_name?: unknown
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500 && status <= 599
}

function retryDelayMilliseconds(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('Retry-After')
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000
  }

  const retryAt = retryAfter === null ? Number.NaN : Date.parse(retryAfter)
  if (Number.isFinite(retryAt)) {
    return Math.max(0, retryAt - Date.now())
  }

  return 1_000 * 2 ** (attempt - 1)
}

function errorCodeForStatus(status: number): OpenSubtitlesErrorCode {
  switch (status) {
    case 401: return 'unauthorized'
    case 403: return 'forbidden'
    case 404: return 'not_found'
    case 406: return 'not_acceptable'
    case 429: return 'rate_limited'
    default: return status >= 500 && status <= 599 ? 'server_error' : 'request_failed'
  }
}

async function defaultDelay(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds))
}
