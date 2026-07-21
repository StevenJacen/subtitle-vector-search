import type { PassageCue } from './passage-selection.js'

export interface PlannedCue {
  captionZh: string
  visualConcept: string
  mood?: string
  action?: string
  setting?: string
  lighting?: string
}

export type OllamaPlanErrorCode =
  | 'invalid_configuration'
  | 'invalid_output'
  | 'forbidden_content'
  | 'timeout'
  | 'redirect_rejected'
  | 'response_too_large'
  | 'provider_unavailable'
  | 'invalid_response'

export class OllamaPlanError extends Error {
  constructor(readonly code: OllamaPlanErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'OllamaPlanError'
  }
}

interface PassagePlanContext {
  movieTitle: string
  characterNames?: readonly string[]
}

export interface PlanPassageInput {
  endpoint: URL
  model: string
  cues: readonly PassageCue[]
  movieTitle: string
  characterNames?: readonly string[]
  fetchFn?: typeof fetch
}

const ERROR_MESSAGES: Record<OllamaPlanErrorCode, string> = {
  invalid_configuration: 'Ollama planner configuration is invalid',
  invalid_output: 'Ollama plan output is invalid',
  forbidden_content: 'Ollama plan output contains forbidden content',
  timeout: 'Ollama planner timed out',
  redirect_rejected: 'Ollama planner redirect was rejected',
  response_too_large: 'Ollama planner response is too large',
  provider_unavailable: 'Ollama planner is unavailable',
  invalid_response: 'Ollama planner response is invalid',
}

const REQUIRED_KEYS = ['captionZh', 'index', 'visualConcept'] as const
const OPTIONAL_KEYS = ['action', 'lighting', 'mood', 'setting'] as const
const ALLOWED_KEYS = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS])
const VISUAL_KEYS = ['visualConcept', ...OPTIONAL_KEYS] as const
const RESPONSE_BYTE_LIMIT = 128 * 1024
const REQUEST_TIMEOUT_MS = 60_000
const MAX_REDIRECTS = 3

export function buildPassagePrompt(cues: readonly PassageCue[]): string {
  const indexedCues = cues.map((cue, index) => ({ index, text: cue.text }))
  return [
    'Translate each indexed subtitle cue into Chinese and derive generic stock-video concepts.',
    'Return only a JSON array with the same item count and order as the input.',
    'Each item must contain exactly index, captionZh, visualConcept and may contain mood, action, setting, lighting.',
    'captionZh must be Chinese. All visual fields must be concise generic English.',
    'Do not return or repeat the English cue text.',
    'Do not mention movies, characters, brands, providers, or URLs in visual fields.',
    `Input cues: ${JSON.stringify(indexedCues)}`,
  ].join('\n')
}

export function parsePassagePlan(
  value: unknown,
  cues: readonly PassageCue[],
  context: PassagePlanContext,
): PlannedCue[] {
  if (typeof context.movieTitle !== 'string'
    || context.movieTitle.trim().length === 0
    || !Array.isArray(value)
    || value.length !== cues.length) {
    throw new OllamaPlanError('invalid_output')
  }

  return value.map((candidate, index) => parsePlannedCue(candidate, index, cues, context))
}

export async function planPassageWithOllama(input: PlanPassageInput): Promise<PlannedCue[]> {
  const endpoint = configuredEndpoint(input.endpoint)
  if (typeof input.model !== 'string'
    || input.model.trim().length === 0
    || typeof input.movieTitle !== 'string'
    || input.movieTitle.trim().length === 0) {
    throw new OllamaPlanError('invalid_configuration')
  }

  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const request = input.fetchFn ?? globalThis.fetch.bind(globalThis)
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: input.model.trim(),
      prompt: buildPassagePrompt(input.cues),
      stream: false,
      format: 'json',
    }),
    redirect: 'manual',
    signal,
  }

  const response = await requestWithRedirects(request, endpoint, init, signal)
  if (!response.ok) {
    await cancelResponseBody(response)
    throw new OllamaPlanError('provider_unavailable')
  }

  const body = await readBoundedBody(response, signal)
  let envelope: unknown
  try {
    envelope = JSON.parse(body)
  } catch {
    throw new OllamaPlanError('invalid_response')
  }
  if (!record(envelope) || 'error' in envelope || typeof envelope.response !== 'string') {
    throw new OllamaPlanError('invalid_response')
  }

  let output: unknown
  try {
    output = JSON.parse(unwrapJsonFence(envelope.response))
  } catch {
    throw new OllamaPlanError('invalid_response')
  }

  try {
    return parsePassagePlan(output, input.cues, {
      movieTitle: input.movieTitle,
      ...(input.characterNames === undefined ? {} : { characterNames: input.characterNames }),
    })
  } catch (error) {
    if (error instanceof OllamaPlanError
      && (error.code === 'invalid_output' || error.code === 'forbidden_content')) {
      throw error
    }
    throw new OllamaPlanError('invalid_response')
  }
}

function parsePlannedCue(
  value: unknown,
  expectedIndex: number,
  cues: readonly PassageCue[],
  context: PassagePlanContext,
): PlannedCue {
  if (!record(value)
    || Object.keys(value).some(key => !ALLOWED_KEYS.has(key))
    || REQUIRED_KEYS.some(key => !(key in value))
    || value.index !== expectedIndex
    || typeof value.captionZh !== 'string'
    || typeof value.visualConcept !== 'string') {
    throw new OllamaPlanError('invalid_output')
  }

  const captionZh = value.captionZh.trim()
  if (!validChinese(captionZh)) {
    throw new OllamaPlanError('invalid_output')
  }
  if (containsExternalReference(captionZh, cues, context)) {
    throw new OllamaPlanError('forbidden_content')
  }

  const visualValues = new Map<(typeof VISUAL_KEYS)[number], string>()
  for (const key of VISUAL_KEYS) {
    if (!(key in value)) {
      continue
    }
    const candidate = value[key]
    if (typeof candidate !== 'string') {
      throw new OllamaPlanError('invalid_output')
    }
    const trimmed = candidate.trim()
    if (containsForbiddenContent(trimmed, captionZh, cues, context)) {
      throw new OllamaPlanError('forbidden_content')
    }
    if (!validGenericEnglish(trimmed)) {
      throw new OllamaPlanError('invalid_output')
    }
    visualValues.set(key, trimmed)
  }

  const visualConcept = visualValues.get('visualConcept')
  if (visualConcept === undefined) {
    throw new OllamaPlanError('invalid_output')
  }

  return {
    captionZh,
    visualConcept,
    ...optionalValue('mood', visualValues),
    ...optionalValue('action', visualValues),
    ...optionalValue('setting', visualValues),
    ...optionalValue('lighting', visualValues),
  }
}

function optionalValue<K extends (typeof OPTIONAL_KEYS)[number]>(
  key: K,
  values: ReadonlyMap<(typeof VISUAL_KEYS)[number], string>,
): Partial<Record<K, string>> {
  const value = values.get(key)
  return value === undefined ? {} : { [key]: value } as Partial<Record<K, string>>
}

function validChinese(value: string): boolean {
  return value.length > 0
    && value.length <= 2_000
    && /\p{Script=Han}/u.test(value)
    && !/[\u0000-\u001F\u007F]/.test(value)
}

function validGenericEnglish(value: string): boolean {
  return value.length > 0
    && value.length <= 500
    && /^[\x20-\x7E]+$/.test(value)
    && /[A-Za-z]/.test(value)
}

function containsForbiddenContent(
  value: string,
  captionZh: string,
  cues: readonly PassageCue[],
  context: PassagePlanContext,
): boolean {
  if (containsExternalReference(value, cues, context)) {
    return true
  }
  return containsNormalizedPhrase(value, captionZh)
}

function containsExternalReference(
  value: string,
  cues: readonly PassageCue[],
  context: PassagePlanContext,
): boolean {
  if (/\b(?:https?:\/\/|www\.)/i.test(value)
    || /\bvecteezy\b/i.test(value)
    || /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?/i.test(value)) {
    return true
  }

  const forbiddenTerms = [context.movieTitle, ...(context.characterNames ?? [])]
  return forbiddenTerms.some(term => containsNormalizedPhrase(value, term))
    || cues.some(cue => containsNormalizedPhrase(value, cue.text))
}

function containsNormalizedPhrase(value: string, phrase: string): boolean {
  const normalizedValue = normalizeForComparison(value)
  const normalizedPhrase = normalizeForComparison(phrase)
  return normalizedPhrase.length > 0
    && ` ${normalizedValue} `.includes(` ${normalizedPhrase} `)
}

function normalizeForComparison(value: string): string {
  return value.normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function configuredEndpoint(value: URL): URL {
  if (!(value instanceof URL)
    || (value.protocol !== 'http:' && value.protocol !== 'https:')
    || value.username.length > 0
    || value.password.length > 0) {
    throw new OllamaPlanError('invalid_configuration')
  }
  return new URL('/api/generate', value.origin)
}

async function requestWithRedirects(
  request: typeof fetch,
  endpoint: URL,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  let current = endpoint
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    let response: Response
    try {
      response = await request(current, init)
    } catch {
      throw new OllamaPlanError(signal.aborted ? 'timeout' : 'provider_unavailable')
    }

    if (response.redirected || (response.url.length > 0 && new URL(response.url).origin !== endpoint.origin)) {
      await cancelResponseBody(response)
      throw new OllamaPlanError('redirect_rejected')
    }
    if (response.status < 300 || response.status >= 400) {
      return response
    }

    const location = response.headers.get('location')
    if (location === null || redirects === MAX_REDIRECTS) {
      await cancelResponseBody(response)
      throw new OllamaPlanError('redirect_rejected')
    }
    let redirected: URL
    try {
      redirected = new URL(location, current)
    } catch {
      await cancelResponseBody(response)
      throw new OllamaPlanError('redirect_rejected')
    }
    if (redirected.origin !== endpoint.origin) {
      await cancelResponseBody(response)
      throw new OllamaPlanError('redirect_rejected')
    }
    await cancelResponseBody(response)
    current = redirected
  }
  throw new OllamaPlanError('redirect_rejected')
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && Number(declaredLength) > RESPONSE_BYTE_LIMIT) {
    await cancelResponseBody(response)
    throw new OllamaPlanError('response_too_large')
  }
  if (response.body === null) {
    return ''
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let result = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }
      bytes += chunk.value.byteLength
      if (bytes > RESPONSE_BYTE_LIMIT) {
        await reader.cancel()
        throw new OllamaPlanError('response_too_large')
      }
      result += decoder.decode(chunk.value, { stream: true })
    }
    return result + decoder.decode()
  } catch (error) {
    if (error instanceof OllamaPlanError) {
      throw error
    }
    throw new OllamaPlanError(signal.aborted ? 'timeout' : 'provider_unavailable')
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body === null) {
    return
  }
  try {
    await response.body.cancel()
  } catch {
    // Cancellation is best-effort and must not replace the controlled planner error.
  }
}

function unwrapJsonFence(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith('```')) {
    return trimmed
  }
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  if (match === null) {
    throw new OllamaPlanError('invalid_response')
  }
  return match[1]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
