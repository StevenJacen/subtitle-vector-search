import { describe, expect, it } from 'vitest'
import {
  buildAssSubtitles,
  buildCaptionWindows,
  escapeAssText,
} from '../src/ass-subtitles.js'
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
