import { describe, expect, it } from 'vitest'
import {
  buildPassageResponse,
  parsePassageRequest,
  selectContinuousPassage,
  type PassageAnchor,
  type PassageCue,
} from '../supabase/functions/_shared/passage-selection.js'

describe('subtitle passage request contract', () => {
  it('accepts only a trimmed English theme and scene count', () => {
    expect(parsePassageRequest({ theme: '  hope through hardship  ', sceneCount: 5 })).toEqual({
      theme: 'hope through hardship',
      sceneCount: 5,
    })
    expect(parsePassageRequest({ theme: "Don't give up!", sceneCount: 10 })).toEqual({
      theme: "Don't give up!",
      sceneCount: 10,
    })
  })

  it.each([
    null,
    [],
    {},
    { theme: 'hope' },
    { sceneCount: 5 },
    { theme: 'hope', sceneCount: 4 },
    { theme: 'hope', sceneCount: 11 },
    { theme: 'hope', sceneCount: 5.5 },
    { theme: 'hope', sceneCount: 5, movieId: 7 },
  ])('rejects malformed or extended input %#', input => {
    expect(() => parsePassageRequest(input)).toThrow('invalid request')
  })

  it.each(['', '2026', 'hope \u5e0c\u671b', `a${'b'.repeat(300)}`])(
    'returns the established controlled error for invalid English theme %j',
    theme => {
      expect(requestErrorFor({ theme, sceneCount: 5 })).toMatchObject({
      code: 'english_theme_required',
      message: 'English themes are required',
      })
    },
  )
})

describe('subtitle passage response contract', () => {
  it('returns one canonical passage with exact cue text and no anchor diagnostics', () => {
    const anchors: PassageAnchor[] = [{
      similarity: 0.84,
      movieId: 7,
      movieTitle: 'Synthetic Film',
      releaseYear: null,
      trackId: 11,
      firstCueIndex: 2,
      lastCueIndex: 3,
    }]
    const cues: PassageCue[] = Array.from({ length: 5 }, (_, offset) => ({
      trackId: 11,
      cueIndex: offset,
      startMs: offset * 3_000,
      endMs: (offset + 1) * 3_000,
      text: offset === 2 ? '  Exact stored dialogue.  ' : `Complete dialogue ${offset}.`,
    }))

    const passage = selectContinuousPassage({
      theme: 'exact dialogue',
      sceneCount: 5,
      anchors,
      cues,
    })

    expect(buildPassageResponse(passage)).toEqual({
      passage: {
        movie: { id: 7, title: 'Synthetic Film', releaseYear: null },
        trackId: 11,
        startCueIndex: 0,
        endCueIndex: 4,
        totalDurationMs: 15_000,
        cues,
      },
    })
    expect(Object.keys(buildPassageResponse(passage))).toEqual(['passage'])
    expect(buildPassageResponse(passage)).not.toHaveProperty('similarity')
  })
})

function requestErrorFor(input: unknown): Error {
  try {
    parsePassageRequest(input)
  } catch (error) {
    if (error instanceof Error) {
      return error
    }
  }
  throw new Error('expected passage request validation to fail')
}
