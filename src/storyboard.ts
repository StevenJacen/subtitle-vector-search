import type { SelectedQuote } from './quote-selection.js'

export interface StoryboardScene {
  index: number
  captionKind: 'original' | 'quote'
  captionEn: string
  captionZh: string
  visualTheme: string
  sourceMovieId?: number
  sourceTrackId?: number
  sourceCueIndex?: number
  sourceStartMs?: number
  sourceEndMs?: number
  sourceTimestamp?: string
  movieTitle?: string
  releaseYear?: number | null
}

export interface Storyboard {
  scenes: StoryboardScene[]
}

export class StoryboardError extends Error {
  readonly code = 'unsafe_visual_collision' as const

  constructor() {
    super('unsafe visual collision')
    this.name = 'StoryboardError'
  }
}

const originalScenes = [
  {
    captionEn: 'Every night has a horizon.',
    captionZh: '每一个黑夜，都有它的地平线。',
    visualTheme: 'dark rain clouds moving over a remote landscape before dawn, cinematic wide shot',
  },
  {
    captionEn: 'Keep moving, even when the path disappears.',
    captionZh: '即使看不见路，也继续向前。',
    visualTheme: 'solitary traveler walking forward through wind on a dark open path, cinematic wide shot',
  },
  {
    captionEn: 'Morning begins with the next step.',
    captionZh: '黎明，始于下一步。',
    visualTheme: 'sunrise breaking over an open horizon with warm light, hopeful cinematic wide shot',
  },
] as const

const quoteVisualTheme = 'a solitary traveler reaching a ridge as storm clouds break and first light appears, cinematic wide shot'

export function buildStoryboard(quote: SelectedQuote, captionZh: string): Storyboard {
  if (captionZh.trim() === '' || captionZh.length > 300) {
    throw new Error('invalid Chinese quote translation')
  }

  const scenes: StoryboardScene[] = [
    { index: 0, captionKind: 'original', ...originalScenes[0] },
    { index: 1, captionKind: 'original', ...originalScenes[1] },
    {
      index: 2,
      captionKind: 'quote',
      captionEn: quote.text,
      captionZh,
      visualTheme: quoteVisualTheme,
      sourceMovieId: quote.movieId,
      sourceTrackId: quote.trackId,
      sourceCueIndex: quote.cueIndex,
      sourceStartMs: quote.startMs,
      sourceEndMs: quote.endMs,
      sourceTimestamp: quote.timestamp,
      movieTitle: quote.movieTitle,
      releaseYear: quote.releaseYear,
    },
    { index: 3, captionKind: 'original', ...originalScenes[2] },
  ]

  const normalizedQuoteText = normalizeForCollision(quote.text)
  const normalizedMovieTitle = normalizeForCollision(quote.movieTitle)
  if (scenes.some(scene => {
    const normalizedTheme = normalizeForCollision(scene.visualTheme)
    return normalizedQuoteText !== '' && normalizedTheme.includes(normalizedQuoteText)
      || normalizedMovieTitle !== '' && normalizedTheme.includes(normalizedMovieTitle)
  })) {
    throw new StoryboardError()
  }

  return { scenes }
}

function normalizeForCollision(value: string): string {
  return value.trim().toLowerCase()
}
