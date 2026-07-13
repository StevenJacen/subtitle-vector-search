import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.110.2'
import { ContractError, parseIngestRequest, type IngestRequest } from '../_shared/contracts.ts'
import { embedChunks } from '../_shared/embeddings.ts'
import { errorResponse, handleAuthenticatedRequest, jsonResponse } from '../_shared/http.ts'
import { IngestionRpcValidationError, throwForIngestionRpcError } from '../_shared/rpc-errors.ts'

const embeddingSession = new Supabase.ai.Session('gte-small')

Deno.serve(async request => {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'only POST is supported')
  }

  return await handleAuthenticatedRequest(request, Deno.env, async () => {
    try {
      const input = parseIngestRequest(await request.json())
      const client = createServiceClient()
      return jsonResponse(await ingest(client, input))
    } catch (error) {
      if (error instanceof IngestionRpcValidationError) {
        return errorResponse(400, error.code, error.message)
      }
      if (error instanceof ContractError || error instanceof SyntaxError) {
        return errorResponse(400, 'invalid_request', 'invalid request')
      }
      return errorResponse(503, 'ingestion_transient_failure', 'subtitle ingestion temporarily failed')
    }
  })
})

function createServiceClient() {
  const url = requiredEnvironment('SUPABASE_URL')
  const serviceRoleKey = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY')
  return createClient(url, serviceRoleKey)
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)
  if (value === undefined || value.trim() === '') {
    throw new Error('missing configuration')
  }
  return value
}

async function ingest(client: any, input: IngestRequest): Promise<object> {
  switch (input.action) {
    case 'start':
      return await startImport(client, input)
    case 'batch':
      return await ingestBatch(client, input)
    case 'finalize':
      return await finalizeImport(client, input.trackId)
    case 'fail':
      return await failImport(client, input.trackId)
  }
}

async function startImport(client: any, input: Extract<IngestRequest, { action: 'start' }>) {
  const movie = await data(client
    .from('movies')
    .upsert({
      title: input.movie.title,
      release_year: input.movie.releaseYear ?? null,
      imdb_id: input.movie.imdbId,
    }, { onConflict: 'imdb_id' })
    .select('id')
    .single())

  await data(client
    .from('subtitle_tracks')
    .upsert({
      movie_id: movie.id,
      language_code: input.track.languageCode,
      source: input.track.source,
      source_ref: input.track.sourceRef ?? null,
      source_file_name: input.track.sourceFileName ?? null,
      source_sha256: input.track.sourceSha256,
      rights_status: input.track.rightsStatus,
      status: 'processing',
    }, {
      onConflict: 'movie_id,language_code,source_sha256',
      ignoreDuplicates: true,
    }))

  const track = await data(client
    .from('subtitle_tracks')
    .select('id,status')
    .eq('movie_id', movie.id)
    .eq('language_code', input.track.languageCode)
    .eq('source_sha256', input.track.sourceSha256)
    .single())
  if (track.status === 'failed') {
    await rpcData(client.rpc('reopen_subtitle_track', { p_track_id: track.id }), 'batch')
  }
  const [existingCueCount, existingChunkCount] = await Promise.all([
    count(client.from('subtitle_cues').select('*', { count: 'exact', head: true }).eq('track_id', track.id)),
    count(client.from('subtitle_chunks').select('*', { count: 'exact', head: true }).eq('track_id', track.id)),
  ])

  return { movieId: movie.id, trackId: track.id, existingCueCount, existingChunkCount }
}

async function ingestBatch(client: any, input: Extract<IngestRequest, { action: 'batch' }>) {
  const claimToken = crypto.randomUUID()
  const claims = await rpcData<Array<{ claimed_chunk_index: number }>>(
    client.rpc('reserve_subtitle_chunk_claims', {
      p_track_id: input.trackId,
      p_claim_token: claimToken,
      p_cues: input.cues.map(cue => ({
        cue_index: cue.index,
        start_ms: cue.startMs,
        end_ms: cue.endMs,
        text: cue.text,
      })),
      p_chunk_indexes: input.chunks.map(chunk => ({ chunk_index: chunk.index })),
    }),
    'batch',
  )
  const claimedIndexes = new Set(claims.map(claim => claim.claimed_chunk_index))
  const claimedChunks = input.chunks.filter(chunk => claimedIndexes.has(chunk.index))
  try {
    const chunksWithEmbeddings = await embedChunks(
      claimedChunks,
      text => embeddingSession.run(text, { mean_pool: true, normalize: true }),
    )
    const acceptedChunkCount = await completeClaims(client, input.trackId, claimToken, chunksWithEmbeddings)
    return { acceptedCueCount: input.cues.length, acceptedChunkCount }
  } catch (error) {
    await releaseClaims(client, input.trackId, claimToken).catch(() => undefined)
    throw error
  }
}

async function finalizeImport(client: any, trackId: number) {
  await rpcData(client.rpc('finalize_subtitle_track', { p_track_id: trackId }), 'finalize')
  return { trackId, status: 'ready' }
}

async function failImport(client: any, trackId: number) {
  await rpcData(client.rpc('fail_subtitle_track', { p_track_id: trackId }), 'batch')
  return { trackId, status: 'failed' }
}

async function releaseClaims(client: any, trackId: number, claimToken: string): Promise<void> {
  await rpcData(client.rpc('release_subtitle_chunk_claims', {
    p_track_id: trackId,
    p_claim_token: claimToken,
  }), 'batch')
}

async function completeClaims(
  client: any,
  trackId: number,
  claimToken: string,
  chunksWithEmbeddings: Array<{ chunk: Extract<IngestRequest, { action: 'batch' }>['chunks'][number]; embedding: number[] }>,
) {
  const result = await rpcData<Array<{ accepted_chunk_count: number }>>(
    client.rpc('complete_subtitle_chunk_claims', {
      p_track_id: trackId,
      p_claim_token: claimToken,
      p_chunks: chunksWithEmbeddings.map(({ chunk, embedding }) => ({
        chunk_index: chunk.index,
        start_ms: chunk.startMs,
        end_ms: chunk.endMs,
        text: chunk.text,
        first_cue_index: chunk.firstCueIndex,
        last_cue_index: chunk.lastCueIndex,
        embedding,
      })),
    }),
    'batch',
  )
  return result[0]?.accepted_chunk_count ?? 0
}

async function data<T>(query: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  const result = await query
  if (result.error !== null) {
    throw new Error('database operation failed')
  }
  return result.data
}

async function rpcData<T>(
  query: PromiseLike<{ data: T; error: unknown }>,
  operation: 'batch' | 'finalize',
): Promise<T> {
  const result = await query
  if (result.error !== null) {
    throwForIngestionRpcError(operation, databaseErrorCode(result.error))
  }
  return result.data as T
}

function databaseErrorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

async function count(query: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  const result = await query
  if (result.error !== null || result.count === null) {
    throw new Error('database operation failed')
  }
  return result.count
}
