export interface PersistedChunkRange {
  firstCueIndex: number
  lastCueIndex: number
}

export class FinalizeIntegrityError extends Error {
  readonly code = 'incomplete_cue_ranges'

  constructor() {
    super('subtitle track has incomplete cue ranges')
    this.name = 'FinalizeIntegrityError'
  }
}

export function finalizeTrackIntegrity(
  cueIndexes: number[],
  chunks: PersistedChunkRange[],
): void
export function finalizeTrackIntegrity(
  cueIndexes: number[],
  chunks: PersistedChunkRange[],
  markReady: () => Promise<void>,
): Promise<void>
export function finalizeTrackIntegrity(
  cueIndexes: number[],
  chunks: PersistedChunkRange[],
  markReady?: () => Promise<void>,
): void | Promise<void> {
  if (cueIndexes.length === 0 || chunks.length === 0) {
    throw new FinalizeIntegrityError()
  }

  const existingCueIndexes = new Set(cueIndexes)
  for (const chunk of chunks) {
    for (let cueIndex = chunk.firstCueIndex; cueIndex <= chunk.lastCueIndex; cueIndex += 1) {
      if (!existingCueIndexes.has(cueIndex)) {
        throw new FinalizeIntegrityError()
      }
    }
  }

  return markReady === undefined ? undefined : markReady()
}
