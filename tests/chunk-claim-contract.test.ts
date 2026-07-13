import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260713093000_subtitle_chunk_claims.sql'),
  'utf8',
)
const handler = readFileSync(
  resolve(process.cwd(), 'supabase/functions/ingest-subtitles/index.ts'),
  'utf8',
)

describe('subtitle chunk claim contracts', () => {
  it('uses a durable, private claim table keyed by track and chunk index', () => {
    expect(migration).toContain('create table public.subtitle_chunk_claims')
    expect(migration).toContain('primary key (track_id, chunk_index)')
    expect(migration).toContain('claim_token uuid not null')
    expect(migration).toContain('claimed_at timestamptz not null')
    expect(migration).toContain('force row level security')
    expect(migration).toContain('revoke all on table public.subtitle_chunk_claims from public, anon, authenticated;')
  })

  it('serializes same-index reservations, excludes completed chunks, and permits only stale claim takeover', () => {
    expect(migration).toContain('create function public.reserve_subtitle_chunk_claims(')
    expect(migration).toContain('for update')
    expect(migration).toContain('not exists (')
    expect(migration).toContain('from public.subtitle_chunks as completed')
    expect(migration).toContain('on conflict (track_id, chunk_index) do update')
    expect(migration).toContain("claim.claimed_at < pg_catalog.statement_timestamp() - interval '10 minutes'")
    expect(migration).toContain('returning claim.chunk_index')
  })

  it('rejects wrong-token completion, never overwrites an embedding, and clears successful claims', () => {
    expect(migration).toContain('create function public.complete_subtitle_chunk_claims(')
    expect(migration).toContain('claim.claim_token = p_claim_token')
    expect(migration).toContain('on conflict (track_id, chunk_index) do nothing')
    expect(migration).toContain('delete from public.subtitle_chunk_claims as claim')
    expect(migration).toContain('from inserted_chunks as inserted')
    expect(migration).toContain('select pg_catalog.count(*)::integer')
  })

  it('rejects finalize while claims remain pending', () => {
    expect(migration).toContain('from public.subtitle_chunk_claims as claim')
    expect(migration).toContain("errcode = 'P0003'")
    expect(migration).toContain("message = 'subtitle track has pending chunk claims'")
  })

  it('limits claim RPC access to the service role with security invoker and an empty search path', () => {
    for (const signature of [
      'public.reserve_subtitle_chunk_claims(bigint, uuid, jsonb, jsonb)',
      'public.complete_subtitle_chunk_claims(bigint, uuid, jsonb)',
      'public.finalize_subtitle_track(bigint)',
    ]) {
      expect(migration).toContain('security invoker')
      expect(migration).toContain("set search_path = ''")
      expect(migration).toContain(`revoke all on function ${signature} from public, anon, authenticated;`)
      expect(migration).toContain(`grant execute on function ${signature} to service_role;`)
    }
  })

  it('uses an unguessable token and embeds only chunks returned by reservation', () => {
    expect(handler).toContain('crypto.randomUUID()')
    expect(handler).toContain(".rpc('reserve_subtitle_chunk_claims'")
    expect(handler).toContain(".rpc('complete_subtitle_chunk_claims'")
    expect(handler).not.toContain(".from('subtitle_chunks')\n      .select('chunk_index')")
    expect(handler).not.toContain(".rpc('ingest_subtitle_batch'")
  })
})
