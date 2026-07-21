import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationPath = resolve(process.cwd(), 'supabase/migrations/20260721090000_local_video_workbench_v2.sql')
const databaseTestPath = resolve(process.cwd(), 'supabase/tests/database/video_production_v2.sql')
const v1MigrationPath = resolve(process.cwd(), 'supabase/migrations/20260719024919_video_production.sql')

const v2Functions = [
  'start_video_render_v2',
  'record_video_asset_download_v2',
  'begin_video_render_v2',
  'complete_video_render_v2',
  'fail_video_render_v2',
  'retry_video_render_v2',
] as const

function functionSource(source: string, name: string): string {
  const marker = `create or replace function public.${name}`
  const start = source.indexOf(marker)
  const end = source.indexOf('\n$$;', start)
  if (start < 0 || end < 0) throw new Error(`could not resolve ${name}`)
  return source.slice(start, end + 4)
}

describe('video production v2 migration', () => {
  it('is additive and keeps the v1 migration source unchanged', () => {
    const v1 = readFileSync(v1MigrationPath, 'utf8')
    const source = readFileSync(migrationPath, 'utf8')

    expect(v1).toContain('create function public.start_video_render(')
    expect(v1).toContain('create function public.complete_video_render(')
    expect(source).not.toMatch(/\b(?:drop table|truncate)\b/i)
    expect(source).not.toMatch(/update\s+public\.video_(?:render_jobs|asset_downloads|render_segments)\s+set\s+workflow_version/i)
    expect(source).toContain('add column if not exists workflow_version')
    expect(source).toContain('add column if not exists reservation_id')
  })

  it('defines exactly six hardened v2 RPCs', () => {
    const source = readFileSync(migrationPath, 'utf8')
    const created = [...source.matchAll(/create or replace function public\.([a-z0-9_]+_v2)\s*\(/g)]
      .map(match => match[1])

    expect([...created].sort()).toEqual([...v2Functions].sort())
    expect(source.match(/security invoker/g)).toHaveLength(6)
    expect(source.match(/set search_path = ''/g)).toHaveLength(6)
    for (const name of v2Functions) {
      const body = functionSource(source, name)
      expect(body).toContain('security invoker')
      expect(body).toContain("set search_path = ''")
      expect(body).toContain('#variable_conflict error')
      expect(source).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^;]+\\) from public, anon, authenticated;`))
      expect(source).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^;]+\\) to service_role, postgres;`))
    }
    expect(source).not.toMatch(/security definer/i)
  })

  it('keeps all production tables private behind forced RLS', () => {
    const source = readFileSync(migrationPath, 'utf8')
    for (const table of ['video_render_jobs', 'video_asset_downloads', 'video_render_segments']) {
      expect(source).toContain(`alter table public.${table} enable row level security`)
      expect(source).toContain(`alter table public.${table} force row level security`)
      expect(source).toContain(`revoke all on table public.${table} from public, anon, authenticated`)
    }
    expect(source).not.toMatch(/create policy/i)
    expect(source).not.toMatch(/grant [^;]+ to (?:anon|authenticated)/i)
  })

  it('scopes dynamic checks to workflow version two', () => {
    const source = readFileSync(migrationPath, 'utf8')

    expect(source).toContain('workflow_version = 2')
    expect(source).toMatch(/scene_count between 5 and 10/i)
    expect(source).toContain('source_end_cue_index = source_start_cue_index + scene_count - 1')
    expect(source).toMatch(/expected_duration_ms between 15000 and 60000/i)
    expect(source).toContain("aspect_ratio = '16:9' and target_width = 1920 and target_height = 1080")
    expect(source).toContain("aspect_ratio = '9:16' and target_width = 1080 and target_height = 1920")
    expect(source).toContain('reservation_id uuid')
    expect(source).toContain('artifact_task_id uuid')
    expect(source).toContain('output_width integer')
    expect(source).toContain('output_height integer')
    expect(source).toMatch(/workflow_version is null[\s\S]+audio_codec is not null/i)
    expect(source).toMatch(/workflow_version = 2[\s\S]+audio_codec is null/i)
    for (const requiredColumn of [
      'aspect_ratio', 'scene_count', 'source_track_id', 'source_start_cue_index',
      'source_end_cue_index', 'expected_duration_ms',
    ]) {
      expect(source).toContain(`${requiredColumn} is not null`)
    }

    const start = functionSource(source, 'start_video_render_v2')
    for (const requiredParameter of [
      'p_aspect_ratio', 'p_width', 'p_height', 'p_scene_count',
      'p_source_end_cue_index', 'p_expected_duration_ms',
    ]) {
      expect(start).toContain(`${requiredParameter} is null`)
    }
  })

  it('validates the complete silent timeline at the database boundary', () => {
    const source = functionSource(readFileSync(migrationPath, 'utf8'), 'complete_video_render_v2')

    expect(source).toContain('pg_catalog.generate_series(0, v_persisted_job.scene_count - 1)')
    expect(source).toContain('download.workflow_version = 2')
    expect(source).toContain('segment.source_track_id <> v_persisted_job.source_track_id')
    expect(source).toContain('segment.source_cue_index <> v_persisted_job.source_start_cue_index + segment.segment_index')
    expect(source).toContain('cue.text is distinct from segment.caption_en')
    expect(source).toContain('segment.timeline_end_ms - segment.timeline_start_ms <> cue.end_ms - cue.start_ms')
    expect(source).toContain('segment.source_out_ms - segment.source_in_ms <> cue.end_ms - cue.start_ms')
    expect(source).toContain('segment.timeline_start_ms = 0')
    expect(source).toContain('previous_timeline_end_ms')
    expect(source).toContain("v_output_video_codec <> 'h264'")
    expect(source).toContain("v_output_pixel_format <> 'yuv420p'")
    expect(source).toContain('v_output_audio_codec is not null')
    expect(source).toContain('v_output_width <> v_persisted_job.target_width')
    for (const requiredOutput of [
      'v_output_width', 'v_output_height', 'v_output_video_codec', 'v_output_pixel_format',
    ]) {
      expect(source).toContain(`${requiredOutput} is null`)
    }
    for (const requiredBoundary of [
      'segment.timeline_start_ms', 'segment.timeline_end_ms',
      'segment.source_in_ms', 'segment.source_out_ms',
    ]) {
      expect(source).toContain(`${requiredBoundary} is null`)
    }
    expect(source).toContain('v_output_artifact_task_id is distinct from v_persisted_job.artifact_task_id')
    expect(source).toContain('pg_catalog.abs(v_output_duration_ms - v_persisted_job.expected_duration_ms) > 1000')
  })

  it('ships rollback-isolated pgTAP for both orientations and v1 compatibility', () => {
    const source = readFileSync(databaseTestPath, 'utf8')

    expect(source).toMatch(/^begin;/m)
    expect(source).toMatch(/^rollback;/m)
    expect(source).toContain('start_video_render_v2')
    expect(source).toContain('complete_video_render_v2')
    expect(source).toContain('five-scene landscape')
    expect(source).toContain('ten-scene portrait')
    expect(source).toContain('v1 start remains compatible')
    expect(source).toContain('v1 complete remains compatible')
    expect(source).toContain('reservation')
    expect(source).toContain('null audio')
  })
})
