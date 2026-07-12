import type { Cue, SubtitleChunk } from './domain.js'

const tokenPattern = /[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?|[^\sA-Za-z0-9]/g

export function estimateTokens(text: string): number {
  return text.match(tokenPattern)?.length ?? 0
}

export function buildChunks(
  cues: Cue[],
  options: { targetTokens?: number; maxTokens?: number; overlapCues?: number } = {},
): SubtitleChunk[] {
  const targetTokens = options.targetTokens ?? 250
  const maxTokens = options.maxTokens ?? 450
  const overlapCues = options.overlapCues ?? 2

  validateOptions(targetTokens, maxTokens, overlapCues)

  const cueTokens = cues.map(cue => estimateTokens(cue.text))
  if (cueTokens.some(tokenCount => tokenCount > maxTokens)) {
    throw new Error('cue exceeds the embedding token limit')
  }

  const chunks: SubtitleChunk[] = []
  let startPosition = 0

  while (startPosition < cues.length) {
    const selectedPositions: number[] = []
    let tokenCount = 0
    let position = startPosition
    const previousLastPosition = chunks.length === 0 ? undefined : findCuePosition(cues, chunks.at(-1)!.lastCueIndex)

    while (position < cues.length) {
      const nextTokenCount = cueTokens[position]
      const exceedsTarget = tokenCount + nextTokenCount > targetTokens
      const exceedsMaximum = tokenCount + nextTokenCount > maxTokens
      const containsNewCue = previousLastPosition !== undefined
        && selectedPositions.some(selectedPosition => selectedPosition > previousLastPosition)

      if (exceedsMaximum || (exceedsTarget && selectedPositions.length > 0 && (previousLastPosition === undefined || containsNewCue))) {
        break
      }

      // Include one new cue so an overlap that fills the target cannot stall the loop.
      selectedPositions.push(position)
      tokenCount += nextTokenCount
      position += 1
    }

    if (selectedPositions.length === 0) {
      throw new Error('could not create a subtitle chunk')
    }

    const firstPosition = selectedPositions[0]
    const lastPosition = selectedPositions.at(-1)!
    const firstCue = cues[firstPosition]
    const lastCue = cues[lastPosition]
    chunks.push({
      index: chunks.length,
      startMs: firstCue.startMs,
      endMs: lastCue.endMs,
      firstCueIndex: firstCue.index,
      lastCueIndex: lastCue.index,
      text: selectedPositions.map(selectedPosition => cues[selectedPosition].text).join(' '),
    })

    if (lastPosition === cues.length - 1) break

    const nextStartPosition = Math.max(0, lastPosition - overlapCues + 1)
    if (
      nextStartPosition === startPosition
      && previousLastPosition !== undefined
      && lastPosition <= previousLastPosition
    ) {
      throw new Error('chunk overlap did not advance')
    }
    startPosition = nextStartPosition
  }

  return chunks
}

function validateOptions(targetTokens: number, maxTokens: number, overlapCues: number): void {
  if (!Number.isInteger(targetTokens) || targetTokens <= 0) {
    throw new Error('targetTokens must be a positive integer')
  }
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error('maxTokens must be a positive integer')
  }
  if (!Number.isInteger(overlapCues) || overlapCues < 0) {
    throw new Error('overlapCues must be a non-negative integer')
  }
}

function findCuePosition(cues: Cue[], cueIndex: number): number {
  const position = cues.findIndex(cue => cue.index === cueIndex)
  if (position === -1) {
    throw new Error('chunk references an unknown cue')
  }
  return position
}
