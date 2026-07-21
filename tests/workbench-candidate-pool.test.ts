import { describe, expect, it } from 'vitest'
import {
  CandidatePoolError,
  allScenesConfirmed,
  appendCandidatePage,
  confirmSceneCandidate,
  selectSceneCandidate,
  type CandidateReference,
  type SceneCandidateState,
} from '../src/workbench/candidate-pool.js'

const run1 = '11111111-1111-4111-8111-111111111111'
const run2 = '22222222-2222-4222-8222-222222222222'
const run3 = '33333333-3333-4333-8333-333333333333'

function candidate(resourceId: number, runId = run1, page = 1, score = resourceId): CandidateReference {
  return {
    provider: 'vecteezy', resourceId, runId, page, title: `Candidate ${resourceId}`,
    previewId: null, orientation: 'landscape', licenseType: 'commercial',
    aiGenerated: false, score, suitabilityScore: 0, providerRank: resourceId,
  }
}

function page(start: number, runId: string, pageNumber: number): CandidateReference[] {
  return Array.from({ length: 8 }, (_, index) => candidate(start + index, runId, pageNumber))
}

function emptyState(): SceneCandidateState {
  return { pages: [], hasNextPage: true }
}

describe('incremental scene candidate pools', () => {
  it('requires exactly eight initial candidates owned by page one', () => {
    expect(() => appendCandidatePage(emptyState(), page(1, run1, 1).slice(0, 7), true))
      .toThrowError(CandidatePoolError)
    expect(() => appendCandidatePage(emptyState(), page(1, run1, 2), true))
      .toThrowError(CandidatePoolError)

    const state = appendCandidatePage(emptyState(), page(1, run1, 1), true)

    expect(state.pages).toHaveLength(1)
    expect(state.pages[0]).toHaveLength(8)
    expect(state.hasNextPage).toBe(true)
    expect(state.recommended).toEqual({ runId: run1, resourceId: 8 })
  })

  it('rejects duplicate initial resources and mixed owning runs within a page', () => {
    const duplicateInitial = page(1, run1, 1)
    duplicateInitial[7] = candidate(1, run1, 1)
    const mixedRun = page(1, run1, 1)
    mixedRun[7] = candidate(8, run2, 1)

    expect(() => appendCandidatePage(emptyState(), duplicateInitial, true))
      .toThrowError(expect.objectContaining({ code: 'invalid_candidate_page' }))
    expect(() => appendCandidatePage(emptyState(), mixedRun, true))
      .toThrowError(expect.objectContaining({ code: 'invalid_candidate_page' }))
  })

  it('appends second and third pages in stable order and deduplicates provider resources', () => {
    const first = appendCandidatePage(emptyState(), page(1, run1, 1), true)
    const duplicatePage = [candidate(8, run2, 2, 100), ...page(9, run2, 2).slice(0, 7)]
    const second = appendCandidatePage(first, duplicatePage, true)
    const third = appendCandidatePage(second, page(16, run3, 3), false)

    expect(second.pages[0]).toEqual(first.pages[0])
    expect(second.pages[1].map(item => item.resourceId)).toEqual([9, 10, 11, 12, 13, 14, 15])
    expect(third.pages.flat().map(item => item.resourceId)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
      9, 10, 11, 12, 13, 14, 15,
      16, 17, 18, 19, 20, 21, 22, 23,
    ])
    expect(third.hasNextPage).toBe(false)
  })

  it('accepts one to eight later candidates and may retain an empty deduplicated page', () => {
    const first = appendCandidatePage(emptyState(), page(1, run1, 1), true)
    const duplicateOnly = appendCandidatePage(first, [candidate(1, run2, 2)], true)
    const final = appendCandidatePage(duplicateOnly, [candidate(20, run3, 3)], false)

    expect(duplicateOnly.pages[1]).toEqual([])
    expect(final.pages[2].map(item => item.resourceId)).toEqual([20])
    expect(() => appendCandidatePage(first, [], false)).toThrowError(CandidatePoolError)
    expect(() => appendCandidatePage(first, page(20, run2, 2).concat(candidate(28, run2, 2)), false))
      .toThrowError(CandidatePoolError)
  })

  it('allows the recommendation to move while preserving selection and confirmation', () => {
    const firstPage = page(1, run1, 1).map(item => ({ ...item, score: item.resourceId / 100 }))
    const initial = appendCandidatePage(emptyState(), firstPage, true)
    const selected = confirmSceneCandidate(selectSceneCandidate(initial, { runId: run1, resourceId: 2 }))
    const nextPage = page(9, run2, 2).map(item => ({ ...item, score: item.resourceId === 9 ? 10 : 0 }))

    const appended = appendCandidatePage(selected, nextPage, false)

    expect(appended.recommended).toEqual({ runId: run2, resourceId: 9 })
    expect(appended.selected).toEqual({ runId: run1, resourceId: 2 })
    expect(appended.confirmed).toEqual({ runId: run1, resourceId: 2 })
  })

  it('rejects unknown candidates and a resource paired with the wrong owning run', () => {
    const state = appendCandidatePage(emptyState(), page(1, run1, 1), false)

    expect(() => selectSceneCandidate(state, { runId: run1, resourceId: 99 }))
      .toThrowError(expect.objectContaining({ code: 'candidate_not_found' }))
    expect(() => selectSceneCandidate(state, { runId: run2, resourceId: 1 }))
      .toThrowError(expect.objectContaining({ code: 'candidate_ownership_mismatch' }))
  })

  it('clears confirmation only when selection is replaced', () => {
    const state = appendCandidatePage(emptyState(), page(1, run1, 1), false)
    const confirmed = confirmSceneCandidate(selectSceneCandidate(state, { runId: run1, resourceId: 2 }))

    expect(selectSceneCandidate(confirmed, { runId: run1, resourceId: 2 }).confirmed)
      .toEqual({ runId: run1, resourceId: 2 })
    expect(selectSceneCandidate(confirmed, { runId: run1, resourceId: 3 }).confirmed)
      .toBeUndefined()
  })

  it('requires a current selection before confirming and gates on every scene', () => {
    const state = appendCandidatePage(emptyState(), page(1, run1, 1), false)
    expect(() => confirmSceneCandidate(state))
      .toThrowError(expect.objectContaining({ code: 'selection_required' }))

    const selected = selectSceneCandidate(state, { runId: run1, resourceId: 1 })
    const confirmed = confirmSceneCandidate(selected)
    expect(allScenesConfirmed([confirmed, selected])).toBe(false)
    expect(allScenesConfirmed([confirmed, confirmSceneCandidate(selected)])).toBe(true)
    expect(allScenesConfirmed([])).toBe(false)
  })

  it('rejects forged or stale selected and confirmed keys that are absent from pages', () => {
    const state = appendCandidatePage(emptyState(), page(1, run1, 1), false)
    const forgedSelection = { ...state, selected: { runId: run2, resourceId: 99 } }
    const forgedConfirmation = {
      ...state,
      selected: { runId: run2, resourceId: 99 },
      confirmed: { runId: run2, resourceId: 99 },
    }

    expect(() => confirmSceneCandidate(forgedSelection))
      .toThrowError(expect.objectContaining({ code: 'candidate_not_found' }))
    expect(allScenesConfirmed([forgedConfirmation])).toBe(false)
  })

  it.each([
    { previewId: 'not-a-uuid' },
    { title: 42 },
    { orientation: false },
    { licenseType: [] },
    { aiGenerated: 'false' },
    { suitabilityScore: Number.NaN },
    { providerRank: 0 },
  ])('rejects malformed candidate field %#', override => {
    const invalid = page(1, run1, 1)
    invalid[0] = { ...invalid[0], ...override } as CandidateReference

    expect(() => appendCandidatePage(emptyState(), invalid, false))
      .toThrowError(expect.objectContaining({ code: 'invalid_candidate' }))
  })
})
