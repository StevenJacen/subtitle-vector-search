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
  'baby', 'toddler', 'child', 'kid', 'teen', 'teenager', 'adolescent', 'elderly',
  'boy', 'girl', 'man', 'woman', 'male', 'female', 'nonbinary', 'transgender',
  'asian', 'latino', 'latina', 'hispanic', 'indigenous', 'arab',
  'disabled', 'autistic', 'wheelchair', 'pregnant', 'gay', 'lesbian', 'bisexual',
  'muslim', 'christian', 'jewish', 'hindu', 'immigrant',
])
const ambiguousProtectedDescriptors = new Set([
  'young', 'old', 'senior', 'black', 'white', 'blind', 'deaf', 'veteran',
])
const humanTerms = new Set([
  'person', 'people', 'customer', 'worker', 'traveler', 'athlete', 'adult', 'parent',
  'friend', 'friends', 'couple', 'family', 'boy', 'girl', 'man', 'woman', 'child', 'kid',
])
const ordinaryStockTerms = new Set([
  'aerial', 'cinematic', 'city', 'close', 'golden', 'hour', 'lighting', 'macro',
  'medium', 'motion', 'natural', 'shot', 'skyline', 'slow', 'time', 'video', 'wide',
])
const protectedIdentifiers = [
  'nike', 'adidas', 'coca cola', 'disney', 'marvel', 'pixar', 'netflix',
  'star wars', 'harry potter', 'lord of the rings', 'pokemon', 'batman', 'superman',
]
const protectedReferencePatterns = [
  /(?:^|\s)(?:copyright|trademark|registered trademark)(?:\s|$)/,
  /[©®™]/u,
  /(?:^|\s)(?:inspired by|in the style of|based on|as seen in|reference to|homage to)(?:\s|$)/,
  /(?:^|\s)(?:recreate|recreates|recreated|recreating|reenact|reenacts|reenacted|reenacting)(?:\s+(?:a|the))?\s+(?:scene|shot|sequence|moment)(?:\s|$)/,
  /(?:^|\s)(?:scene|film|movie|shot|sequence)\s+recreation(?:\s|$)/,
]

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
    if (Array.from(term).length > 180
      || /["'“”‘’]/u.test(term)
      || !/^[\x20-\x7E]+$/.test(term)
      || !/[A-Za-z]/.test(term)) {
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
    if (protectedIdentifiers.some(identifier => containsPhrase(normalized, identifier))
      || protectedReferencePatterns.some(pattern => pattern.test(normalized))
      || hasUngroundedProperName(valueToCheck, sourceLexicon)
      || hasUngroundedProtectedDescriptor(valueToCheck, sourceLexicon)) {
      throw invalidPlan()
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

function containsPhrase(normalized: string, phrase: string): boolean {
  return (` ${normalized} `).includes(` ${phrase} `)
}

function hasUngroundedProtectedDescriptor(value: string, sourceLexicon: Set<string>): boolean {
  const valueTokens = tokens(value)
  return valueTokens.some((token, index) => {
    if (sourceLexicon.has(token)) return false
    if (protectedDescriptors.has(token)) return true
    if (!ambiguousProtectedDescriptors.has(token)) return false
    return valueTokens.slice(Math.max(0, index - 2), index + 3).some(nearby => humanTerms.has(nearby))
  })
}

function hasUngroundedProperName(value: string, sourceLexicon: Set<string>): boolean {
  const words = value.match(/[A-Za-z][A-Za-z0-9-]*/g) ?? []
  const capitalized = words.map((word, index) => ({ word, index })).filter(({ word }) => (
    /^[A-Z][a-z]+$/.test(word) && !ordinaryStockTerms.has(word.toLowerCase())
  ))
  for (let index = 0; index < capitalized.length - 1; index += 1) {
    const current = capitalized[index]
    const next = capitalized[index + 1]
    if (next.index === current.index + 1
      && (!sourceLexicon.has(current.word.toLowerCase()) || !sourceLexicon.has(next.word.toLowerCase()))) {
      return true
    }
  }
  return capitalized.some(({ word, index }) => index > 0 && !sourceLexicon.has(word.toLowerCase()))
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
