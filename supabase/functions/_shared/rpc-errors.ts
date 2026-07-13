export type IngestionRpcOperation = 'batch' | 'finalize'

export class IngestionRpcValidationError extends Error {
  constructor(
    readonly code: 'track_ready' | 'incomplete_cue_ranges' | 'pending_chunk_claims',
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
  if (operation === 'finalize' && databaseCode === 'P0003') {
    throw new IngestionRpcValidationError('pending_chunk_claims', 'subtitle track has pending chunk claims')
  }
  if (databaseCode === 'P0001') {
    if (operation === 'batch') {
      throw new IngestionRpcValidationError('track_ready', 'subtitle track is already ready')
    }
    throw new IngestionRpcValidationError('incomplete_cue_ranges', 'subtitle track has incomplete cue ranges')
  }
  throw new Error('database operation failed')
}
