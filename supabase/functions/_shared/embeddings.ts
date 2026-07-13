export interface TextChunk {
  text: string
}

export type EmbeddingModel = (text: string) => Promise<unknown>

export async function embedChunks<Chunk extends TextChunk>(
  chunks: Chunk[],
  model: EmbeddingModel,
): Promise<Array<{ chunk: Chunk; embedding: number[] }>> {
  return await Promise.all(chunks.map(async chunk => ({
    chunk,
    embedding: assertEmbedding(await model(chunk.text)),
  })))
}

export function assertEmbedding(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== 384 || value.some(item => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new Error('invalid embedding')
  }
  return value
}
