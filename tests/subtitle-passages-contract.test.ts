import { describe, expect, it } from 'vitest'
import {
  buildPassageResponse,
  parsePassageRequest,
  selectContinuousPassage,
  type PassageAnchor,
  type PassageCue,
} from '../supabase/functions/_shared/passage-selection.js'
import * as passageSelectionModule from '../supabase/functions/_shared/passage-selection.js'

describe('subtitle passage request contract', () => {
  it('accepts bounded nonblank Unicode themes and a scene count', () => {
    expect(parsePassageRequest({ theme: '  hope through hardship  ', sceneCount: 5 })).toEqual({
      theme: 'hope through hardship',
      sceneCount: 5,
    })
    expect(parsePassageRequest({ theme: '  \u5e0c\u671b\u4e0e\u575a\u6301  ', sceneCount: 10 })).toEqual({
      theme: '\u5e0c\u671b\u4e0e\u575a\u6301',
      sceneCount: 10,
    })
  })

  it('accepts an ordered safe-integer source anchor without changing the theme-only shape', () => {
    expect(parsePassageRequest({
      theme: 'hope',
      sceneCount: 5,
      sourceAnchor: { trackId: 12, firstCueIndex: 40, lastCueIndex: 43 },
    })).toEqual({
      theme: 'hope',
      sceneCount: 5,
      sourceAnchor: { trackId: 12, firstCueIndex: 40, lastCueIndex: 43 },
    })

    expect(parsePassageRequest({ theme: 'hope', sceneCount: 5 })).toEqual({
      theme: 'hope',
      sceneCount: 5,
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
    { theme: 'hope', sceneCount: 5, sourceAnchor: { trackId: 0, firstCueIndex: 40, lastCueIndex: 43 } },
    { theme: 'hope', sceneCount: 5, sourceAnchor: { trackId: 12, firstCueIndex: -1, lastCueIndex: 43 } },
    { theme: 'hope', sceneCount: 5, sourceAnchor: { trackId: 12, firstCueIndex: 44, lastCueIndex: 43 } },
    { theme: 'hope', sceneCount: 5, sourceAnchor: { trackId: 12, firstCueIndex: 40, lastCueIndex: 43.5 } },
    { theme: 'hope', sceneCount: 5, sourceAnchor: { trackId: 12, firstCueIndex: 40, lastCueIndex: 43, movieId: 7 } },
  ])('rejects malformed or extended input %#', input => {
    expect(() => parsePassageRequest(input)).toThrow('invalid request')
  })

  it.each(['', '   ', 'hope\u0000now', 'hope\nnow', `a${'b'.repeat(300)}`])(
    'rejects blank, controlled, or overlength theme %j',
    theme => {
      expect(requestErrorFor({ theme, sceneCount: 5 })).toMatchObject({
        code: 'invalid_request',
        message: 'invalid request',
      })
    },
  )
})

describe('subtitle passage response contract', () => {
  it('selects a deterministic midpoint-containing window from an exact anchor', () => {
    const select = (passageSelectionModule as typeof passageSelectionModule & {
      selectAnchoredPassage?: (input: unknown) => ReturnType<typeof selectContinuousPassage>
    }).selectAnchoredPassage
    expect(select).toBeTypeOf('function')

    const cues: PassageCue[] = Array.from({ length: 12 }, (_, offset) => ({
      trackId: 12,
      cueIndex: 36 + offset,
      startMs: offset * 3_000,
      endMs: (offset + 1) * 3_000,
      text: `Exact dialogue ${offset}.`,
    }))
    const passage = select!({
      sceneCount: 5,
      sourceAnchor: { trackId: 12, firstCueIndex: 40, lastCueIndex: 47 },
      movie: { id: 7, title: 'Exact Film', releaseYear: 1994 },
      cues,
    })

    expect(passage.movie).toEqual({ id: 7, title: 'Exact Film', releaseYear: 1994 })
    expect(passage.trackId).toBe(12)
    expect(passage.cues).toHaveLength(5)
    expect(passage.cues.map(cue => cue.cueIndex)).toEqual([41, 42, 43, 44, 45])
    expect(passage.cues.some(cue => cue.cueIndex === 43)).toBe(true)
  })

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
        cues: cues.map(cue => ({
          ...cue,
          timestamp: `${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}`,
        })),
      },
    })
    expect(Object.keys(buildPassageResponse(passage))).toEqual(['passage'])
    expect(buildPassageResponse(passage)).not.toHaveProperty('similarity')
    expect(passage.cues[2]).toMatchObject({
      text: '  Exact stored dialogue.  ',
      timestamp: '00:00:06.000 --> 00:00:09.000',
    })
  })
})

function formatTimestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000)
  const seconds = Math.floor(milliseconds % 60_000 / 1_000)
  const remainder = milliseconds % 1_000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`
}

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
