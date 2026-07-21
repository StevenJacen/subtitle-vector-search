export type QueryKind = 'literal' | 'action' | 'metaphor'
export type VideoAssetProvider = 'vecteezy'
export type VideoAssetRunStatus = 'planning' | 'completed' | 'degraded' | 'failed'

export interface VideoAssetRequest {
  subtitleChunkId?: number
  text?: string
  theme?: string
  candidateCount: number
  page?: number
  sourceRunId?: string
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
  contextText?: string
  theme?: string
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
  page?: number
  hasNextPage?: boolean
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
  'muslim', 'christian', 'jewish', 'hindu', 'immigrant', 'veteran',
])
const ambiguousProtectedDescriptors = new Set([
  'young', 'old', 'senior', 'black', 'white', 'blind', 'deaf',
])
const humanTerms = new Set([
  'person', 'people', 'customer', 'worker', 'traveler', 'athlete', 'adult', 'parent',
  'friend', 'friends', 'couple', 'family', 'boy', 'girl', 'man', 'woman', 'child', 'kid',
])
const protectedIdentifiers = [
  'nike', 'adidas', 'coca cola', 'disney', 'marvel', 'pixar', 'netflix',
  'star wars', 'harry potter', 'lord of the rings', 'pokemon', 'batman', 'superman',
  'taylor', 'taylor swift', 'gandalf',
]
const protectedIdentifierTokens = protectedIdentifiers.map(identifier => tokens(identifier))
const protectedIdentifierCompacts = protectedIdentifierTokens.map(identifier => identifier.join(''))
const protectedIdentifierSuffixes = new Set([
  'land', 'brand', 'branded', 'theme', 'themed', 'style', 'styled', 'inspired',
])
const protectedReferenceTokens = [
  'inspired by', 'in the style of', 'based on', 'as seen in', 'reference to', 'homage to',
].map(reference => tokens(reference))
const recreationTokens = new Set([
  'recreate', 'recreates', 'recreated', 'recreating', 'recreation',
  'reenact', 'reenacts', 'reenacted', 'reenacting', 'reenactment',
])
const sceneReferenceTokens = new Set(['scene', 'shot', 'sequence', 'moment', 'movie', 'film'])
const descriptorCanonicalForms: Record<string, string> = {
  babies: 'baby', toddlers: 'toddler', children: 'child', kids: 'kid', teens: 'teen',
  teenagers: 'teenager', adolescents: 'adolescent', boys: 'boy', girls: 'girl',
  men: 'man', women: 'woman', males: 'male', females: 'female', asians: 'asian',
  latinos: 'latino', latinas: 'latina', hispanics: 'hispanic', arabs: 'arab',
  lesbians: 'lesbian', gays: 'gay', bisexuals: 'bisexual', nonbinaries: 'nonbinary',
  veterans: 'veteran', muslims: 'muslim', christians: 'christian', jews: 'jewish',
  hindus: 'hindu', immigrants: 'immigrant', people: 'person', persons: 'person',
  customers: 'customer', workers: 'worker', travelers: 'traveler', athletes: 'athlete',
  parents: 'parent', families: 'family', friends: 'friend', adults: 'adult',
}
export function parseVideoAssetRequest(value: unknown): VideoAssetRequest {
  const input = object(value)
  const subtitleChunkId = optionalPositiveInteger(input.subtitleChunkId)
  const text = optionalBoundedString(input.text, 1000)
  const theme = optionalBoundedString(input.theme, 300)
  const candidateCount = input.candidateCount === undefined
    ? 8
    : integerInRange(input.candidateCount, 5, 10)
  const page = input.page === undefined ? undefined : integerInRange(input.page, 1, 100)
  const sourceRunId = optionalUuid(input.sourceRunId)

  if (subtitleChunkId === undefined && text === undefined && theme === undefined && sourceRunId === undefined) {
    throw invalidRequest()
  }
  if (subtitleChunkId !== undefined && text !== undefined) {
    throw invalidRequest()
  }
  if ((sourceRunId !== undefined && (page === undefined || page === 1))
    || (sourceRunId !== undefined && theme === undefined)
    || (page !== undefined && page > 1 && sourceRunId === undefined)
    || (page !== undefined && candidateCount !== 8)
    || (sourceRunId !== undefined && (subtitleChunkId !== undefined || text !== undefined))) {
    throw invalidRequest()
  }

  return {
    ...(subtitleChunkId === undefined ? {} : { subtitleChunkId }),
    ...(text === undefined ? {} : { text }),
    ...(theme === undefined ? {} : { theme }),
    candidateCount,
    ...(page === undefined ? {} : { page }),
    ...(sourceRunId === undefined ? {} : { sourceRunId }),
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

  const groundingLexicon = new Set([
    context.sourceText,
    context.contextText,
    context.theme,
  ].filter((field): field is string => field !== undefined).flatMap(canonicalTokens))
  const forbidden = context.forbiddenTerms.map(term => tokens(requiredString(term)))
  for (const valueToCheck of [...Object.values(visualIntent), ...queries.map(query => query.term)]) {
    const valueTokens = tokens(valueToCheck)
    if (forbidden.some(term => containsProtectedPhrase(valueTokens, term))) {
      throw invalidPlan()
    }
    if (containsProtectedIdentifier(valueTokens)
      || hasProtectedReference(valueToCheck, valueTokens)
      || hasUngroundedProperName(valueToCheck, groundingLexicon)
      || hasUngroundedProtectedDescriptor(valueToCheck, groundingLexicon)) {
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

function optionalUuid(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const result = requiredString(value)
  if (!UUID.test(result)) throw invalidRequest()
  return result
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
    && (value.contextText === undefined || typeof value.contextText === 'string')
    && (value.theme === undefined || typeof value.theme === 'string')
    && Array.isArray(value.forbiddenTerms)
    && value.forbiddenTerms.every(term => typeof term === 'string')
}

function tokens(value: string): string[] {
  const separated = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  return mergeCompounds(separated.toLocaleLowerCase('en-US').match(/[a-z0-9]+/g) ?? [])
}

function canonicalTokens(value: string): string[] {
  return tokens(value).map(token => descriptorCanonicalForms[token] ?? token)
}

function containsTokenSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false
  return haystack.some((_, index) => needle.every((token, offset) => haystack[index + offset] === token))
}

function containsProtectedPhrase(valueTokens: string[], phraseTokens: string[]): boolean {
  return containsTokenSequence(valueTokens, phraseTokens)
    || (phraseTokens.length > 1 && valueTokens.includes(phraseTokens.join('')))
}

function containsProtectedIdentifier(valueTokens: string[]): boolean {
  if (protectedIdentifierTokens.some(identifier => containsTokenSequence(valueTokens, identifier))) {
    return true
  }
  return protectedIdentifierCompacts.some(compact => valueTokens.some(token => {
    if (token === compact) return true
    if (!token.startsWith(compact)) return false
    return protectedIdentifierSuffixes.has(token.slice(compact.length))
  }))
}

function mergeCompounds(valueTokens: string[]): string[] {
  const result: string[] = []
  for (let index = 0; index < valueTokens.length;) {
    const current = valueTokens[index]
    const next = valueTokens[index + 1]
    if (current === 're' && /^(?:enact(?:s|ed|ing|ment)?|creat(?:e|es|ed|ing|ion))$/.test(next ?? '')) {
      result.push(`re${next}`)
      index += 2
      continue
    }
    if (current === 'non' && /^(?:binary|binaries)$/.test(next ?? '')) {
      result.push(next === 'binaries' ? 'nonbinaries' : 'nonbinary')
      index += 2
      continue
    }
    result.push(current)
    index += 1
  }
  return result
}

function hasProtectedReference(value: string, valueTokens: string[]): boolean {
  if (/[\u00a9\u00ae\u2122]/u.test(value)
    || valueTokens.some(token => token === 'copyright' || token === 'trademark')
    || protectedReferenceTokens.some(reference => containsTokenSequence(valueTokens, reference))) {
    return true
  }
  return valueTokens.some(token => recreationTokens.has(token))
    && valueTokens.some(token => sceneReferenceTokens.has(token))
}

function hasUngroundedProtectedDescriptor(value: string, sourceLexicon: Set<string>): boolean {
  const valueTokens = canonicalTokens(value)
  return valueTokens.some((token, index) => {
    if (sourceLexicon.has(token)) return false
    if (protectedDescriptors.has(token)) return true
    if (!ambiguousProtectedDescriptors.has(token)) return false
    return valueTokens.slice(Math.max(0, index - 2), index + 3).some(nearby => humanTerms.has(nearby))
  })
}

function hasUngroundedProperName(value: string, sourceLexicon: Set<string>): boolean {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .match(/[A-Za-z][A-Za-z0-9]*/g) ?? []
  const looksNamed = (word: string) => /^[A-Z][a-z]+$/.test(word) || /^[A-Z]+$/.test(word)
  const titleCasePhrase = words.length > 1 && words.every(looksNamed)
  if (titleCasePhrase) return false

  return words.some((word, index) => {
    if (index === 0 || !looksNamed(word)) return false
    const normalized = descriptorCanonicalForms[word.toLowerCase()] ?? word.toLowerCase()
    return !sourceLexicon.has(normalized)
  })
}

function invalidRequest(): VideoAssetError {
  return new VideoAssetError(400, 'invalid_request', 'invalid request')
}

function invalidPlan(): VideoAssetError {
  return new VideoAssetError(422, 'invalid_visual_plan', 'invalid visual plan')
}
