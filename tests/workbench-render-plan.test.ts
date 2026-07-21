import { describe, expect, it } from 'vitest'
import {
  buildDynamicTimeline,
  type DynamicRenderConfiguration,
  type DynamicScene,
} from '../src/workbench/render-plan.js'

const landscape: DynamicRenderConfiguration = {
  width: 1920,
  height: 1080,
  frameRate: 30,
  transitionMs: 400,
}

function scenes(durations: readonly number[]): DynamicScene[] {
  return durations.map((durationMs, index) => ({
    index,
    durationMs,
    captionEn: `Exact line ${index + 1}`,
    captionZh: `中文台词 ${index + 1}`,
    sourceInMs: index * 100,
  }))
}

describe('buildDynamicTimeline', () => {
  it('keeps five unequal cue durations on exact cumulative boundaries', () => {
    const timeline = buildDynamicTimeline(scenes([1_200, 2_345, 3_010, 4_444, 5_001]), landscape)

    expect(timeline.map(scene => [scene.startMs, scene.endMs])).toEqual([
      [0, 1_200],
      [1_200, 3_545],
      [3_545, 6_555],
      [6_555, 10_999],
      [10_999, 16_000],
    ])
    expect(timeline.at(-1)?.endMs).toBe(16_000)
  })

  it('keeps ten unequal cue durations without cumulative rounding loss', () => {
    const durations = [1_201, 1_337, 1_499, 1_777, 2_003, 2_221, 2_509, 2_801, 3_113, 3_539]
    const timeline = buildDynamicTimeline(scenes(durations), landscape)

    expect(timeline).toHaveLength(10)
    expect(timeline.at(-1)?.endMs).toBe(durations.reduce((sum, value) => sum + value, 0))
    for (let index = 1; index < timeline.length; index += 1) {
      expect(timeline[index].startMs).toBe(timeline[index - 1].endMs)
    }
  })

  it('caps each transition by 400ms and one quarter of both adjacent cues', () => {
    const timeline = buildDynamicTimeline(scenes([1_200, 4_000, 1_400, 2_000, 5_000]), landscape)

    expect(timeline.map(scene => scene.transitionOutMs)).toEqual([300, 350, 350, 400, 0])
    expect(timeline.map(scene => scene.sourceDurationMs)).toEqual([1_500, 4_350, 1_750, 2_400, 5_000])
    expect(timeline.map(scene => scene.xfadeOffsetMs)).toEqual([1_200, 5_200, 6_600, 8_600, null])
  })

  it('rejects anything other than five through ten ordered scenes and production dimensions', () => {
    expect(() => buildDynamicTimeline(scenes([1_200, 1_200, 1_200, 1_200]), landscape)).toThrow('invalid dynamic scenes')
    expect(() => buildDynamicTimeline(scenes([1_200, 1_200, 1_200, 1_200, 1_200]), {
      ...landscape,
      width: 1080,
    })).toThrow('invalid dynamic render configuration')
  })
})
