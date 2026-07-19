import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationDirectory = resolve(process.cwd(), 'supabase/migrations')
const matchingMigrations = readdirSync(migrationDirectory)
  .filter(fileName => fileName.endsWith('_video_asset_matching.sql'))
const coalesceRepairMigrations = readdirSync(migrationDirectory)
  .filter(fileName => fileName.endsWith('_fix_video_asset_coalesce.sql'))

function migrationSource(): string {
  if (matchingMigrations.length !== 1) {
    throw new Error(`expected exactly one video asset migration, found ${matchingMigrations.length}`)
  }

  return readFileSync(resolve(migrationDirectory, matchingMigrations[0]), 'utf8')
}

function coalesceRepairSource(): string {
  if (coalesceRepairMigrations.length !== 1) {
    throw new Error(`expected exactly one coalesce repair migration, found ${coalesceRepairMigrations.length}`)
  }

  return readFileSync(resolve(migrationDirectory, coalesceRepairMigrations[0]), 'utf8')
}

describe('video asset matching migration', () => {
  it('resolves exactly one CLI-generated migration', () => {
    expect(matchingMigrations).toHaveLength(1)
  })

  it('creates all five private tables with forced RLS and service-role grants', () => {
    const source = migrationSource()
    const tables = [
      'visual_concepts',
      'video_search_runs',
      'video_search_queries',
      'video_search_candidates',
      'video_asset_selections',
    ]

    for (const table of tables) {
      expect(source).toContain(`create table public.${table}`)
      expect(source).toContain(`alter table public.${table} enable row level security`)
      expect(source).toContain(`alter table public.${table} force row level security`)
      expect(source).toContain(`revoke all on table public.${table} from public, anon, authenticated`)
      expect(source).toContain(`grant select, insert, update, delete on table public.${table} to service_role`)
    }
  })

  it('defines only empty-search-path security-invoker RPCs', () => {
    const source = migrationSource()
    const functions = [
      'begin_video_search_run',
      'finish_video_search_run',
      'match_visual_concept',
      'upsert_visual_concepts',
      'select_video_asset',
    ]

    for (const functionName of functions) {
      expect(source).toContain(`create function public.${functionName}`)
    }
    expect(source.match(/security invoker/g)).toHaveLength(functions.length)
    expect(source.match(/set search_path = ''/g)).toHaveLength(functions.length)
    expect(source.match(/revoke all on function/g)).toHaveLength(functions.length)
    expect(source.match(/grant execute on function[^;]+to service_role, postgres/g)).toHaveLength(functions.length)
    expect(source).not.toContain('security definer')
  })

  it('enforces RRF candidate data and allowlisted provider metadata', () => {
    const source = migrationSource()

    expect(source).toContain("input_digest ~ '^[0-9a-f]{64}$'")
    expect(source).toMatch(/candidate_count[^\n]+between 5 and 10/)
    expect(source).toMatch(/kind[^\n]+in \('literal', 'action', 'metaphor'\)/)
    expect(source).toMatch(/provider[^\n]+check \(provider = 'vecteezy'\)/)
    expect(source).toMatch(/fused_score > 0[^\n]+fused_score < 'Infinity'::double precision/)
    expect(source).toMatch(/best_rank > 0/)
    expect(source).toContain('pg_catalog.jsonb_array_length(p_candidates) > 10')
    expect(source).toContain("jsonb_typeof(file_types) = 'array'")
    expect(source).toContain("jsonb_typeof(download_sizes) = 'array'")
    expect(source).toContain("@.key != \"extension\" && @.key != \"sizeInBytes\"")
    expect(source).toContain("@.key != \"id\" && @.key != \"width\" && @.key != \"height\"")
  })

  it('enforces active-run idempotency and candidate-owned selections', () => {
    const source = migrationSource()

    expect(source).toContain('create unique index video_search_runs_active_digest_idx')
    expect(source).toContain("where status in ('planning', 'completed', 'degraded')")
    expect(source).toContain('constraint video_search_candidates_run_id_id_key unique (run_id, id)')
    expect(source).toContain('constraint video_asset_selections_candidate_owner_fkey')
    expect(source).toContain('foreign key (run_id, candidate_id)')
    expect(source).toContain('references public.video_search_candidates(run_id, id)')
    expect(source).toContain('on delete cascade')
  })

  it('repairs SQL-special COALESCE calls without weakening the RPCs', () => {
    const source = coalesceRepairSource()

    expect(coalesceRepairMigrations).toHaveLength(1)
    expect(source).toContain('create or replace function public.finish_video_search_run')
    expect(source).toContain('create or replace function public.upsert_visual_concepts')
    expect(source).not.toContain('pg_catalog.coalesce')
    expect(source.match(/security invoker/g)).toHaveLength(2)
    expect(source.match(/set search_path = ''/g)).toHaveLength(2)
  })
})
