import { describe, expect, it } from 'vitest'
import { buildStoryboard } from '../src/storyboard.js'
import type { SelectedQuote } from '../src/quote-selection.js'

const selectedQuote: SelectedQuote = {
  text: '  Hope remains with us.  ',
  similarity: 0.83,
  movieId: 2,
  movieTitle: 'Synthetic Film',
  releaseYear: 1994,
  trackId: 7,
  cueIndex: 31,
  startMs: 120_000,
  endMs: 125_000,
  timestamp: '00:02:00.000 --> 00:02:05.000',
}

describe('buildStoryboard', () => {
  it('builds four indexed scenes with exactly one quote scene', () => {
    const storyboard = buildStoryboard(selectedQuote, '希望仍与我们同在。')

    expect(storyboard.scenes).toHaveLength(4)
    expect(storyboard.scenes.map(scene => scene.index)).toEqual([0, 1, 2, 3])
    expect(storyboard.scenes.filter(scene => scene.captionKind === 'quote')).toHaveLength(1)
  })

  it('keeps bilingual nonblank captions and the exact quote on scene two', () => {
    const storyboard = buildStoryboard(selectedQuote, '希望仍与我们同在。')

    for (const scene of storyboard.scenes) {
      expect(scene.captionEn.trim()).not.toBe('')
      expect(scene.captionZh.trim()).not.toBe('')
    }
    expect(storyboard.scenes[2].captionEn).toBe(selectedQuote.text)
    expect(storyboard.scenes[2].captionZh).toBe('希望仍与我们同在。')
  })

  it('keeps every English visual description generic and free of quote and title', () => {
    const storyboard = buildStoryboard(selectedQuote, '希望仍与我们同在。')

    for (const scene of storyboard.scenes) {
      expect(scene.visualTheme).not.toContain(selectedQuote.text)
      expect(scene.visualTheme).not.toContain(selectedQuote.text.trim())
      expect(scene.visualTheme).not.toContain(selectedQuote.movieTitle)
    }
  })

  it('stores source fields only on the quote scene', () => {
    const storyboard = buildStoryboard(selectedQuote, '希望仍与我们同在。')

    expect(storyboard.scenes[2]).toMatchObject({
      sourceTrackId: 7,
      sourceCueIndex: 31,
      sourceTimestamp: '00:02:00.000 --> 00:02:05.000',
      movieTitle: 'Synthetic Film',
      releaseYear: 1994,
    })
    for (const scene of storyboard.scenes.filter(scene => scene.index !== 2)) {
      expect(scene).not.toHaveProperty('sourceTrackId')
      expect(scene).not.toHaveProperty('sourceCueIndex')
      expect(scene).not.toHaveProperty('sourceTimestamp')
      expect(scene).not.toHaveProperty('movieTitle')
      expect(scene).not.toHaveProperty('releaseYear')
    }
  })

  it.each(['', '   ', 'x'.repeat(301)])('rejects blank or overlong Chinese quote translations: %j', captionZh => {
    expect(() => buildStoryboard(selectedQuote, captionZh)).toThrow('invalid Chinese quote translation')
  })
})
