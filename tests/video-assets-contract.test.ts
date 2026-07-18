import { describe, expect, it } from 'vitest'
import {
  parseSelectionRequest,
  parseVideoAssetRequest,
  parseVisualPlan,
} from '../supabase/functions/_shared/video-assets.js'
import { VISUAL_CONCEPT_SEEDS } from '../supabase/functions/_shared/visual-concept-seeds.js'

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
    expect(() => parseVisualPlan({ ...validPlan, queries: [{ kind: 'literal', term: 'The Synthetic Movie sunrise scene' }, validPlan.queries[1], validPlan.queries[2]] }, { sourceText: 'hope', forbiddenTerms: ['the synthetic movie'] })).toThrow()
    expect(() => parseVisualPlan({ ...validPlan, queries: [{ kind: 'literal', term: 'young woman opening curtains' }, validPlan.queries[1], validPlan.queries[2]] }, { sourceText: 'a person finds hope', forbiddenTerms: [] })).toThrow()
  })

  it.each([
    'person walking sunrise video 你好',
    '12345',
    '!!!',
  ])('rejects query terms that are not printable ASCII English: %s', term => {
    expect(() => parseVisualPlan({ ...validPlan, queries: [{ kind: 'literal', term }, validPlan.queries[1], validPlan.queries[2]] }, { sourceText: 'hope', forbiddenTerms: [] })).toThrow()
  })

  it('rejects an unquoted provided forbidden term', () => {
    const plan = {
      ...validPlan,
      queries: [{ kind: 'literal', term: 'Synthetic Night Walk sunrise scene' }, validPlan.queries[1], validPlan.queries[2]],
    }
    expect(() => parseVisualPlan(plan, { sourceText: 'hope', forbiddenTerms: ['synthetic night walk'] })).toThrow()
  })

  it.each([
    'elderly Nike customer opening curtains',
    'recreating a Harry Potter scene at sunrise',
    'customer wearing nike shoes in a quiet room',
    'customer wearing nike-branded shoes in a quiet room',
    'recreating a harry-potter scene at sunrise',
    'recreating a harry.potter scene at sunrise',
    'HarryPotter sunrise landscape video',
    'harrypotter sunrise landscape video',
    'recreate this famous scene at sunrise',
    're-enact this famous scene at sunrise',
    'non-binary person opening curtains at sunrise',
    'lesbians opening curtains at sunrise',
    'women opening curtains at sunrise',
    'Taylor opening curtains at sunrise',
    'TAYLOR opening curtains at sunrise',
    'Taylor-Swift opening curtains at sunrise',
    'superhero inspired by marvel cinematic scene',
    'person in the style of Acme Hero',
    'quiet room with Acme Hero watching sunrise',
    'copyright protected film recreation',
  ])('rejects ungrounded protected traits or protected references: %s', term => {
    const candidate = {
      ...validPlan,
      queries: [{ kind: 'literal', term }, validPlan.queries[1], validPlan.queries[2]],
    }

    expect(() => parseVisualPlan(candidate, {
      sourceText: 'A customer opens curtains and watches the sunrise.',
      forbiddenTerms: [],
    })).toThrow('invalid visual plan')
  })

  it.each([
    'elderly person opening curtains',
    'woman opening curtains',
    'Asian person opening curtains',
    'blind person opening curtains',
    'pregnant person opening curtains',
  ])('allows an exact source-grounded personal descriptor: %s', term => {
    const descriptor = term.split(' ')[0]
    const candidate = {
      ...validPlan,
      visualIntent: { ...validPlan.visualIntent, subject: `${descriptor} person` },
      queries: [{ kind: 'literal', term }, validPlan.queries[1], validPlan.queries[2]],
    }

    expect(parseVisualPlan(candidate, {
      sourceText: `The source explicitly describes an ${descriptor} person.`,
      forbiddenTerms: [],
    })).toEqual(candidate)
  })

  it('allows ordinary title-cased stock-search language', () => {
    const candidate = {
      ...validPlan,
      queries: [
        { kind: 'literal', term: 'Golden Hour City Skyline Aerial Video' },
        validPlan.queries[1],
        validPlan.queries[2],
      ],
    }

    expect(parseVisualPlan(candidate, { sourceText: 'A hopeful view of a city.', forbiddenTerms: [] }))
      .toEqual(candidate)
  })

  it('allows a generic title-cased stock-search phrase', () => {
    const candidate = {
      ...validPlan,
      queries: [
        { kind: 'literal', term: 'Person Walking Through Forest Video' },
        validPlan.queries[1],
        validPlan.queries[2],
      ],
    }

    expect(parseVisualPlan(candidate, { sourceText: 'A journey brings hope.', forbiddenTerms: [] }))
      .toEqual(candidate)
  })

  it.each([
    'Person Opening Curtains At Sunrise Video',
    'Opening curtains at sunrise video',
    'Hands Turning Pages Of Worn Photo Album Video',
    'Marvelous sunrise over quiet landscape video',
  ])('allows routine stock-search language without protected substrings: %s', term => {
    const candidate = {
      ...validPlan,
      queries: [{ kind: 'literal', term }, validPlan.queries[1], validPlan.queries[2]],
    }

    expect(parseVisualPlan(candidate, { sourceText: 'A visual moment of hope.', forbiddenTerms: [] }))
      .toEqual(candidate)
  })

  it('allows title-cased stock language derived from every built-in visual concept seed', () => {
    const titleCase = (value: string) => value.replace(/\b[a-z]/g, letter => letter.toUpperCase())

    for (const seed of VISUAL_CONCEPT_SEEDS) {
      const candidate = {
        visualIntent: {
          subject: 'A Symbolic Scene',
          action: 'Expressing Change',
          setting: 'An Everyday Environment',
          mood: 'Reflective',
          lighting: 'Natural Cinematic Lighting',
          shot: 'Medium Cinematic Shot',
        },
        queries: [
          { kind: 'literal', term: titleCase(seed.literalQuery) },
          { kind: 'action', term: titleCase(seed.actionQuery) },
          { kind: 'metaphor', term: titleCase(seed.metaphorQuery) },
        ],
      }

      expect(parseVisualPlan(candidate, { sourceText: seed.description, forbiddenTerms: [] }))
        .toEqual(candidate)
    }
  })

  it.each([
    { contextText: 'Several women wait by the window.', term: 'women opening curtains at sunrise' },
    { theme: 'elderly resilience', term: 'elderly person opening curtains at sunrise' },
  ])('grounds protected descriptors from adjacent context or theme: %#', grounding => {
    const candidate = {
      ...validPlan,
      queries: [{ kind: 'literal', term: grounding.term }, validPlan.queries[1], validPlan.queries[2]],
    }

    expect(parseVisualPlan(candidate, {
      sourceText: 'A person finds hope.',
      ...grounding.contextText === undefined ? {} : { contextText: grounding.contextText },
      ...grounding.theme === undefined ? {} : { theme: grounding.theme },
      forbiddenTerms: [],
    })).toEqual(candidate)
  })

  it('keeps forbidden terms rejected even when supplied as grounding', () => {
    const candidate = {
      ...validPlan,
      queries: [{ kind: 'literal', term: 'Synthetic-Night-Walk sunrise scene' }, validPlan.queries[1], validPlan.queries[2]],
    }

    expect(() => parseVisualPlan(candidate, {
      sourceText: 'Synthetic Night Walk is named in the source.',
      contextText: 'Synthetic Night Walk appears nearby.',
      theme: 'Synthetic Night Walk',
      forbiddenTerms: ['synthetic night walk'],
    })).toThrow('invalid visual plan')
  })
})

describe('manual selection request', () => {
  it('accepts a UUID, positive resource ID, and a short note', () => {
    expect(parseSelectionRequest({ runId: 'd62a53a1-08fb-4bee-a1ed-d8ba13de85f2', providerResourceId: 42, note: 'Best opening image' })).toEqual({
      runId: 'd62a53a1-08fb-4bee-a1ed-d8ba13de85f2', providerResourceId: 42, note: 'Best opening image',
    })
  })
})
