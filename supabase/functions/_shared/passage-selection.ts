export interface PassageCue {
  trackId: number
  cueIndex: number
  startMs: number
  endMs: number
  text: string
}

export interface SelectedPassageCue extends PassageCue {
  timestamp: string
}

export interface PassageAnchor {
  similarity: number
  movieId: number
  movieTitle: string
  releaseYear: number | null
  trackId: number
  firstCueIndex: number
  lastCueIndex: number
}

export interface SelectedPassage {
  movie: { id: number; title: string; releaseYear: number | null }
  trackId: number
  startCueIndex: number
  endCueIndex: number
  totalDurationMs: number
  cues: SelectedPassageCue[]
}

export interface PassageCueRange {
  trackId: number
  firstCueIndex: number
  lastCueIndex: number
}

export interface PassageSourceAnchor {
  trackId: number
  firstCueIndex: number
  lastCueIndex: number
}

export interface PassageRequest {
  theme: string
  sceneCount: number
  sourceAnchor?: PassageSourceAnchor
}

export class PassageRequestError extends Error {
  readonly code = 'invalid_request'

  constructor() {
    super('invalid request')
    this.name = 'PassageRequestError'
  }
}

export class NoEligiblePassageError extends Error {
  constructor() {
    super('no eligible subtitle passage')
    this.name = 'NoEligiblePassageError'
  }
}

interface RankedPassage {
  passage: SelectedPassage
  similarity: number
  themeCoverage: number
  incompleteDialoguePenalty: number
}

const MIN_SCENE_COUNT = 5
const MAX_SCENE_COUNT = 10
const MIN_CUE_DURATION_MS = 1_200
const MIN_PASSAGE_DURATION_MS = 15_000
const MAX_PASSAGE_DURATION_MS = 60_000
export const MAX_PASSAGE_CUE_RANGE_ROWS = 900

export function parsePassageRequest(value: unknown): PassageRequest {
  if (!record(value)
    || !exactKeys(value, value.sourceAnchor === undefined
      ? ['sceneCount', 'theme']
      : ['sceneCount', 'sourceAnchor', 'theme'])
    || typeof value.theme !== 'string'
    || !validTheme(value.theme)
    || !validSceneCount(value.sceneCount)
    || (value.sourceAnchor !== undefined && !validSourceAnchor(value.sourceAnchor))) {
    throw new PassageRequestError()
  }

  return {
    theme: value.theme.trim(),
    sceneCount: value.sceneCount,
    ...(value.sourceAnchor === undefined ? {} : { sourceAnchor: value.sourceAnchor }),
  }
}

export function selectAnchoredPassage(input: {
  sceneCount: number
  sourceAnchor: PassageSourceAnchor
  movie: { id: number; title: string; releaseYear: number | null }
  cues: PassageCue[]
}): SelectedPassage {
  if (!validSceneCount(input.sceneCount)
    || !validSourceAnchor(input.sourceAnchor)
    || !validMovie(input.movie)
    || !Array.isArray(input.cues)
    || !input.cues.every(validCue)) {
    throw new Error('invalid anchored passage input')
  }

  const midpointCueIndex = Math.floor(
    (input.sourceAnchor.firstCueIndex + input.sourceAnchor.lastCueIndex) / 2,
  )
  const trackCues = indexCues(input.cues).get(input.sourceAnchor.trackId) ?? new Map()
  const availableCueIndexes = [...trackCues.keys()]
  if (availableCueIndexes.length === 0) throw new NoEligiblePassageError()
  const firstAvailableCueIndex = Math.min(...availableCueIndexes)
  const latestStartCueIndex = Math.max(
    firstAvailableCueIndex,
    Math.max(...availableCueIndexes) - input.sceneCount + 1,
  )
  const startCueIndex = Math.max(
    firstAvailableCueIndex,
    Math.min(midpointCueIndex - Math.floor(input.sceneCount / 2), latestStartCueIndex),
  )
  const cues = continuousWindow(trackCues, startCueIndex, input.sceneCount)
  if (cues === undefined
    || !cues.some(cue => cue.cueIndex === midpointCueIndex)
    || !eligibleWindow(cues)) {
    throw new NoEligiblePassageError()
  }

  return selectedPassage({
    movie: input.movie,
    trackId: input.sourceAnchor.trackId,
    startCueIndex,
    cues,
  })
}

export function selectContinuousPassage(input: {
  theme: string
  sceneCount: number
  anchors: PassageAnchor[]
  cues: PassageCue[]
}): SelectedPassage {
  if (!validSceneCount(input.sceneCount)) {
    throw new Error('scene count must be an integer from 5 through 10')
  }
  if (typeof input.theme !== 'string' || !validTheme(input.theme)) {
    throw new Error('theme must be a non-blank string')
  }
  if (!Array.isArray(input.anchors) || !input.anchors.every(validAnchor)
    || !Array.isArray(input.cues) || !input.cues.every(validCue)) {
    throw new Error('invalid passage input')
  }

  const cuesByTrack = indexCues(input.cues)
  const themeTokens = tokenSet(input.theme)
  const candidates: RankedPassage[] = []

  for (const anchor of input.anchors) {
    const trackCues = cuesByTrack.get(anchor.trackId)
    if (trackCues === undefined) {
      continue
    }

    const otherBoundaryStart = anchor.lastCueIndex - input.sceneCount + 1
    const earliestStart = Math.max(0, Math.min(anchor.firstCueIndex, otherBoundaryStart))
    const latestStart = Math.max(anchor.firstCueIndex, otherBoundaryStart)
    for (let startCueIndex = earliestStart; startCueIndex <= latestStart; startCueIndex += 1) {
      const cues = continuousWindow(trackCues, startCueIndex, input.sceneCount)
      if (cues === undefined || !eligibleWindow(cues)) {
        continue
      }

      const passage = selectedPassage({
        movie: { id: anchor.movieId, title: anchor.movieTitle, releaseYear: anchor.releaseYear },
        trackId: anchor.trackId,
        startCueIndex,
        cues,
      })
      candidates.push({
        passage,
        similarity: anchor.similarity,
        themeCoverage: tokenCoverage(themeTokens, passage.cues),
        incompleteDialoguePenalty: incompleteDialoguePenalty(passage.cues),
      })
    }
  }

  candidates.sort(compareRankedPassages)
  const selected = candidates[0]
  if (selected === undefined) {
    throw new NoEligiblePassageError()
  }
  return selected.passage
}

export function buildPassageResponse(passage: SelectedPassage): { passage: SelectedPassage } {
  return { passage }
}

export function buildPassageCueRanges(
  anchors: PassageAnchor[],
  sceneCount: number,
): PassageCueRange[] {
  if (!validSceneCount(sceneCount)
    || !Array.isArray(anchors)
    || !anchors.every(validAnchor)) {
    throw new Error('invalid passage range input')
  }

  const ranges = anchors
    .flatMap(anchor => splitCueRange({
      trackId: anchor.trackId,
      firstCueIndex: Math.max(0, anchor.firstCueIndex - sceneCount + 1),
      lastCueIndex: anchor.lastCueIndex + sceneCount - 1,
    }, sceneCount))
    .sort((left, right) => left.trackId - right.trackId
      || left.firstCueIndex - right.firstCueIndex
      || left.lastCueIndex - right.lastCueIndex)

  const merged: PassageCueRange[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    const mergedLastCueIndex = previous === undefined
      ? range.lastCueIndex
      : Math.max(previous.lastCueIndex, range.lastCueIndex)
    const canMerge = previous !== undefined
      && previous.trackId === range.trackId
      && range.firstCueIndex <= previous.lastCueIndex
      && mergedLastCueIndex - previous.firstCueIndex + 1 <= MAX_PASSAGE_CUE_RANGE_ROWS

    if (canMerge && previous !== undefined) {
      previous.lastCueIndex = mergedLastCueIndex
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

export function deduplicatePassageCues(cues: PassageCue[]): PassageCue[] {
  if (!Array.isArray(cues) || !cues.every(validCue)) {
    throw new Error('invalid passage input')
  }

  const cuesByKey = new Map<string, PassageCue>()
  for (const cue of cues) {
    const key = `${cue.trackId}:${cue.cueIndex}`
    const existing = cuesByKey.get(key)
    if (existing !== undefined
      && (existing.startMs !== cue.startMs || existing.endMs !== cue.endMs || existing.text !== cue.text)) {
      throw new Error('conflicting passage cues')
    }
    cuesByKey.set(key, cue)
  }
  return [...cuesByKey.values()]
}

function indexCues(cues: PassageCue[]): Map<number, Map<number, PassageCue>> {
  const tracks = new Map<number, Map<number, PassageCue>>()
  for (const cue of deduplicatePassageCues(cues)) {
    const track = tracks.get(cue.trackId) ?? new Map<number, PassageCue>()
    track.set(cue.cueIndex, cue)
    tracks.set(cue.trackId, track)
  }
  return tracks
}

function continuousWindow(
  trackCues: Map<number, PassageCue>,
  startCueIndex: number,
  sceneCount: number,
): PassageCue[] | undefined {
  const cues: PassageCue[] = []
  for (let offset = 0; offset < sceneCount; offset += 1) {
    const cue = trackCues.get(startCueIndex + offset)
    if (cue === undefined) {
      return undefined
    }
    cues.push(cue)
  }
  return cues
}

function eligibleWindow(cues: PassageCue[]): boolean {
  if (cues.some(cue => cue.endMs - cue.startMs < MIN_CUE_DURATION_MS || !containsDialogue(cue.text))) {
    return false
  }
  const totalDurationMs = cues.reduce((total, cue) => total + cue.endMs - cue.startMs, 0)
  return totalDurationMs >= MIN_PASSAGE_DURATION_MS && totalDurationMs <= MAX_PASSAGE_DURATION_MS
}

function containsDialogue(text: string): boolean {
  const visible = stripMarkup(text).trim()
  if (visible === '') {
    return false
  }
  if (speakerLabelOnly(visible)) {
    return false
  }
  if (/^\[[\s\S]*\]$/.test(visible) || /^\([\s\S]*\)$/.test(visible)) {
    return false
  }
  return !/^(?:\u266a[\s\S]*\u266a|\u266b[\s\S]*\u266b)$/.test(visible)
}

function tokenCoverage(themeTokens: Set<string>, cues: PassageCue[]): number {
  if (themeTokens.size === 0) {
    return 0
  }
  const passageTokens = tokenSet(cues.map(cue => stripMarkup(cue.text)).join(' '))
  let matches = 0
  for (const token of themeTokens) {
    if (passageTokens.has(token)) {
      matches += 1
    }
  }
  return matches / themeTokens.size
}

function incompleteDialoguePenalty(cues: PassageCue[]): number {
  const first = stripMarkup(cues[0]?.text ?? '').trim()
  const last = stripMarkup(cues.at(-1)?.text ?? '').trim()
  let penalty = 0
  if (/^(?:[a-z]|\.{2,}|\u2026|--?|[,;:])/.test(first)) {
    penalty += 1
  }
  if (!/[.!?](?:["')\]]*)$/.test(last)) {
    penalty += 1
  }
  return penalty
}

function compareRankedPassages(left: RankedPassage, right: RankedPassage): number {
  return right.similarity - left.similarity
    || right.themeCoverage - left.themeCoverage
    || left.incompleteDialoguePenalty - right.incompleteDialoguePenalty
    || left.passage.movie.id - right.passage.movie.id
    || left.passage.trackId - right.passage.trackId
    || left.passage.startCueIndex - right.passage.startCueIndex
    || left.passage.endCueIndex - right.passage.endCueIndex
}

function tokenSet(text: string): Set<string> {
  return new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}]+(?:['\u2019][\p{L}\p{N}]+)*/gu) ?? [])
}

function stripMarkup(text: string): string {
  return text.replace(/<[^>]*>/g, '')
}

function validAnchor(value: PassageAnchor): boolean {
  return record(value)
    && Number.isFinite(value.similarity)
    && positiveInteger(value.movieId)
    && typeof value.movieTitle === 'string'
    && value.movieTitle.trim() !== ''
    && (value.releaseYear === null || safeInteger(value.releaseYear))
    && positiveInteger(value.trackId)
    && nonNegativeInteger(value.firstCueIndex)
    && nonNegativeInteger(value.lastCueIndex)
    && value.lastCueIndex >= value.firstCueIndex
}

function validSourceAnchor(value: unknown): value is PassageSourceAnchor {
  return record(value)
    && exactKeys(value, ['firstCueIndex', 'lastCueIndex', 'trackId'])
    && positiveInteger(value.trackId)
    && nonNegativeInteger(value.firstCueIndex)
    && nonNegativeInteger(value.lastCueIndex)
    && value.lastCueIndex >= value.firstCueIndex
}

function validMovie(value: unknown): value is { id: number; title: string; releaseYear: number | null } {
  return record(value)
    && positiveInteger(value.id)
    && typeof value.title === 'string'
    && value.title.trim() !== ''
    && (value.releaseYear === null || safeInteger(value.releaseYear))
}

function validCue(value: PassageCue): boolean {
  return record(value)
    && positiveInteger(value.trackId)
    && nonNegativeInteger(value.cueIndex)
    && nonNegativeInteger(value.startMs)
    && positiveInteger(value.endMs)
    && value.endMs > value.startMs
    && typeof value.text === 'string'
}

function selectedPassage(input: {
  movie: { id: number; title: string; releaseYear: number | null }
  trackId: number
  startCueIndex: number
  cues: PassageCue[]
}): SelectedPassage {
  return {
    movie: input.movie,
    trackId: input.trackId,
    startCueIndex: input.startCueIndex,
    endCueIndex: input.startCueIndex + input.cues.length - 1,
    totalDurationMs: input.cues.reduce((total, cue) => total + cue.endMs - cue.startMs, 0),
    cues: input.cues.map(cue => ({
      ...cue,
      timestamp: `${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}`,
    })),
  }
}

function validTheme(value: string): boolean {
  const theme = value.trim()
  return theme !== ''
    && [...theme].length <= 300
    && !/[\p{Cc}\p{Cs}]/u.test(theme)
}

function splitCueRange(range: PassageCueRange, sceneCount: number): PassageCueRange[] {
  const ranges: PassageCueRange[] = []
  let firstCueIndex = range.firstCueIndex
  while (firstCueIndex <= range.lastCueIndex) {
    const lastCueIndex = Math.min(
      range.lastCueIndex,
      firstCueIndex + MAX_PASSAGE_CUE_RANGE_ROWS - 1,
    )
    ranges.push({ trackId: range.trackId, firstCueIndex, lastCueIndex })
    if (lastCueIndex === range.lastCueIndex) {
      break
    }
    firstCueIndex = lastCueIndex - sceneCount + 2
  }
  return ranges
}

function speakerLabelOnly(text: string): boolean {
  if (!text.endsWith(':')) {
    return false
  }
  const label = text.slice(0, -1).trim()
  if (label === ''
    || label.length > 80
    || !/^[\p{L}\p{M}\p{N}\s#().,'\u2019/-]+$/u.test(label)) {
    return false
  }

  const letters = label.match(/\p{L}/gu)?.join('') ?? ''
  if (letters === '') {
    return false
  }
  if (letters === letters.toLocaleUpperCase()) {
    return true
  }

  return label.split(/\s+/).every(word => word
    .split(/[-'\u2019]/)
    .every(part => /^\p{Lu}[\p{Ll}\p{M}]*$/u.test(part)))
}

function formatTimestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000)
  const seconds = Math.floor(milliseconds % 60_000 / 1_000)
  const remainder = milliseconds % 1_000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`
}

function validSceneCount(value: unknown): value is number {
  return safeInteger(value) && value >= MIN_SCENE_COUNT && value <= MAX_SCENE_COUNT
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown): value is number {
  return safeInteger(value) && value > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return safeInteger(value) && value >= 0
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}
