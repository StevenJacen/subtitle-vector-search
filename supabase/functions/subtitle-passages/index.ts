import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.110.2'
import { assertQueryEmbedding } from '../_shared/search.ts'
import {
  buildPassageResponse,
  NoEligiblePassageError,
  parsePassageRequest,
  PassageRequestError,
  selectContinuousPassage,
  type PassageAnchor,
  type PassageCue,
  type PassageRequest,
} from '../_shared/passage-selection.ts'
import { errorResponse, handleAuthenticatedRequest, jsonResponse } from '../_shared/http.ts'

interface HybridAnchorRow {
  movie_id: number
  movie_title: string
  movie_release_year: number | null
  track_id: number
  first_cue_index: number
  last_cue_index: number
  similarity: number
}

interface CueRow {
  track_id: number
  cue_index: number
  start_ms: number
  end_ms: number
  text: string
}

interface TrackRow {
  id: number
}

interface TrackCueRange {
  trackId: number
  firstCueIndex: number
  lastCueIndex: number
}

const ANCHOR_MATCH_COUNT = 20
const embeddingSession = new Supabase.ai.Session('gte-small')

Deno.serve(async request => {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'only POST is supported')
  }

  return await handleAuthenticatedRequest(request, Deno.env, async () => {
    try {
      const input = parsePassageRequest(await request.json())
      const client = createServiceClient()
      const passage = await findPassage(client, input)
      return jsonResponse(buildPassageResponse(passage))
    } catch (error) {
      if (error instanceof PassageRequestError) {
        return errorResponse(400, error.code, error.message)
      }
      if (error instanceof SyntaxError) {
        return errorResponse(400, 'invalid_request', 'invalid request')
      }
      if (error instanceof NoEligiblePassageError) {
        return errorResponse(422, 'no_eligible_passage', error.message)
      }
      return errorResponse(500, 'passage_search_failed', 'subtitle passage search failed')
    }
  })
})

function createServiceClient() {
  return createClient(
    requiredEnvironment('SUPABASE_URL'),
    requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
  )
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)
  if (value === undefined || value.trim() === '') {
    throw new Error('missing configuration')
  }
  return value
}

async function findPassage(client: any, input: PassageRequest) {
  const embedding = assertQueryEmbedding(
    await embeddingSession.run(input.theme, { mean_pool: true, normalize: true }),
  )
  const rows = await data<HybridAnchorRow[]>(client.rpc('hybrid_match_subtitle_chunks', {
    query_text: input.theme,
    query_embedding: embedding,
    match_count: ANCHOR_MATCH_COUNT,
    full_text_weight: 1,
    semantic_weight: 2,
    rrf_k: 50,
    filter_movie_id: null,
  }))
  const anchors = rows.map(toAnchor)
  const readyAnchors = await filterReadyAnchors(client, anchors)
  const ranges = cueRanges(readyAnchors, input.sceneCount)
  const cueRows = (await Promise.all(ranges.map(async range => await data<CueRow[]>(
    client
      .from('subtitle_cues')
      .select('track_id, cue_index, start_ms, end_ms, text')
      .eq('track_id', range.trackId)
      .gte('cue_index', range.firstCueIndex)
      .lte('cue_index', range.lastCueIndex)
      .order('cue_index', { ascending: true }),
  )))).flat()

  return selectContinuousPassage({
    theme: input.theme,
    sceneCount: input.sceneCount,
    anchors: readyAnchors,
    cues: cueRows.map(toCue),
  })
}

async function filterReadyAnchors(client: any, anchors: PassageAnchor[]): Promise<PassageAnchor[]> {
  const trackIds = [...new Set(anchors.map(anchor => anchor.trackId))]
  if (trackIds.length === 0) {
    throw new NoEligiblePassageError()
  }
  const readyTracks = await data<TrackRow[]>(
    client
      .from('subtitle_tracks')
      .select('id')
      .in('id', trackIds)
      .eq('status', 'ready'),
  )
  const readyTrackIds = new Set(readyTracks.map(track => track.id))
  return anchors.filter(anchor => readyTrackIds.has(anchor.trackId))
}

function cueRanges(anchors: PassageAnchor[], sceneCount: number): TrackCueRange[] {
  const uniqueTrackIds = [...new Set(anchors.map(anchor => anchor.trackId))]
  return uniqueTrackIds.map(trackId => {
    const trackAnchors = anchors.filter(anchor => anchor.trackId === trackId)
    return {
      trackId,
      firstCueIndex: Math.max(
        0,
        Math.min(...trackAnchors.map(anchor => anchor.firstCueIndex)) - sceneCount + 1,
      ),
      lastCueIndex: Math.max(...trackAnchors.map(anchor => anchor.lastCueIndex)) + sceneCount - 1,
    }
  })
}

function toAnchor(row: HybridAnchorRow): PassageAnchor {
  return {
    similarity: row.similarity,
    movieId: row.movie_id,
    movieTitle: row.movie_title,
    releaseYear: row.movie_release_year,
    trackId: row.track_id,
    firstCueIndex: row.first_cue_index,
    lastCueIndex: row.last_cue_index,
  }
}

function toCue(row: CueRow): PassageCue {
  return {
    trackId: row.track_id,
    cueIndex: row.cue_index,
    startMs: row.start_ms,
    endMs: row.end_ms,
    text: row.text,
  }
}

async function data<T>(query: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  const result = await query
  if (result.error !== null) {
    throw new Error('database operation failed')
  }
  return result.data
}
