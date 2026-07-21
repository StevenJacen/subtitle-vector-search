import { describe, expect, it } from 'vitest'
import {
  buildAssSubtitles,
  buildCaptionWindows,
  buildDynamicAssSubtitles,
  escapeAssText,
} from '../src/ass-subtitles.js'
import { buildDynamicTimeline, type DynamicScene } from '../src/workbench/render-plan.js'
import type { StoryboardScene } from '../src/storyboard.js'

const exactQuote = String.raw`Hope {still} follows C:\paths.`
const scenes: StoryboardScene[] = [
  { index: 0, captionKind: 'original', captionEn: 'Every night has a horizon.', captionZh: '每一个黑夜，都有它的地平线。', visualTheme: 'night' },
  { index: 1, captionKind: 'original', captionEn: 'Keep moving.', captionZh: '继续向前。', visualTheme: 'path' },
  {
    index: 2,
    captionKind: 'quote',
    captionEn: exactQuote,
    captionZh: '希望仍与我们同在。',
    visualTheme: 'ridge',
    sourceTimestamp: '00:02:00.000 --> 00:02:05.000',
    movieTitle: 'Movie Title',
    releaseYear: 1994,
  },
  { index: 3, captionKind: 'original', captionEn: 'Morning begins.', captionZh: '黎明开始。', visualTheme: 'dawn' },
]

describe('buildAssSubtitles', () => {
  it('builds a 1920x1080 Microsoft YaHei ASS document with safe margins', () => {
    const ass = buildAssSubtitles(scenes)

    expect(ass).toContain('PlayResX: 1920')
    expect(ass).toContain('PlayResY: 1080')
    const format = ass.match(/^Format: Name, Fontname,.*MarginL, MarginR, MarginV,/m)
    const style = ass.match(/^Style: Default,Microsoft YaHei,.*$/m)?.[0].split(',')
    expect(format).not.toBeNull()
    expect(style).toBeDefined()
    expect(Number(style?.[19])).toBeGreaterThanOrEqual(192)
    expect(Number(style?.[20])).toBeGreaterThanOrEqual(192)
    expect(Number(style?.[21])).toBeGreaterThanOrEqual(108)
  })

  it('preserves bilingual caption text while escaping ASS metacharacters', () => {
    const ass = buildAssSubtitles(scenes)
    const quoteEvent = ass.split('\n').find(line => line.startsWith('Dialogue:') && line.includes('Movie Title'))

    expect(escapeAssText(exactQuote)).toBe(String.raw`Hope \{still\} follows C:\\paths.`)
    expect(quoteEvent).toContain(`${escapeAssText(exactQuote)}\\N希望仍与我们同在。`)
    expect(quoteEvent).toContain('Movie Title (1994) · 00:02:00.000')
  })

  it('creates four ordered non-overlapping caption windows within 30 seconds', () => {
    const windows = buildCaptionWindows()

    expect(windows).toEqual([
      { startSeconds: 0, endSeconds: 7.35 },
      { startSeconds: 7.35, endSeconds: 14.7 },
      { startSeconds: 14.7, endSeconds: 22.05 },
      { startSeconds: 22.05, endSeconds: 30 },
    ])
    expect(windows).toHaveLength(4)
    for (const [index, window] of windows.entries()) {
      expect(window.startSeconds).toBeGreaterThanOrEqual(0)
      expect(window.endSeconds).toBeLessThanOrEqual(30)
      if (index > 0) expect(window.startSeconds).toBeGreaterThanOrEqual(windows[index - 1].endSeconds)
    }
  })

  it.each([
    { invalidScenes: scenes.slice(0, 3) },
    { invalidScenes: [...scenes.slice(0, 3), { ...scenes[2], index: 2 }] },
    { invalidScenes: [...scenes.slice(0, 2), { ...scenes[2], movieTitle: undefined }, scenes[3]] },
  ])('rejects malformed scene input', ({ invalidScenes }) => {
    expect(() => buildAssSubtitles(invalidScenes)).toThrow('invalid subtitle scenes')
  })
})

describe('buildDynamicAssSubtitles', () => {
  const dynamicScenes: DynamicScene[] = [1_200, 2_345, 3_010, 4_444, 5_001].map((durationMs, index) => ({
    index,
    durationMs,
    captionEn: index === 1 ? String.raw`Exact {English} C:\line` : `Exact English ${index + 1}`,
    captionZh: `精确中文 ${index + 1}`,
    sourceInMs: 120_000 + index * 2_000,
  }))

  it.each([
    { width: 1920 as const, height: 1080 as const, expectedStyle: 'Landscape', marginL: 192, marginV: 108 },
    { width: 1080 as const, height: 1920 as const, expectedStyle: 'Portrait', marginL: 108, marginV: 192 },
  ])('creates one exact bilingual event per cue with safe $expectedStyle margins', ({ width, height, expectedStyle, marginL, marginV }) => {
    const config = { width, height, frameRate: 30 as const, transitionMs: 400 }
    const timeline = buildDynamicTimeline(dynamicScenes, config)
    const ass = buildDynamicAssSubtitles(dynamicScenes, timeline, config, {
      movieTitle: 'Movie Title',
      releaseYear: 1994,
    })
    const events = ass.split('\n').filter(line => line.startsWith('Dialogue:'))
    const style = ass.split('\n').find(line => line.startsWith(`Style: ${expectedStyle},`))?.split(',')

    expect(events).toHaveLength(5)
    expect(events[0]).toContain('0:00:00.00,0:00:01.20')
    expect(events.at(-1)).toContain('0:00:11.00,0:00:16.00')
    expect(events[1]).toContain(`${escapeAssText(dynamicScenes[1].captionEn)}\\N${escapeAssText(dynamicScenes[1].captionZh)}\\NMovie Title (1994)`)
    expect(events[1]).not.toContain('00:02:02.000')
    expect(events.every(event => event.includes(`,${expectedStyle},`))).toBe(true)
    expect(Number(style?.[19])).toBeGreaterThanOrEqual(marginL)
    expect(Number(style?.[20])).toBeGreaterThanOrEqual(marginL)
    expect(Number(style?.[21])).toBeGreaterThanOrEqual(marginV)
    expect(ass).not.toContain('Style: Default,Microsoft YaHei')
  })
})
