import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationDirectory = resolve(process.cwd(), 'supabase/migrations')
const matchingMigrations = readdirSync(migrationDirectory)
  .filter(fileName => fileName.endsWith('_video_production.sql'))
const databaseTestPath = resolve(process.cwd(), 'supabase/tests/database/video_production.sql')

function migrationSource(): string {
  if (matchingMigrations.length !== 1) {
    throw new Error(`expected exactly one video production migration, found ${matchingMigrations.length}`)
  }

  return readFileSync(resolve(migrationDirectory, matchingMigrations[0]), 'utf8')
}

function rpcSource(source: string, name: string): string {
  const createMarker = `create function public.${name}`
  const replaceMarker = `create or replace function public.${name}`
  const start = Math.max(source.indexOf(createMarker), source.indexOf(replaceMarker))
  const end = source.indexOf('\n$$;', start)

  if (start < 0 || end < 0) {
    throw new Error(`could not resolve RPC source for ${name}`)
  }

  return source.slice(start, end + 4)
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

  it('makes every PL/pgSQL RPC fail closed on identifier ambiguity', () => {
    const source = migrationSource()
    const functions = [
      'start_video_render',
      'record_video_asset_download',
      'begin_video_render',
      'complete_video_render',
      'fail_video_render',
      'retry_video_render',
      'select_video_asset',
    ]

    expect(source.match(/#variable_conflict error/g)).toHaveLength(functions.length)
    for (const name of functions) {
      const body = rpcSource(source, name)
      const declarationBlock = body.match(/\ndeclare\n([\s\S]*?)\nbegin/)

      expect(body).not.toMatch(/\bwhere (?:id|status|render_id|selection_id|request_digest|run_id)\s*=/)
      if (declarationBlock) {
        for (const declaration of declarationBlock[1].split('\n').map(line => line.trim()).filter(Boolean)) {
          expect(declaration, `${name} local variable`).toMatch(/^v_[a-z0-9_]+\s/)
        }
      }
    }

    expect(rpcSource(source, 'begin_video_render')).toContain('select job.status into v_persisted_status')
    expect(rpcSource(source, 'complete_video_render')).toContain('output_artifact_key = v_output_artifact_key')
  })

  it('persists only allowlisted server-controlled failure messages', () => {
    const source = migrationSource()
    const body = rpcSource(source, 'fail_video_render')

    expect(body).toContain('case p_failure_code')
    expect(body).toContain("when 'render_failure' then 'video render failed'")
    expect(body).not.toContain('failure_message = p_failure_message')
    expect(source).toContain("failure_code in ('download_failure', 'source_validation_failure', 'render_failure', 'metadata_failure')")
  })

  it('retries to downloading when verified downloads already exist', () => {
    const body = rpcSource(migrationSource(), 'retry_video_render')

    expect(body).toContain('v_retry_status := case')
    expect(body).toContain('from public.video_asset_downloads as download')
    expect(body).toContain('where download.render_id = p_render_id')
    expect(body).toContain('set status = v_retry_status')
    expect(body).toContain('return query select v_retry_status')
  })

  it('grants service role only the table operations required by invoker RPCs', () => {
    const source = migrationSource()

    expect(source).toContain('grant select, insert, update on table public.video_render_jobs to service_role')
    expect(source).toContain('grant select, insert on table public.video_asset_downloads to service_role')
    expect(source).toContain('grant select, insert on table public.video_render_segments to service_role')
    expect(source).not.toMatch(/grant [^;]*\bdelete\b[^;]* to service_role/i)
  })

  it('uses aggregate pgTAP assertions for exact browser and service privileges', () => {
    const databaseTest = readFileSync(databaseTestPath, 'utf8')

    expect(databaseTest).toContain("values ('public'::name), ('anon'::name), ('authenticated'::name)")
    expect(databaseTest).toContain("array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']::text[]")
    expect(databaseTest).toContain('has_table_privilege(client_role.role_name, private_table.table_name, table_privilege.privilege_name)')
    expect(databaseTest).toContain('has_function_privilege(client_role.role_name, production_rpc.rpc_name, \'execute\')')
    expect(databaseTest).toContain("has_table_privilege('service_role', expected_privilege.table_name, expected_privilege.privilege_name)")
    expect(databaseTest).toContain('is distinct from expected_privilege.is_granted')
  })

  it('verifies index tables columns access methods and predicates in pgTAP', () => {
    const databaseTest = readFileSync(databaseTestPath, 'utf8')

    expect(databaseTest).toContain('pg_catalog.pg_index')
    expect(databaseTest).toContain('pg_catalog.pg_attribute')
    expect(databaseTest).toContain('pg_catalog.pg_get_expr')
    expect(databaseTest).toContain('expected_index.expected_columns')
    expect(databaseTest).not.toContain('from pg_catalog.pg_indexes')
  })
})
