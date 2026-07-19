import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationDirectory = resolve(process.cwd(), 'supabase/migrations')
const matchingMigrations = readdirSync(migrationDirectory)
  .filter(fileName => fileName.endsWith('_video_production.sql'))
const failRenderLintMigrations = readdirSync(migrationDirectory)
  .filter(fileName => fileName.endsWith('_silence_fail_video_render_lint.sql'))
const foreignKeyIndexMigrations = readdirSync(migrationDirectory)
  .filter(fileName => fileName.endsWith('_cover_video_production_foreign_keys.sql'))
const retryRecoveryMigrations = readdirSync(migrationDirectory)
  .filter(fileName => fileName.endsWith('_idempotent_retry_video_render.sql'))
const stableAttributionMigrations = readdirSync(migrationDirectory)
  .filter(fileName => fileName.endsWith('_protect_attribution_urls.sql'))
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

  it('consumes the compatibility failure message without persisting it', () => {
    expect(failRenderLintMigrations).toHaveLength(1)
    const source = readFileSync(resolve(migrationDirectory, failRenderLintMigrations[0]), 'utf8')

    expect(source).toContain('perform pg_catalog.length(p_failure_message)')
    expect(source).not.toContain('failure_message = p_failure_message')
  })

  it('covers every composite production foreign key in constraint order', () => {
    expect(foreignKeyIndexMigrations).toHaveLength(1)
    const source = readFileSync(resolve(migrationDirectory, foreignKeyIndexMigrations[0]), 'utf8')

    expect(source).toContain('video_asset_downloads (selection_id, candidate_id)')
    expect(source).toContain('video_asset_selections (run_id, candidate_id)')
    expect(source).toContain('video_render_segments (render_id, download_id)')
  })

  it('retries to downloading when verified downloads already exist', () => {
    const body = rpcSource(migrationSource(), 'retry_video_render')

    expect(body).toContain('v_retry_status := case')
    expect(body).toContain('from public.video_asset_downloads as download')
    expect(body).toContain('where download.render_id = p_render_id')
    expect(body).toContain('set status = v_retry_status')
    expect(body).toContain('return query select v_retry_status')
  })

  it('makes retry replay-safe after a committed response is lost', () => {
    expect(retryRecoveryMigrations).toHaveLength(1)
    const source = readFileSync(resolve(migrationDirectory, retryRecoveryMigrations[0]), 'utf8')

    expect(source).toContain('create or replace function public.retry_video_render')
    expect(source).toContain("if v_persisted_status in ('planned', 'downloading')")
    expect(source).toContain('and v_persisted_status = v_retry_status')
    expect(source).toContain('return query select v_persisted_status')
    expect(source).toContain("if v_persisted_status <> 'failed'")
    expect(source).toContain('security invoker')
    expect(source).toContain("set search_path = ''")
    expect(source).toContain('revoke all on function public.retry_video_render(uuid) from public, anon, authenticated')
  })

  it('prevents temporary or signed attribution URLs at the database boundary', () => {
    expect(stableAttributionMigrations).toHaveLength(1)
    const source = readFileSync(resolve(migrationDirectory, stableAttributionMigrations[0]), 'utf8')

    expect(source).toContain('drop constraint video_asset_downloads_attribution_check')
    expect(source).toContain('add constraint video_asset_downloads_attribution_check check')
    expect(source).toContain("required_attribution_url !~ '[?#]'")
    expect(source).toContain("required_attribution_url !~ '^https://[^/]*@'")
    expect(source).toContain('required_attribution_url !~*')
    expect(source).toMatch(/signature\|x-amz-/)
  })

  it('grants service role only the table operations required by invoker RPCs', () => {
    const source = migrationSource()

    expect(source).toContain('grant select, insert, update on table public.video_render_jobs to service_role')
    expect(source).toContain('grant select, insert on table public.video_asset_downloads to service_role')
    expect(source).toContain('grant select, insert on table public.video_render_segments to service_role')
    expect(source).not.toMatch(/grant [^;]*\bdelete\b[^;]* to service_role/i)
  })

  it('clears inherited service role privileges before applying minimum grants', () => {
    const source = migrationSource()
    const aclChanges = [
      {
        revoke: 'revoke all on table public.video_render_jobs from service_role;',
        grant: 'grant select, insert, update on table public.video_render_jobs to service_role;',
      },
      {
        revoke: 'revoke all on table public.video_asset_downloads from service_role;',
        grant: 'grant select, insert on table public.video_asset_downloads to service_role;',
      },
      {
        revoke: 'revoke all on table public.video_render_segments from service_role;',
        grant: 'grant select, insert on table public.video_render_segments to service_role;',
      },
      {
        revoke: 'revoke all on sequence public.video_asset_downloads_id_seq from service_role;',
        grant: 'grant usage on sequence public.video_asset_downloads_id_seq to service_role;',
      },
      {
        revoke: 'revoke all on sequence public.video_render_segments_id_seq from service_role;',
        grant: 'grant usage on sequence public.video_render_segments_id_seq to service_role;',
      },
    ]

    for (const aclChange of aclChanges) {
      expect(source).toContain(aclChange.revoke)
      expect(source.indexOf(aclChange.revoke)).toBeLessThan(source.indexOf(aclChange.grant))
    }
  })

  it('uses the standard-conforming traversal regex in every artifact-key check', () => {
    const source = migrationSource()
    const traversalPattern = "'(^|/)\\.\\.(/|$)'"
    const overEscapedTraversalPattern = "'(^|/)\\\\.\\\\.(/|$)'"

    expect(source.split(traversalPattern)).toHaveLength(4)
    expect(source).not.toContain(overEscapedTraversalPattern)
  })

  it('uses aggregate pgTAP assertions for exact browser and service privileges', () => {
    const databaseTest = readFileSync(databaseTestPath, 'utf8')

    expect(databaseTest).toContain('create extension if not exists pgtap with schema extensions')
    expect(databaseTest).toContain('set local search_path = public, extensions')
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
