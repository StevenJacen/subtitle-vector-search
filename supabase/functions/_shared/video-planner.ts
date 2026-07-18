import { assertEmbedding } from './embeddings.ts'
import {
  parseVisualPlan,
  VideoAssetError,
  type VisualPlan,
} from './video-assets.ts'

export interface VisualPlannerInput {
  sourceText: string
  contextText?: string
  theme?: string
  movieTitle?: string
  forbiddenTerms: string[]
}

export type PlannerTransport = (prompt: string) => Promise<string>

interface PlannerSession {
  run(prompt: string, options: { stream: false; timeout: 20 }): Promise<unknown>
}

interface FallbackSession {
  run(text: string, options: { mean_pool: true; normalize: true }): Promise<unknown>
}

interface RpcClient {
  rpc(name: string, arguments_: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>
}

interface PlannerEnvironment {
  get(name: string): string | undefined
}

interface TransportDependencies {
  sessionFactory?: (model: string) => PlannerSession
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  timeoutSignal?: (milliseconds: number) => AbortSignal
}

export function buildPlannerPrompt(input: VisualPlannerInput): string {
  return [
    'Create a visual search plan. Return JSON only with no markdown.',
    'The visualIntent object must contain exactly: subject, action, setting, mood, lighting, shot.',
    'The queries array must contain exactly one query for each kind: literal, action, metaphor.',
    'Use concise English-only search terms suitable for stock video search.',
    'Use no dialogue, movie, or brand references in any output field.',
    'Do not invent protected traits such as age, gender, race, ethnicity, or disability.',
    `Source: ${input.sourceText}`,
    `Context: ${input.contextText ?? ''}`,
    `Theme: ${input.theme ?? ''}`,
    `Movie title to exclude: ${input.movieTitle ?? ''}`,
  ].join('\n')
}

export async function planVisualSearch(
  input: VisualPlannerInput,
  dependencies: {
    generate: PlannerTransport
    fallback: (input: VisualPlannerInput) => Promise<VisualPlan>
  },
): Promise<{ plan: VisualPlan; fallbackUsed: boolean }> {
  let firstOutput: string
  try {
    firstOutput = await dependencies.generate(buildPlannerPrompt(input))
  } catch {
    return await useFallback(input, dependencies.fallback)
  }

  const firstAttempt = parseGeneratedPlan(firstOutput, input)
  if (firstAttempt.ok) {
    return { plan: firstAttempt.plan, fallbackUsed: false }
  }

  try {
    const repairedOutput = await dependencies.generate(buildRepairPrompt(input, firstAttempt))
    const repaired = parseGeneratedPlan(repairedOutput, input)
    if (repaired.ok) {
      return { plan: repaired.plan, fallbackUsed: false }
    }
  } catch {
    // The deterministic fallback below handles transport and repair failures alike.
  }

  return await useFallback(input, dependencies.fallback)
}

export function createPlannerTransport(
  environment: PlannerEnvironment,
  dependencies: TransportDependencies = {},
): PlannerTransport {
  const transport = environment.get('VIDEO_PLANNER_TRANSPORT')
  if (transport === 'supabase-ai') {
    if (environment.get('OLLAMA_GATEWAY_SECURITY_CONFIRMED') !== 'true') {
      throw configurationError()
    }
    let session: PlannerSession
    try {
      session = (dependencies.sessionFactory ?? defaultSessionFactory)('gemma4:12b')
    } catch {
      throw configurationError()
    }
    return async prompt => {
      try {
        return generatedText(await session.run(prompt, { stream: false, timeout: 20 }))
      } catch {
        throw plannerUnavailable()
      }
    }
  }

  if (transport === 'ollama-http') {
    const host = required(environment, 'AI_INFERENCE_API_HOST')
    const token = required(environment, 'OLLAMA_AUTH_TOKEN')
    const model = required(environment, 'OLLAMA_MODEL')
    if (host === undefined || token === undefined || model !== 'gemma4:12b') {
      throw configurationError()
    }
    let endpoint: string
    try {
      endpoint = new URL('/api/chat', host).toString()
    } catch {
      throw configurationError()
    }
    const request = dependencies.fetch ?? globalThis.fetch.bind(globalThis)
    const timeoutSignal = dependencies.timeoutSignal ?? (milliseconds => AbortSignal.timeout(milliseconds))
    return async prompt => {
      try {
        const response = await request(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            format: 'json',
            options: { temperature: 0.2, num_predict: 600 },
          }),
          signal: timeoutSignal(20_000),
        })
        if (!response.ok) {
          throw plannerUnavailable()
        }
        const body = await response.json() as unknown
        return ollamaMessage(body)
      } catch {
        throw plannerUnavailable()
      }
    }
  }

  throw configurationError()
}

export async function fallbackVisualPlan(
  input: VisualPlannerInput,
  dependencies: { session: FallbackSession; client: RpcClient },
): Promise<VisualPlan> {
  const suppliedText = [input.sourceText, input.theme].filter(
    (value): value is string => value !== undefined,
  )
  if (suppliedText.some(value => !/^[\x20-\x7E]+$/.test(value))
    || !suppliedText.some(value => /[A-Za-z]/.test(value))) {
    throw plannerUnavailable()
  }
  const embeddingText = [input.sourceText, input.theme === undefined ? undefined : `Theme: ${input.theme}`]
    .filter((value): value is string => value !== undefined)
    .join('\n')

  try {
    const embedding = assertEmbedding(await dependencies.session.run(
      embeddingText,
      { mean_pool: true, normalize: true },
    ))
    const result = await dependencies.client.rpc('match_visual_concept', {
      query_embedding: embedding,
    })
    if (result.error !== null || !Array.isArray(result.data) || result.data.length !== 1) {
      throw plannerUnavailable()
    }
    const row = conceptRow(result.data[0])
    return parseVisualPlan({
      visualIntent: {
        subject: 'a symbolic scene',
        action: `expressing ${row.concept_key}`,
        setting: 'a filmable everyday environment',
        mood: row.concept_key,
        lighting: 'natural cinematic lighting',
        shot: 'medium cinematic shot',
      },
      queries: [
        { kind: 'literal', term: row.literal_query },
        { kind: 'action', term: row.action_query },
        { kind: 'metaphor', term: row.metaphor_query },
      ],
    }, { sourceText: input.sourceText, forbiddenTerms: plannerForbiddenTerms(input) })
  } catch {
    throw plannerUnavailable()
  }
}

type GeneratedPlanResult =
  | { ok: true; plan: VisualPlan }
  | { ok: false; messages: string[]; malformed: unknown }

function parseGeneratedPlan(output: string, input: VisualPlannerInput): GeneratedPlanResult {
  let candidate: unknown
  try {
    candidate = JSON.parse(output)
  } catch {
    return { ok: false, messages: ['invalid JSON'], malformed: output }
  }

  try {
    return {
      ok: true,
      plan: parseVisualPlan(candidate, {
        sourceText: input.sourceText,
        forbiddenTerms: plannerForbiddenTerms(input),
      }),
    }
  } catch {
    return { ok: false, messages: validationMessages(candidate), malformed: candidate }
  }
}

function validationMessages(candidate: unknown): string[] {
  if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
    const queries = (candidate as Record<string, unknown>).queries
    if (Array.isArray(queries)) {
      const kinds = queries.map(query => (
        typeof query === 'object' && query !== null && !Array.isArray(query)
          ? (query as Record<string, unknown>).kind
          : undefined
      ))
      const stringKinds = kinds.filter((kind): kind is string => typeof kind === 'string')
      if (new Set(stringKinds).size !== stringKinds.length) {
        return ['duplicate query kind']
      }
      if (queries.length !== 3) {
        return ['exactly three query kinds are required']
      }
    }
  }
  return ['visual plan failed schema validation']
}

function buildRepairPrompt(
  input: VisualPlannerInput,
  attempt: Extract<GeneratedPlanResult, { ok: false }>,
): string {
  return [
    buildPlannerPrompt(input),
    'Repair the previous response using these details.',
    `Validation errors: ${attempt.messages.join('; ')}`,
    `Malformed structured object: ${JSON.stringify(attempt.malformed)}`,
    'Return only the corrected JSON object.',
  ].join('\n')
}

async function useFallback(
  input: VisualPlannerInput,
  fallback: (input: VisualPlannerInput) => Promise<VisualPlan>,
): Promise<{ plan: VisualPlan; fallbackUsed: true }> {
  try {
    return { plan: await fallback(input), fallbackUsed: true }
  } catch {
    throw plannerUnavailable()
  }
}

function required(environment: PlannerEnvironment, name: string): string | undefined {
  const value = environment.get(name)
  return value === undefined || value.trim() === '' ? undefined : value
}

function plannerForbiddenTerms(input: VisualPlannerInput): string[] {
  return input.movieTitle === undefined
    ? input.forbiddenTerms
    : [...input.forbiddenTerms, input.movieTitle]
}

function defaultSessionFactory(model: string): PlannerSession {
  const runtime = globalThis as typeof globalThis & {
    Supabase?: { ai?: { Session?: new (model: string) => PlannerSession } }
  }
  const Session = runtime.Supabase?.ai?.Session
  if (Session === undefined) {
    throw configurationError()
  }
  return new Session(model)
}

function generatedText(value: unknown): string {
  if (typeof value !== 'string') {
    throw plannerUnavailable()
  }
  return value
}

function ollamaMessage(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw plannerUnavailable()
  }
  const message = (value as Record<string, unknown>).message
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    throw plannerUnavailable()
  }
  return generatedText((message as Record<string, unknown>).content)
}

function conceptRow(value: unknown): {
  concept_key: string
  literal_query: string
  action_query: string
  metaphor_query: string
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw plannerUnavailable()
  }
  const row = value as Record<string, unknown>
  for (const name of ['concept_key', 'literal_query', 'action_query', 'metaphor_query']) {
    if (typeof row[name] !== 'string' || row[name].trim() === '') {
      throw plannerUnavailable()
    }
  }
  return row as {
    concept_key: string
    literal_query: string
    action_query: string
    metaphor_query: string
  }
}

function configurationError(): VideoAssetError {
  return new VideoAssetError(500, 'planner_configuration_error', 'visual planner is not configured')
}

function plannerUnavailable(): VideoAssetError {
  return new VideoAssetError(502, 'planner_unavailable', 'visual planner unavailable')
}
