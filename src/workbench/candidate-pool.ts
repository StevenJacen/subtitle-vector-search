export interface CandidateReference {
  provider: 'vecteezy'
  resourceId: number
  runId: string
  page: number
  title: string | null
  previewId: string | null
  orientation: string | null
  licenseType: string | null
  aiGenerated: boolean | null
  score: number
}

export interface CandidateKey {
  runId: string
  resourceId: number
}

export interface SceneCandidateState {
  pages: CandidateReference[][]
  selected?: CandidateKey
  confirmed?: CandidateKey
  recommended?: CandidateKey
  hasNextPage: boolean
}

export class CandidatePoolError extends Error {
  constructor(readonly code: string) {
    super(code.replaceAll('_', ' '))
    this.name = 'CandidatePoolError'
  }
}

export function appendCandidatePage(
  state: SceneCandidateState,
  page: CandidateReference[],
  hasNextPage = true,
): SceneCandidateState {
  const expectedPage = state.pages.length + 1
  const owningRuns = new Set(page.map(candidate => candidate.runId))
  const pageResources = new Set(page.map(candidateKey))
  if (page.length !== 8
    || page.some(candidate => candidate.page !== expectedPage)
    || owningRuns.size !== 1
    || pageResources.size !== page.length) {
    throw new CandidatePoolError('invalid_candidate_page')
  }
  if (state.pages.length > 0 && !state.hasNextPage) {
    throw new CandidatePoolError('candidate_page_exhausted')
  }
  if (!page.every(candidate => validCandidate(candidate))) {
    throw new CandidatePoolError('invalid_candidate')
  }

  const seen = new Set(state.pages.flat().map(candidateKey))
  const unique: CandidateReference[] = []
  for (const candidate of page) {
    const key = candidateKey(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ ...candidate })
  }
  const pages = [...state.pages.map(current => [...current]), unique]
  const recommended = recommendation(pages.flat())

  return {
    pages,
    ...(state.selected === undefined ? {} : { selected: { ...state.selected } }),
    ...(state.confirmed === undefined ? {} : { confirmed: { ...state.confirmed } }),
    ...(recommended === undefined ? {} : { recommended }),
    hasNextPage,
  }
}

export function selectSceneCandidate(
  state: SceneCandidateState,
  input: CandidateKey,
): SceneCandidateState {
  const candidates = state.pages.flat()
  const resourceMatches = candidates.filter(candidate => candidate.resourceId === input.resourceId)
  if (resourceMatches.length === 0) {
    throw new CandidatePoolError('candidate_not_found')
  }
  if (!resourceMatches.some(candidate => candidate.runId === input.runId)) {
    throw new CandidatePoolError('candidate_ownership_mismatch')
  }

  const unchanged = sameKey(state.selected, input)
  return {
    ...state,
    pages: state.pages.map(page => [...page]),
    selected: { ...input },
    ...(unchanged && state.confirmed !== undefined ? { confirmed: { ...state.confirmed } } : { confirmed: undefined }),
  }
}

export function confirmSceneCandidate(state: SceneCandidateState): SceneCandidateState {
  if (state.selected === undefined) {
    throw new CandidatePoolError('selection_required')
  }
  return {
    ...state,
    pages: state.pages.map(page => [...page]),
    confirmed: { ...state.selected },
  }
}

export function allScenesConfirmed(states: readonly SceneCandidateState[]): boolean {
  return states.length > 0 && states.every(state => (
    state.selected !== undefined
    && state.confirmed !== undefined
    && sameKey(state.selected, state.confirmed)
  ))
}

function recommendation(candidates: CandidateReference[]): CandidateKey | undefined {
  let best: CandidateReference | undefined
  for (const candidate of candidates) {
    if (best === undefined || candidate.score > best.score) best = candidate
  }
  return best === undefined ? undefined : { runId: best.runId, resourceId: best.resourceId }
}

function candidateKey(candidate: CandidateReference): string {
  return `${candidate.provider}:${candidate.resourceId}`
}

function sameKey(left: CandidateKey | undefined, right: CandidateKey): boolean {
  return left?.runId === right.runId && left.resourceId === right.resourceId
}

function validCandidate(candidate: CandidateReference): boolean {
  return candidate.provider === 'vecteezy'
    && Number.isSafeInteger(candidate.resourceId)
    && candidate.resourceId > 0
    && UUID.test(candidate.runId)
    && Number.isSafeInteger(candidate.page)
    && candidate.page >= 1
    && candidate.page <= 100
    && Number.isFinite(candidate.score)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
