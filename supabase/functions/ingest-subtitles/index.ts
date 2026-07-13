import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.110.2'
import { ContractError, parseIngestRequest, type IngestRequest } from '../_shared/contracts.ts'
import { embedChunks } from '../_shared/embeddings.ts'
import { errorResponse, handleAuthenticatedRequest, jsonResponse } from '../_shared/http.ts'

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
      if (error instanceof ContractError || error instanceof SyntaxError) {
        return errorResponse(400, 'invalid_request', 'invalid request')
      }
      return errorResponse(500, 'ingestion_failed', 'subtitle ingestion failed')
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
    .select('id')
    .eq('movie_id', movie.id)
    .eq('language_code', input.track.languageCode)
    .eq('source_sha256', input.track.sourceSha256)
    .single())
  const [existingCueCount, existingChunkCount] = await Promise.all([
    count(client.from('subtitle_cues').select('*', { count: 'exact', head: true }).eq('track_id', track.id)),
    count(client.from('subtitle_chunks').select('*', { count: 'exact', head: true }).eq('track_id', track.id)),
  ])

  return { movieId: movie.id, trackId: track.id, existingCueCount, existingChunkCount }
}

async function ingestBatch(client: any, input: Extract<IngestRequest, { action: 'batch' }>) {
  if (input.cues.length > 0) {
    await data(client.from('subtitle_cues').upsert(input.cues.map(cue => ({
      track_id: input.trackId,
      cue_index: cue.index,
      start_ms: cue.startMs,
      end_ms: cue.endMs,
      text: cue.text,
    })), { onConflict: 'track_id,cue_index' }))
  }

  const existingChunks = input.chunks.length === 0
    ? []
    : await data(client
      .from('subtitle_chunks')
      .select('chunk_index')
      .eq('track_id', input.trackId)
      .in('chunk_index', input.chunks.map(chunk => chunk.index)))
  const existingIndexes = new Set(existingChunks.map((chunk: { chunk_index: number }) => chunk.chunk_index))
  const missingChunks = input.chunks.filter(chunk => !existingIndexes.has(chunk.index))

  if (missingChunks.length > 0) {
    const chunksWithEmbeddings = await embedChunks(
      missingChunks,
      text => embeddingSession.run(text, { mean_pool: true, normalize: true }),
    )
    await data(client.from('subtitle_chunks').upsert(chunksWithEmbeddings.map(({ chunk, embedding }) => ({
      track_id: input.trackId,
      chunk_index: chunk.index,
      start_ms: chunk.startMs,
      end_ms: chunk.endMs,
      text: chunk.text,
      first_cue_index: chunk.firstCueIndex,
      last_cue_index: chunk.lastCueIndex,
      embedding,
    })), { onConflict: 'track_id,chunk_index' }))
  }

  return { acceptedCueCount: input.cues.length, acceptedChunkCount: missingChunks.length }
}

async function finalizeImport(client: any, trackId: number) {
  const [cueCount, chunkCount] = await Promise.all([
    count(client.from('subtitle_cues').select('*', { count: 'exact', head: true }).eq('track_id', trackId)),
    count(client.from('subtitle_chunks').select('*', { count: 'exact', head: true }).eq('track_id', trackId)),
  ])
  if (cueCount < 1 || chunkCount < 1) {
    throw new ContractError()
  }
  await data(client.from('subtitle_tracks').update({ status: 'ready' }).eq('id', trackId))
  return { trackId, status: 'ready' }
}

async function data<T>(query: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  const result = await query
  if (result.error !== null) {
    throw new Error('database operation failed')
  }
  return result.data
}

async function count(query: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  const result = await query
  if (result.error !== null || result.count === null) {
    throw new Error('database operation failed')
  }
  return result.count
}
