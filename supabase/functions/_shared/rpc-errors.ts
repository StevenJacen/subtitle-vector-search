export type IngestionRpcOperation = 'batch' | 'finalize'

export class IngestionRpcValidationError extends Error {
  constructor(
    readonly code: 'track_ready' | 'incomplete_cue_ranges',
    message: string,
  ) {
    super(message)
    this.name = 'IngestionRpcValidationError'
  }
}

export function throwForIngestionRpcError(
  operation: IngestionRpcOperation,
  databaseCode: unknown,
): never {
  if (databaseCode === 'P0001') {
    if (operation === 'batch') {
      throw new IngestionRpcValidationError('track_ready', 'subtitle track is already ready')
    }
    throw new IngestionRpcValidationError('incomplete_cue_ranges', 'subtitle track has incomplete cue ranges')
  }
  throw new Error('database operation failed')
}
