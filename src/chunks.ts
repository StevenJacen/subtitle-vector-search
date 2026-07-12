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

  const embeddableCues = cues.filter(cue => cue.text.trim().length > 0)
  const cueTokens = embeddableCues.map(cue => estimateTokens(cue.text))
  if (cueTokens.some(tokenCount => tokenCount > maxTokens)) {
    throw new Error('cue exceeds the embedding token limit')
  }

  const chunks: SubtitleChunk[] = []
  let startPosition = 0
  let previousLastPosition: number | undefined

  while (startPosition < embeddableCues.length) {
    const selectedPositions: number[] = []
    let tokenCount = 0
    let position = startPosition
    const previousLast = previousLastPosition

    while (position < embeddableCues.length) {
      const nextTokenCount = cueTokens[position]
      const exceedsTarget = tokenCount + nextTokenCount > targetTokens
      const exceedsMaximum = tokenCount + nextTokenCount > maxTokens
      const containsNewCue = previousLast !== undefined
        && selectedPositions.some(selectedPosition => selectedPosition > previousLast)

      if (exceedsMaximum || (exceedsTarget && selectedPositions.length > 0 && (previousLast === undefined || containsNewCue))) {
        break
      }

      selectedPositions.push(position)
      tokenCount += nextTokenCount
      position += 1
    }

    if (selectedPositions.length === 0) {
      throw new Error('could not create a subtitle chunk')
    }

    const firstPosition = selectedPositions[0]
    const lastPosition = selectedPositions.at(-1)!
    const firstCue = embeddableCues[firstPosition]
    const lastCue = embeddableCues[lastPosition]
    chunks.push({
      index: chunks.length,
      startMs: firstCue.startMs,
      endMs: lastCue.endMs,
      firstCueIndex: firstCue.index,
      lastCueIndex: lastCue.index,
      text: selectedPositions.map(selectedPosition => embeddableCues[selectedPosition].text).join(' '),
    })

    if (lastPosition === embeddableCues.length - 1) break

    previousLastPosition = lastPosition
    startPosition = findNextStartPosition(cueTokens, lastPosition, maxTokens, overlapCues)
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

function findNextStartPosition(
  cueTokens: number[],
  lastPosition: number,
  maxTokens: number,
  overlapCues: number,
): number {
  const nextPosition = lastPosition + 1
  let startPosition = Math.max(0, lastPosition - overlapCues + 1)
  let overlapTokens = 0

  for (let position = startPosition; position <= lastPosition; position += 1) {
    overlapTokens += cueTokens[position]
  }

  while (startPosition <= lastPosition && overlapTokens + cueTokens[nextPosition] > maxTokens) {
    overlapTokens -= cueTokens[startPosition]
    startPosition += 1
  }

  return startPosition
}
