import { parseSync } from 'subtitle'
import type { Cue } from './domain.js'

const supportedExtensions = new Set(['.srt', '.vtt'])
const entities: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
}

export function parseSubtitle(content: string, extension: string): Cue[] {
  if (!supportedExtensions.has(extension.toLowerCase())) {
    throw new Error(`unsupported subtitle extension: ${extension}`)
  }

  const cues: Cue[] = []
  const nodes = parseSync(content.replace(/\r\n/g, '\n'))

  for (const node of nodes) {
    if (node.type !== 'cue') continue

    const { start, end, text } = node.data
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0) {
      throw new Error('cue timestamps must be non-negative')
    }
    if (end <= start) {
      throw new Error('end time must be greater than start time')
    }

    const cleanedText = normalizeCueText(text)
    cues.push({ index: cues.length, startMs: start, endMs: end, text: cleanedText })
  }

  if (cues.length === 0) {
    throw new Error('subtitle contains no cues')
  }

  return cues
}

export function formatTimestamp(milliseconds: number): string {
  const totalMilliseconds = Math.trunc(milliseconds)
  const hours = Math.floor(totalMilliseconds / 3_600_000)
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000)
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1_000)
  const ms = totalMilliseconds % 1_000

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

function normalizeCueText(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, entity => entities[entity])
    .replace(/\s+/g, ' ')
    .trim()
}
