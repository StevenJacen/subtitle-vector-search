import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationDirectory = resolve(process.cwd(), 'supabase/migrations')
const matchingMigrations = readdirSync(migrationDirectory)
  .filter(fileName => fileName.endsWith('_video_production.sql'))

function migrationSource(): string {
  if (matchingMigrations.length !== 1) {
    throw new Error(`expected exactly one video production migration, found ${matchingMigrations.length}`)
  }

  return readFileSync(resolve(migrationDirectory, matchingMigrations[0]), 'utf8')
}

describe('video production migration', () => {
  it('resolves exactly one CLI-generated migration', () => {
    expect(matchingMigrations).toHaveLength(1)
  })

  it('creates private production tables and security-invoker RPCs', () => {
    const source = migrationSource()
    const tables = ['video_render_jobs', 'video_asset_downloads', 'video_render_segments']
    const functions = [
      'start_video_render',
      'record_video_asset_download',
      'begin_video_render',
      'complete_video_render',
      'fail_video_render',
      'retry_video_render',
    ]

    for (const table of tables) {
      expect(source).toContain(`create table public.${table}`)
      expect(source).toContain(`alter table public.${table} enable row level security`)
      expect(source).toContain(`alter table public.${table} force row level security`)
      expect(source).toContain(`revoke all on table public.${table} from public, anon, authenticated`)
    }
    for (const name of functions) {
      expect(source).toContain(`create function public.${name}`)
    }
    expect(source.match(/security invoker/g)).toHaveLength(7)
    expect(source.match(/set search_path = ''/g)).toHaveLength(7)
    expect(source).toContain('foreign key (render_id, download_id)')
    expect(source).toContain('references public.video_asset_downloads(render_id, id)')
    expect(source).toContain('foreign key (selection_id, candidate_id)')
    expect(source).toContain('create or replace function public.select_video_asset')
    expect(source).not.toMatch(/download_url|signed_url|status_url/i)
  })
})
