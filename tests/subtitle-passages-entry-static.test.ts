import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const entryPath = resolve(process.cwd(), 'supabase/functions/subtitle-passages/index.ts')

describe('subtitle passages Edge entry', () => {
  it('uses pinned imports and authenticates before parsing JSON or creating clients', () => {
    const source = readFileSync(entryPath, 'utf8')

    expect(source).toContain("import 'jsr:@supabase/functions-js/edge-runtime.d.ts'")
    expect(source).toContain("from 'npm:@supabase/supabase-js@2.110.2'")
    expect(source).toContain('handleAuthenticatedRequest(request, Deno.env')
    expect(source.indexOf('handleAuthenticatedRequest(request, Deno.env'))
      .toBeLessThan(source.indexOf('request.json()'))
    expect(source.indexOf('handleAuthenticatedRequest(request, Deno.env'))
      .toBeLessThan(source.indexOf('createServiceClient()'))
  })

  it('embeds the theme and requests at least twenty hybrid anchors', () => {
    const source = readFileSync(entryPath, 'utf8')

    expect(source).toContain("new Supabase.ai.Session('gte-small')")
    expect(source).toContain(
      'embeddingSession.run(input.theme, { mean_pool: true, normalize: true })',
    )
    expect(source).toMatch(/const ANCHOR_MATCH_COUNT\s*=\s*(?:[2-9]\d|\d{3,})/)
    expect(source).toContain("client.rpc('hybrid_match_subtitle_chunks'")
    expect(source).toContain('query_text: input.theme')
    expect(source).toContain('query_embedding: embedding')
    expect(source).toContain('match_count: ANCHOR_MATCH_COUNT')
    expect(source).toContain('full_text_weight: 1')
    expect(source).toContain('semantic_weight: 2')
    expect(source).toContain('rrf_k: 50')
  })

  it('hydrates bounded cue ranges from ready tracks with exact source fields', () => {
    const source = readFileSync(entryPath, 'utf8')

    expect(source).toContain(".from('subtitle_tracks')")
    expect(source).toContain(".eq('status', 'ready')")
    expect(source).toContain('buildPassageCueRanges(readyAnchors, input.sceneCount)')
    expect(source).toContain(".from('subtitle_cues')")
    expect(source).toContain(".select('track_id, cue_index, start_ms, end_ms, text')")
    expect(source).toContain(".eq('track_id', range.trackId)")
    expect(source).toContain(".gte('cue_index', range.firstCueIndex)")
    expect(source).toContain(".lte('cue_index', range.lastCueIndex)")
    expect(source).toContain(".order('cue_index', { ascending: true })")
    expect(source).toContain('deduplicatePassageCues(cueRows.map(toCue))')
    expect(source).not.toContain('Math.min(...trackAnchors.map')
  })

  it('returns one canonical passage and controlled failures without logging subtitle text', () => {
    const source = readFileSync(entryPath, 'utf8')

    expect(source).toContain('selectContinuousPassage({')
    expect(source).toContain('return jsonResponse(buildPassageResponse(passage))')
    expect(source).toContain("errorResponse(405, 'method_not_allowed'")
    expect(source).toContain("errorResponse(400, error.code, error.message)")
    expect(source).toContain("errorResponse(422, 'no_eligible_passage'")
    expect(source).toContain("errorResponse(500, 'passage_search_failed'")
    expect(source).not.toContain('english_theme_required')
    expect(source).not.toContain('console.log')
    expect(source).not.toContain('console.error')
  })
})
