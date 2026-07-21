export interface PassageCue {
  trackId: number
  cueIndex: number
  startMs: number
  endMs: number
  text: string
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
  cues: PassageCue[]
}

export interface PassageRequest {
  theme: string
  sceneCount: number
}

export class PassageRequestError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'english_theme_required' = 'invalid_request',
    message = code === 'english_theme_required' ? 'English themes are required' : 'invalid request',
  ) {
    super(message)
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

export function parsePassageRequest(value: unknown): PassageRequest {
  if (!record(value)
    || !exactKeys(value, ['sceneCount', 'theme'])
    || typeof value.theme !== 'string'
    || !validSceneCount(value.sceneCount)) {
    throw new PassageRequestError()
  }
  if (!validEnglishTheme(value.theme)) {
    throw new PassageRequestError('english_theme_required')
  }

  return { theme: value.theme.trim(), sceneCount: value.sceneCount }
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
  if (typeof input.theme !== 'string' || input.theme.trim() === '') {
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
    const anchorLength = anchor.lastCueIndex - anchor.firstCueIndex + 1
    if (anchorLength > input.sceneCount) {
      continue
    }

    const trackCues = cuesByTrack.get(anchor.trackId)
    if (trackCues === undefined) {
      continue
    }

    const earliestStart = Math.max(0, anchor.lastCueIndex - input.sceneCount + 1)
    const latestStart = anchor.firstCueIndex
    for (let startCueIndex = earliestStart; startCueIndex <= latestStart; startCueIndex += 1) {
      const cues = continuousWindow(trackCues, startCueIndex, input.sceneCount)
      if (cues === undefined || !eligibleWindow(cues)) {
        continue
      }

      const endCueIndex = startCueIndex + input.sceneCount - 1
      const passage: SelectedPassage = {
        movie: {
          id: anchor.movieId,
          title: anchor.movieTitle,
          releaseYear: anchor.releaseYear,
        },
        trackId: anchor.trackId,
        startCueIndex,
        endCueIndex,
        totalDurationMs: cues.reduce((total, cue) => total + cue.endMs - cue.startMs, 0),
        cues: cues.map(cue => ({ ...cue })),
      }
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

function indexCues(cues: PassageCue[]): Map<number, Map<number, PassageCue>> {
  const tracks = new Map<number, Map<number, PassageCue>>()
  for (const cue of cues) {
    const track = tracks.get(cue.trackId) ?? new Map<number, PassageCue>()
    const existing = track.get(cue.cueIndex)
    if (existing !== undefined
      && (existing.startMs !== cue.startMs || existing.endMs !== cue.endMs || existing.text !== cue.text)) {
      throw new Error('conflicting passage cues')
    }
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
  if (/^[A-Z][A-Z0-9 .'-]{0,40}:$/i.test(visible)) {
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
  return new Set(text.toLowerCase().match(/[a-z0-9]+(?:'[a-z0-9]+)?/g) ?? [])
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

function validCue(value: PassageCue): boolean {
  return record(value)
    && positiveInteger(value.trackId)
    && nonNegativeInteger(value.cueIndex)
    && nonNegativeInteger(value.startMs)
    && positiveInteger(value.endMs)
    && value.endMs > value.startMs
    && typeof value.text === 'string'
}

function validEnglishTheme(value: string): boolean {
  const theme = value.trim()
  return theme !== ''
    && theme.length <= 300
    && /^[\x09-\x0D\x20-\x7E]+$/.test(theme)
    && /[A-Za-z]/.test(theme)
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
