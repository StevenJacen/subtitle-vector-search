import { describe, expect, it } from 'vitest'
import * as passageSelectionModule from '../src/workbench/passage-selection.js'
import {
  selectContinuousPassage,
  type PassageAnchor,
  type PassageCue,
} from '../src/workbench/passage-selection.js'

const defaultAnchor: PassageAnchor = {
  similarity: 0.9,
  movieId: 7,
  movieTitle: 'Synthetic Film',
  releaseYear: 2030,
  trackId: 11,
  firstCueIndex: 0,
  lastCueIndex: 0,
}

describe('continuous passage selection', () => {
  it.each([
    [5, Array.from({ length: 5 }, () => 3_000)],
    [10, Array.from({ length: 10 }, () => 1_500)],
  ])('selects exactly %i consecutive cues', (sceneCount, durations) => {
    const cues = cueSequence({ durations })

    const passage = selectContinuousPassage({
      theme: 'hope through hardship',
      sceneCount,
      anchors: [{ ...defaultAnchor, lastCueIndex: sceneCount - 1 }],
      cues,
    })

    expect(passage).toEqual({
      movie: { id: 7, title: 'Synthetic Film', releaseYear: 2030 },
      trackId: 11,
      startCueIndex: 0,
      endCueIndex: sceneCount - 1,
      totalDurationMs: 15_000,
      cues: withTimestamps(cues),
    })
  })

  it.each([4, 11, 5.5])('rejects an out-of-range scene count %s', sceneCount => {
    expect(() => selectContinuousPassage({
      theme: 'hope',
      sceneCount,
      anchors: [defaultAnchor],
      cues: cueSequence({ durations: Array.from({ length: 10 }, () => 3_000) }),
    })).toThrow('scene count must be an integer from 5 through 10')
  })

  it('accepts a 1,200 ms cue and rejects a 1,199 ms cue', () => {
    const accepted = cueSequence({ durations: [1_200, 3_450, 3_450, 3_450, 3_450] })
    expect(selectContinuousPassage({
      theme: 'hope',
      sceneCount: 5,
      anchors: [{ ...defaultAnchor, lastCueIndex: 4 }],
      cues: accepted,
    }).cues[0].endMs).toBe(1_200)

    const rejected = cueSequence({ durations: [1_199, 3_451, 3_450, 3_450, 3_450] })
    expect(() => selectContinuousPassage({
      theme: 'hope',
      sceneCount: 5,
      anchors: [{ ...defaultAnchor, lastCueIndex: 4 }],
      cues: rejected,
    })).toThrow('no eligible subtitle passage')
  })

  it.each([
    [14_999, [2_999, 3_000, 3_000, 3_000, 3_000], false],
    [15_000, [3_000, 3_000, 3_000, 3_000, 3_000], true],
    [60_000, [12_000, 12_000, 12_000, 12_000, 12_000], true],
    [60_001, [12_001, 12_000, 12_000, 12_000, 12_000], false],
  ])('enforces the %i ms total-duration boundary', (total, durations, eligible) => {
    const select = () => selectContinuousPassage({
      theme: 'hope',
      sceneCount: 5,
      anchors: [{ ...defaultAnchor, lastCueIndex: 4 }],
      cues: cueSequence({ durations }),
    })

    if (eligible) {
      expect(select().totalDurationMs).toBe(total)
    } else {
      expect(select).toThrow('no eligible subtitle passage')
    }
  })

  it('requires one track with consecutive cue indices', () => {
    const missingIndex = cueSequence({ durations: Array.from({ length: 5 }, () => 3_000) })
      .map((cue, index) => index < 3 ? cue : { ...cue, cueIndex: cue.cueIndex + 1 })
    expect(() => selectContinuousPassage({
      theme: 'hope',
      sceneCount: 5,
      anchors: [{ ...defaultAnchor, lastCueIndex: 5 }],
      cues: missingIndex,
    })).toThrow('no eligible subtitle passage')

    const mixedTracks = cueSequence({ durations: Array.from({ length: 5 }, () => 3_000) })
      .map((cue, index) => index === 2 ? { ...cue, trackId: 12 } : cue)
    expect(() => selectContinuousPassage({
      theme: 'hope',
      sceneCount: 5,
      anchors: [{ ...defaultAnchor, lastCueIndex: 4 }],
      cues: mixedTracks,
    })).toThrow('no eligible subtitle passage')
  })

  it('preserves accepted cue text byte-for-byte', () => {
    const exactText = '  <i>Hope stays -- exactly as stored.</i>  '
    const cues = cueSequence({
      durations: Array.from({ length: 5 }, () => 3_000),
      texts: [exactText, 'We keep going.', 'Nothing is rewritten.', 'Stay with me.', 'We begin again.'],
    })

    const passage = selectContinuousPassage({
      theme: 'hope',
      sceneCount: 5,
      anchors: [{ ...defaultAnchor, lastCueIndex: 4 }],
      cues,
    })

    expect(passage.cues[0].text).toBe(exactText)
    expect(passage.cues.map(({ timestamp: _timestamp, ...cue }) => cue)).toEqual(cues)
    expect(passage.cues[0].timestamp).toBe('00:00:00.000 --> 00:00:03.000')
  })

  it.each([
    'MORGAN:',
    'Morgan:',
    'MAN #1:',
    'VOICE (O.S.):',
    '\u00c9MILE:',
    '[DOOR SLAMS]',
    '(ominous music)',
    '\u266a music \u266a',
    '   ',
  ])(
    'rejects a passage containing non-dialogue-only cue %j',
    invalidText => {
      const cues = cueSequence({
        durations: Array.from({ length: 5 }, () => 3_000),
        texts: ['Hope remains.', 'We keep going.', invalidText, 'Stay with me.', 'We begin again.'],
      })

      expect(() => selectContinuousPassage({
        theme: 'hope',
        sceneCount: 5,
        anchors: [{ ...defaultAnchor, lastCueIndex: 4 }],
        cues,
      })).toThrow('no eligible subtitle passage')
    },
  )

  it('does not confuse ordinary colon-ended dialogue with a speaker label', () => {
    const cues = cueSequence({
      durations: Array.from({ length: 5 }, () => 3_000),
      texts: ['Remember this:', 'We keep going.', 'Hope remains.', 'Stay with me.', 'We begin again.'],
    })

    expect(selectContinuousPassage({
      theme: 'remember hope',
      sceneCount: 5,
      anchors: [{ ...defaultAnchor, lastCueIndex: 4 }],
      cues,
    }).cues[0].text).toBe('Remember this:')
  })

  it.each([
    [5, 18],
    [10, 44],
  ])('selects a %i-cue window from inside an oversized %i-cue anchor', (sceneCount, anchorLength) => {
    const cues = cueSequence({
      startIndex: 20,
      durations: Array.from({ length: anchorLength }, () => 3_000),
    })

    const passage = selectContinuousPassage({
      theme: 'hope through hardship',
      sceneCount,
      anchors: [{
        ...defaultAnchor,
        firstCueIndex: 20,
        lastCueIndex: 20 + anchorLength - 1,
      }],
      cues,
    })

    expect(passage.cues).toHaveLength(sceneCount)
    expect(passage.startCueIndex).toBeGreaterThanOrEqual(20)
    expect(passage.endCueIndex).toBeLessThanOrEqual(20 + anchorLength - 1)
  })

  it('orders windows by parent similarity before normalized theme coverage', () => {
    const highSimilarity = cueSequence({
      trackId: 20,
      durations: Array.from({ length: 5 }, () => 3_000),
      texts: Array.from({ length: 5 }, (_, index) => `Unrelated complete line ${index}.`),
    })
    const highCoverage = cueSequence({
      trackId: 10,
      durations: Array.from({ length: 5 }, () => 3_000),
      texts: ['Hope survives.', 'Through every hardship.', 'Hope returns.', 'We endure.', 'Morning comes.'],
    })

    const passage = selectContinuousPassage({
      theme: 'HOPE, through hardship!',
      sceneCount: 5,
      anchors: [
        { ...defaultAnchor, movieId: 20, trackId: 20, lastCueIndex: 4, similarity: 0.91 },
        { ...defaultAnchor, movieId: 10, trackId: 10, lastCueIndex: 4, similarity: 0.9 },
      ],
      cues: [...highCoverage, ...highSimilarity],
    })

    expect(passage.movie.id).toBe(20)
  })

  it('uses normalized theme coverage, completeness, and IDs as stable tie breakers', () => {
    const unrelated = cueSequence({
      trackId: 1,
      durations: Array.from({ length: 5 }, () => 3_000),
      texts: Array.from({ length: 5 }, (_, index) => `An unrelated sentence ${index}.`),
    })
    const incomplete = cueSequence({
      trackId: 9,
      durations: Array.from({ length: 5 }, () => 3_000),
      texts: ['and hope survives.', 'Through hardship.', 'We wait.', 'We endure.', 'hope remains'],
    })
    const completeHigherId = cueSequence({
      trackId: 8,
      durations: Array.from({ length: 5 }, () => 3_000),
      texts: ['Hope survives.', 'Through hardship.', 'We wait.', 'We endure.', 'Hope remains.'],
    })
    const completeLowerId = cueSequence({
      trackId: 7,
      durations: Array.from({ length: 5 }, () => 3_000),
      texts: ['Hope survives.', 'Through hardship.', 'We wait.', 'We endure.', 'Hope remains.'],
    })
    const anchors = [
      { ...defaultAnchor, movieId: 1, trackId: 1, lastCueIndex: 4 },
      { ...defaultAnchor, movieId: 9, trackId: 9, lastCueIndex: 4 },
      { ...defaultAnchor, movieId: 8, trackId: 8, lastCueIndex: 4 },
      { ...defaultAnchor, movieId: 7, trackId: 7, lastCueIndex: 4 },
    ]

    const passage = selectContinuousPassage({
      theme: 'HOPE, through hardship!',
      sceneCount: 5,
      anchors,
      cues: [...unrelated, ...incomplete, ...completeHigherId, ...completeLowerId],
    })

    expect(passage.movie.id).toBe(7)
    expect(passage.trackId).toBe(7)
  })

  it('expands an anchor on both sides to build the requested window', () => {
    const cues = cueSequence({
      startIndex: 2,
      durations: Array.from({ length: 5 }, () => 3_000),
    })

    const passage = selectContinuousPassage({
      theme: 'hope',
      sceneCount: 5,
      anchors: [{ ...defaultAnchor, firstCueIndex: 4, lastCueIndex: 5 }],
      cues,
    })

    expect(passage.startCueIndex).toBe(2)
    expect(passage.endCueIndex).toBe(6)
    expect(passage.cues.map(cue => cue.cueIndex)).toEqual([2, 3, 4, 5, 6])
  })
})

describe('bounded passage cue retrieval', () => {
  it('merges overlapping expanded ranges for the same track', () => {
    expect(buildCueRanges([
      { ...defaultAnchor, firstCueIndex: 100, lastCueIndex: 117 },
      { ...defaultAnchor, firstCueIndex: 110, lastCueIndex: 127 },
    ], 5)).toEqual([{ trackId: 11, firstCueIndex: 96, lastCueIndex: 131 }])
  })

  it('keeps disjoint far-apart anchors on the same track as separate ranges', () => {
    expect(buildCueRanges([
      { ...defaultAnchor, firstCueIndex: 100, lastCueIndex: 117 },
      { ...defaultAnchor, firstCueIndex: 5_000, lastCueIndex: 5_017 },
    ], 5)).toEqual([
      { trackId: 11, firstCueIndex: 96, lastCueIndex: 121 },
      { trackId: 11, firstCueIndex: 4_996, lastCueIndex: 5_021 },
    ])
  })

  it('does not merge overlapping ranges beyond the safe PostgREST row cap', () => {
    const ranges = buildCueRanges([
      { ...defaultAnchor, firstCueIndex: 4, lastCueIndex: 499 },
      { ...defaultAnchor, firstCueIndex: 500, lastCueIndex: 995 },
    ], 5)

    expect(maxCueRangeRows()).toBe(900)
    expect(ranges).toEqual([
      { trackId: 11, firstCueIndex: 0, lastCueIndex: 503 },
      { trackId: 11, firstCueIndex: 496, lastCueIndex: 999 },
    ])
    expect(ranges.every(range => range.lastCueIndex - range.firstCueIndex + 1 <= maxCueRangeRows()))
      .toBe(true)
  })

  it('deduplicates repeated fetched cue rows and rejects conflicting duplicates', () => {
    const cue = cueSequence({ durations: [3_000] })[0]

    expect(deduplicateCues([cue, { ...cue }])).toEqual([cue])
    expect(() => deduplicateCues([cue, { ...cue, text: 'Conflicting stored text.' }]))
      .toThrow('conflicting passage cues')
  })
})

function cueSequence(input: {
  trackId?: number
  startIndex?: number
  durations: number[]
  texts?: string[]
}): PassageCue[] {
  const trackId = input.trackId ?? 11
  const startIndex = input.startIndex ?? 0
  let startMs = 0

  return input.durations.map((duration, offset) => {
    const cue = {
      trackId,
      cueIndex: startIndex + offset,
      startMs,
      endMs: startMs + duration,
      text: input.texts?.[offset] ?? `Hope carries us through hardship ${offset}.`,
    }
    startMs += duration
    return cue
  })
}

function withTimestamps(cues: PassageCue[]) {
  return cues.map(cue => ({
    ...cue,
    timestamp: `${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}`,
  }))
}

function formatTimestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000)
  const seconds = Math.floor(milliseconds % 60_000 / 1_000)
  const remainder = milliseconds % 1_000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`
}

type PassageCueRange = { trackId: number; firstCueIndex: number; lastCueIndex: number }

function buildCueRanges(anchors: PassageAnchor[], sceneCount: number): PassageCueRange[] {
  const build = (passageSelectionModule as {
    buildPassageCueRanges?: (anchors: PassageAnchor[], sceneCount: number) => PassageCueRange[]
  }).buildPassageCueRanges
  expect(build).toBeTypeOf('function')
  return build!(anchors, sceneCount)
}

function maxCueRangeRows(): number {
  return (passageSelectionModule as { MAX_PASSAGE_CUE_RANGE_ROWS?: number }).MAX_PASSAGE_CUE_RANGE_ROWS ?? -1
}

function deduplicateCues(cues: PassageCue[]): PassageCue[] {
  const deduplicate = (passageSelectionModule as {
    deduplicatePassageCues?: (cues: PassageCue[]) => PassageCue[]
  }).deduplicatePassageCues
  expect(deduplicate).toBeTypeOf('function')
  return deduplicate!(cues)
}
