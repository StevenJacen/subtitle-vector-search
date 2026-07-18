export type QueryKind = 'literal' | 'action' | 'metaphor'
export type VideoAssetProvider = 'vecteezy'
export type VideoAssetRunStatus = 'planning' | 'completed' | 'degraded' | 'failed'

export interface VideoAssetRequest {
  subtitleChunkId?: number
  text?: string
  theme?: string
  candidateCount: number
}

export interface VideoAssetSelectionRequest {
  runId: string
  providerResourceId: number
  note: string
}

export interface VisualIntent {
  subject: string
  action: string
  setting: string
  mood: string
  lighting: string
  shot: string
}

export interface VisualQuery {
  kind: QueryKind
  term: string
}

export interface VisualPlan {
  visualIntent: VisualIntent
  queries: VisualQuery[]
}

export interface PlanValidationContext {
  sourceText: string
  forbiddenTerms: string[]
}

export interface VideoAssetCandidate {
  provider: VideoAssetProvider
  providerResourceId: number
  title: string | null
  licenseType: string | null
  aiGenerated: boolean | null
  orientation: string | null
  fileTypes: Array<{ extension: string; sizeInBytes: number }>
  downloadSizes: Array<{ id: string; width: number; height: number }>
  score: number
  bestRank: number
  matchedBy: QueryKind[]
  previewUrl: string | null
}

export interface VideoAssetMatchResponse {
  runId: string
  status: Exclude<VideoAssetRunStatus, 'planning'>
  planner: {
    model: string
    promptVersion: string
    fallbackUsed: boolean
  }
  visualIntent: VisualIntent
  queries: Array<VisualQuery & { status: 'completed' | 'failed'; errorCode?: string }>
  candidates: VideoAssetCandidate[]
}

export class VideoAssetError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'VideoAssetError'
  }
}

const queryKinds: QueryKind[] = ['literal', 'action', 'metaphor']

const protectedDescriptors = new Set([
  'boy', 'girl', 'man', 'woman', 'male', 'female', 'young', 'old',
  'asian', 'black', 'white', 'latino', 'disabled', 'blind', 'deaf',
])

export function parseVideoAssetRequest(value: unknown): VideoAssetRequest {
  const input = object(value)
  const subtitleChunkId = optionalPositiveInteger(input.subtitleChunkId)
  const text = optionalBoundedString(input.text, 1000)
  const theme = optionalBoundedString(input.theme, 300)
  const candidateCount = input.candidateCount === undefined
    ? 8
    : integerInRange(input.candidateCount, 5, 10)

  if (subtitleChunkId === undefined && text === undefined && theme === undefined) {
    throw invalidRequest()
  }
  if (subtitleChunkId !== undefined && text !== undefined) {
    throw invalidRequest()
  }

  return {
    ...(subtitleChunkId === undefined ? {} : { subtitleChunkId }),
    ...(text === undefined ? {} : { text }),
    ...(theme === undefined ? {} : { theme }),
    candidateCount,
  }
}

export function parseVisualPlan(value: unknown, context: PlanValidationContext): VisualPlan {
  const input = object(value)
  const intentInput = object(input.visualIntent)
  const visualIntent = {
    subject: requiredString(intentInput.subject),
    action: requiredString(intentInput.action),
    setting: requiredString(intentInput.setting),
    mood: requiredString(intentInput.mood),
    lighting: requiredString(intentInput.lighting),
    shot: requiredString(intentInput.shot),
  }
  const queriesInput = array(input.queries)
  if (queriesInput.length !== queryKinds.length || !isValidContext(context)) {
    throw invalidPlan()
  }

  const queries = queriesInput.map(queryInput => {
    const query = object(queryInput)
    const kind = query.kind
    if (!queryKinds.includes(kind as QueryKind)) {
      throw invalidPlan()
    }
    const term = requiredString(query.term)
    if (Array.from(term).length > 180 || /["'“”‘’]/u.test(term)) {
      throw invalidPlan()
    }
    return { kind: kind as QueryKind, term }
  })

  if (new Set(queries.map(query => query.kind)).size !== queryKinds.length
    || !queryKinds.every(kind => queries.some(query => query.kind === kind))) {
    throw invalidPlan()
  }

  const sourceLexicon = new Set(tokens(context.sourceText))
  const forbidden = context.forbiddenTerms.map(term => normalizePhrase(requiredString(term)))
  for (const valueToCheck of [...Object.values(visualIntent), ...queries.map(query => query.term)]) {
    const normalized = normalizePhrase(valueToCheck)
    if (forbidden.some(term => term !== '' && normalized.includes(term))) {
      throw invalidPlan()
    }
    for (const descriptor of protectedDescriptors) {
      if (tokens(valueToCheck).includes(descriptor) && !sourceLexicon.has(descriptor)) {
        throw invalidPlan()
      }
    }
  }

  return { visualIntent, queries }
}

export function parseSelectionRequest(value: unknown): VideoAssetSelectionRequest {
  const input = object(value)
  const runId = requiredString(input.runId)
  const providerResourceId = positiveSafeInteger(input.providerResourceId)
  const note = requiredString(input.note)
  if (!UUID.test(runId) || Array.from(note).length > 500) {
    throw invalidRequest()
  }
  return { runId, providerResourceId, note }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidRequest()
  }
  return value as Record<string, unknown>
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw invalidPlan()
  }
  return value
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalidRequest()
  }
  const result = value.trim()
  if (result === '') {
    throw invalidRequest()
  }
  return result
}

function optionalBoundedString(value: unknown, maximum: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  const result = requiredString(value)
  if (Array.from(result).length > maximum) {
    throw invalidRequest()
  }
  return result
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  return positiveSafeInteger(value)
}

function positiveSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw invalidRequest()
  }
  return value
}

function integerInRange(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidRequest()
  }
  return value
}

function isValidContext(value: PlanValidationContext): boolean {
  return typeof value === 'object'
    && value !== null
    && typeof value.sourceText === 'string'
    && Array.isArray(value.forbiddenTerms)
    && value.forbiddenTerms.every(term => typeof term === 'string')
}

function tokens(value: string): string[] {
  return normalizePhrase(value).match(/[a-z0-9]+/g) ?? []
}

function normalizePhrase(value: string): string {
  return value.trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ')
}

function invalidRequest(): VideoAssetError {
  return new VideoAssetError(400, 'invalid_request', 'invalid request')
}

function invalidPlan(): VideoAssetError {
  return new VideoAssetError(422, 'invalid_visual_plan', 'invalid visual plan')
}
