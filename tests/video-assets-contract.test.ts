import { describe, expect, it } from 'vitest'
import {
  parseSelectionRequest,
  parseVideoAssetRequest,
  parseVisualPlan,
} from '../supabase/functions/_shared/video-assets.js'

const validPlan = {
  visualIntent: {
    subject: 'a solitary adult', action: 'opening curtains', setting: 'a quiet room',
    mood: 'renewed hope', lighting: 'soft sunrise', shot: 'medium cinematic shot',
  },
  queries: [
    { kind: 'literal', term: 'solitary person opening curtains sunrise quiet room video' },
    { kind: 'action', term: 'person stepping into morning light hopeful fresh start video' },
    { kind: 'metaphor', term: 'green sprout emerging after rain sunrise renewal macro video' },
  ],
}

describe('video asset request', () => {
  it('accepts a chunk plus a refining theme and supplies eight candidates', () => {
    expect(parseVideoAssetRequest({ subtitleChunkId: 12, theme: 'hope' })).toEqual({
      subtitleChunkId: 12, theme: 'hope', candidateCount: 8,
    })
  })

  it.each([
    {},
    { subtitleChunkId: 1, text: 'duplicate source' },
    { text: '' },
    { text: 'x'.repeat(1001) },
    { theme: 'x'.repeat(301) },
    { theme: 'hope', candidateCount: 4 },
    { theme: 'hope', candidateCount: 11 },
  ])('rejects invalid request %#', value => {
    expect(() => parseVideoAssetRequest(value)).toThrow('invalid request')
  })
})

describe('visual plan', () => {
  it('accepts exactly one query of each kind', () => {
    expect(parseVisualPlan(validPlan, { sourceText: 'hope', forbiddenTerms: [] })).toEqual(validPlan)
  })

  it('rejects duplicate kinds, quoted dialogue, source movie titles, and invented traits', () => {
    expect(() => parseVisualPlan({ ...validPlan, queries: [validPlan.queries[1], validPlan.queries[1], validPlan.queries[2]] }, { sourceText: 'hope', forbiddenTerms: [] })).toThrow()
    expect(() => parseVisualPlan({ ...validPlan, queries: [{ kind: 'literal', term: '"We begin again" film clip' }, validPlan.queries[1], validPlan.queries[2]] }, { sourceText: 'hope', forbiddenTerms: [] })).toThrow()
    expect(() => parseVisualPlan({ ...validPlan, queries: [{ kind: 'literal', term: 'The Synthetic Movie sunrise scene' }, validPlan.queries[1], validPlan.queries[2]] }, { sourceText: 'hope', forbiddenTerms: ['The Synthetic Movie'] })).toThrow()
    expect(() => parseVisualPlan({ ...validPlan, queries: [{ kind: 'literal', term: 'young woman opening curtains' }, validPlan.queries[1], validPlan.queries[2]] }, { sourceText: 'a person finds hope', forbiddenTerms: [] })).toThrow()
  })
})

describe('manual selection request', () => {
  it('accepts a UUID, positive resource ID, and a short note', () => {
    expect(parseSelectionRequest({ runId: 'd62a53a1-08fb-4bee-a1ed-d8ba13de85f2', providerResourceId: 42, note: 'Best opening image' })).toEqual({
      runId: 'd62a53a1-08fb-4bee-a1ed-d8ba13de85f2', providerResourceId: 42, note: 'Best opening image',
    })
  })
})
