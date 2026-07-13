import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260713090000_atomic_subtitle_ingestion.sql'),
  'utf8',
)
const handler = readFileSync(
  resolve(process.cwd(), 'supabase/functions/ingest-subtitles/index.ts'),
  'utf8',
)

describe('atomic subtitle ingestion RPC contracts', () => {
  it('locks each track and rejects later writes after the track is ready', () => {
    expect(migration).toContain('create function public.ingest_subtitle_batch(')
    expect(migration).toContain('for update')
    expect(migration).toContain("track_status = 'ready'")
    expect(migration).toContain("raise exception using errcode = 'P0001'")
    expect(migration).toContain('insert into public.subtitle_cues')
    expect(migration).toContain('insert into public.subtitle_chunks')
  })

  it('finalizes under the same row lock after checking every persisted cue index in each chunk range', () => {
    expect(migration).toContain('create function public.finalize_subtitle_track(')
    expect(migration).toContain('pg_catalog.generate_series')
    expect(migration).toContain('left join public.subtitle_cues')
    expect(migration).toMatch(/update public\.subtitle_tracks\s+set status = 'ready'/)
  })

  it('keeps the RPCs security invoker-only with an empty search path and service-role execution', () => {
    for (const signature of [
      'public.ingest_subtitle_batch(bigint, jsonb, jsonb)',
      'public.finalize_subtitle_track(bigint)',
    ]) {
      expect(migration).toContain('security invoker')
      expect(migration).toContain("set search_path = ''")
      expect(migration).toContain(`revoke all on function ${signature} from public, anon, authenticated;`)
      expect(migration).toContain(`grant execute on function ${signature} to service_role;`)
    }
  })

  it('uses only the transactional RPCs for batch and finalize writes', () => {
    expect(handler).toContain(".rpc('reserve_subtitle_chunk_claims'")
    expect(handler).toContain(".rpc('complete_subtitle_chunk_claims'")
    expect(handler).toContain(".rpc('finalize_subtitle_track'")
    expect(handler).not.toContain(".rpc('ingest_subtitle_batch'")
    expect(handler).not.toContain("from('subtitle_cues').upsert")
    expect(handler).not.toContain("from('subtitle_chunks').upsert")
    expect(handler).not.toContain("update({ status: 'ready' })")
  })
})
