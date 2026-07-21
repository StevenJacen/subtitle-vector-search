alter table public.video_render_jobs
  add column if not exists workflow_version smallint,
  add column if not exists aspect_ratio text,
  add column if not exists scene_count integer,
  add column if not exists source_track_id bigint,
  add column if not exists source_start_cue_index integer,
  add column if not exists source_end_cue_index integer,
  add column if not exists expected_duration_ms integer,
  add column if not exists artifact_task_id uuid,
  add column if not exists output_width integer,
  add column if not exists output_height integer;

alter table public.video_asset_downloads
  add column if not exists workflow_version smallint,
  add column if not exists reservation_id uuid;

alter table public.video_render_segments
  add column if not exists workflow_version smallint;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.video_render_jobs'::pg_catalog.regclass
      and conname = 'video_render_jobs_workflow_version_check'
  ) then
    alter table public.video_render_jobs
      add constraint video_render_jobs_workflow_version_check
      check (workflow_version is null or workflow_version = 2);
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.video_render_jobs'::pg_catalog.regclass
      and conname = 'video_render_jobs_v2_request_check'
  ) then
    alter table public.video_render_jobs
      add constraint video_render_jobs_v2_request_check check (
        (workflow_version is null
          and aspect_ratio is null
          and scene_count is null
          and source_track_id is null
          and source_start_cue_index is null
          and source_end_cue_index is null
          and expected_duration_ms is null
          and artifact_task_id is null)
        or
        (workflow_version = 2
          and aspect_ratio is not null
          and scene_count is not null
          and source_track_id is not null
          and source_start_cue_index is not null
          and source_end_cue_index is not null
          and expected_duration_ms is not null
          and scene_count between 5 and 10
          and source_start_cue_index >= 0
          and source_end_cue_index = source_start_cue_index + scene_count - 1
          and expected_duration_ms between 15000 and 60000
          and target_duration_ms = expected_duration_ms
          and target_fps = 30
          and (
            (aspect_ratio = '16:9' and target_width = 1920 and target_height = 1080)
            or (aspect_ratio = '9:16' and target_width = 1080 and target_height = 1920)
          ))
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.video_render_jobs'::pg_catalog.regclass
      and conname = 'video_render_jobs_v2_source_start_fkey'
  ) then
    alter table public.video_render_jobs
      add constraint video_render_jobs_v2_source_start_fkey
      foreign key (source_track_id, source_start_cue_index)
      references public.subtitle_cues(track_id, cue_index);
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.video_render_jobs'::pg_catalog.regclass
      and conname = 'video_render_jobs_v2_source_end_fkey'
  ) then
    alter table public.video_render_jobs
      add constraint video_render_jobs_v2_source_end_fkey
      foreign key (source_track_id, source_end_cue_index)
      references public.subtitle_cues(track_id, cue_index);
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.video_asset_downloads'::pg_catalog.regclass
      and conname = 'video_asset_downloads_workflow_version_check'
  ) then
    alter table public.video_asset_downloads
      add constraint video_asset_downloads_workflow_version_check check (
        (workflow_version is null and reservation_id is null)
        or (workflow_version = 2 and reservation_id is not null)
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.video_render_segments'::pg_catalog.regclass
      and conname = 'video_render_segments_workflow_version_check'
  ) then
    alter table public.video_render_segments
      add constraint video_render_segments_workflow_version_check
      check (workflow_version is null or workflow_version = 2);
  end if;
end;
$$;

create or replace function public.fail_video_render_v2(
  p_render_id uuid,
  p_failure_code text,
  p_failure_message text
)
returns table (status text)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict error
declare
  v_persisted_job public.video_render_jobs%rowtype;
  v_failure_message text;
begin
  select job.* into v_persisted_job
  from public.video_render_jobs as job
  where job.id = p_render_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'render not found';
  end if;
  if v_persisted_job.workflow_version is distinct from 2 then
    raise exception using errcode = 'P0003', message = 'render is not version two';
  end if;
  if v_persisted_job.status not in ('planned', 'downloading', 'rendering') then
    raise exception using errcode = 'P0003', message = 'render cannot fail from its current state';
  end if;

  perform pg_catalog.length(p_failure_message);
  v_failure_message := case p_failure_code
    when 'download_failure' then 'video asset download failed'
    when 'source_validation_failure' then 'source validation failed'
    when 'render_failure' then 'video render failed'
    when 'metadata_failure' then 'production metadata failed'
    else null
  end;
  if v_failure_message is null then
    raise exception using errcode = 'P0005', message = 'failure data is incomplete';
  end if;

  update public.video_render_jobs as job
  set status = 'failed', failure_code = p_failure_code, failure_message = v_failure_message
  where job.id = p_render_id;

  return query select 'failed'::text;
end;
$$;

create or replace function public.retry_video_render_v2(p_render_id uuid)
returns table (status text)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict error
declare
  v_persisted_job public.video_render_jobs%rowtype;
  v_retry_status text;
begin
  select job.* into v_persisted_job
  from public.video_render_jobs as job
  where job.id = p_render_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'render not found';
  end if;
  if v_persisted_job.workflow_version is distinct from 2 then
    raise exception using errcode = 'P0003', message = 'render is not version two';
  end if;

  v_retry_status := case
    when exists (
      select 1 from public.video_asset_downloads as download
      where download.render_id = p_render_id and download.workflow_version = 2
    ) then 'downloading'
    else 'planned'
  end;

  if v_persisted_job.status in ('planned', 'downloading')
    and v_persisted_job.status = v_retry_status
    and v_persisted_job.failure_code is null
    and v_persisted_job.failure_message is null then
    return query select v_persisted_job.status;
    return;
  end if;
  if v_persisted_job.status <> 'failed' then
    raise exception using errcode = 'P0003', message = 'only failed renders can retry';
  end if;

  update public.video_render_jobs as job
  set status = v_retry_status, failure_code = null, failure_message = null
  where job.id = p_render_id;

  return query select v_retry_status;
end;
$$;

alter table public.video_render_jobs enable row level security;
alter table public.video_render_jobs force row level security;
revoke all on table public.video_render_jobs from public, anon, authenticated;

alter table public.video_asset_downloads enable row level security;
alter table public.video_asset_downloads force row level security;
revoke all on table public.video_asset_downloads from public, anon, authenticated;

alter table public.video_render_segments enable row level security;
alter table public.video_render_segments force row level security;
revoke all on table public.video_render_segments from public, anon, authenticated;

create or replace function public.begin_video_render_v2(p_render_id uuid)
returns table (status text)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict error
declare
  v_persisted_job public.video_render_jobs%rowtype;
  v_download_count bigint;
begin
  select job.* into v_persisted_job
  from public.video_render_jobs as job
  where job.id = p_render_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'render not found';
  end if;
  if v_persisted_job.workflow_version is distinct from 2 then
    raise exception using errcode = 'P0003', message = 'render is not version two';
  end if;
  if v_persisted_job.status <> 'downloading' then
    raise exception using errcode = 'P0003', message = 'render is not ready to begin';
  end if;

  select pg_catalog.count(*) into v_download_count
  from public.video_asset_downloads as download
  where download.render_id = p_render_id
    and download.workflow_version = 2
    and download.reservation_id is not null;

  if v_download_count <> v_persisted_job.scene_count then
    raise exception using errcode = 'P0005', message = 'render requires one verified download per scene';
  end if;

  update public.video_render_jobs as job
  set status = 'rendering'
  where job.id = p_render_id;

  return query select 'rendering'::text;
end;
$$;

create or replace function public.complete_video_render_v2(
  p_render_id uuid,
  p_segments jsonb,
  p_output jsonb
)
returns table (status text)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict error
declare
  v_persisted_job public.video_render_jobs%rowtype;
  v_output_artifact_key text;
  v_output_artifact_task_id uuid;
  v_output_sha256 text;
  v_output_size_bytes bigint;
  v_output_duration_ms integer;
  v_output_width integer;
  v_output_height integer;
  v_output_video_codec text;
  v_output_audio_codec text;
  v_output_pixel_format text;
  v_output_ffmpeg_version text;
  v_output_manifest_sha256 text;
  v_segment_indices integer[];
  v_expected_indices integer[];
  v_supplied_segments jsonb;
  v_stored_segments jsonb;
begin
  select job.* into v_persisted_job
  from public.video_render_jobs as job
  where job.id = p_render_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'render not found';
  end if;
  if v_persisted_job.workflow_version is distinct from 2 then
    raise exception using errcode = 'P0003', message = 'render is not version two';
  end if;
  if pg_catalog.jsonb_typeof(p_segments) <> 'array'
    or pg_catalog.jsonb_array_length(p_segments) <> v_persisted_job.scene_count
    or pg_catalog.jsonb_typeof(p_output) <> 'object' then
    raise exception using errcode = 'P0005', message = 'render completion is incomplete';
  end if;

  select
    output.artifact_key,
    output.output_sha256,
    output.output_size_bytes,
    output.output_duration_ms,
    output.width,
    output.height,
    output.video_codec,
    output.audio_codec,
    output.pixel_format,
    output.ffmpeg_version,
    output.manifest_sha256
  into
    v_output_artifact_key,
    v_output_sha256,
    v_output_size_bytes,
    v_output_duration_ms,
    v_output_width,
    v_output_height,
    v_output_video_codec,
    v_output_audio_codec,
    v_output_pixel_format,
    v_output_ffmpeg_version,
    v_output_manifest_sha256
  from pg_catalog.jsonb_to_record(p_output) as output(
    artifact_key text,
    output_sha256 text,
    output_size_bytes bigint,
    output_duration_ms integer,
    width integer,
    height integer,
    video_codec text,
    audio_codec text,
    pixel_format text,
    ffmpeg_version text,
    manifest_sha256 text
  );

  if not (p_output ? 'audio_codec')
    or v_output_artifact_key is null
    or v_output_artifact_key !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    or v_output_artifact_key ~ '^[A-Za-z][A-Za-z0-9+.-]*:'
    or v_output_artifact_key ~ '(^|/)\.\.(/|$)'
    or v_output_artifact_key ~ '(^|/)\.(/|$)'
    or v_output_artifact_key ~ '//'
    or pg_catalog.split_part(v_output_artifact_key, '/', 1) <> 'video-runs'
    or pg_catalog.split_part(v_output_artifact_key, '/', 2) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or pg_catalog.split_part(v_output_artifact_key, '/', 3) = ''
    or v_output_sha256 is null or v_output_sha256 !~ '^[0-9a-f]{64}$'
    or v_output_size_bytes is null or v_output_size_bytes <= 0
    or v_output_duration_ms is null
    or pg_catalog.abs(v_output_duration_ms - v_persisted_job.expected_duration_ms) > 1000
    or v_output_width is null
    or v_output_width <> v_persisted_job.target_width
    or v_output_height is null
    or v_output_height <> v_persisted_job.target_height
    or v_output_video_codec is null
    or v_output_video_codec <> 'h264'
    or v_output_audio_codec is not null
    or v_output_pixel_format is null
    or v_output_pixel_format <> 'yuv420p'
    or v_output_ffmpeg_version is null or pg_catalog.btrim(v_output_ffmpeg_version) = ''
    or v_output_manifest_sha256 is null or v_output_manifest_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0005', message = 'render output is incomplete';
  end if;
  v_output_artifact_task_id := pg_catalog.split_part(v_output_artifact_key, '/', 2)::uuid;
  if v_output_artifact_task_id is distinct from v_persisted_job.artifact_task_id then
    raise exception using errcode = 'P0004', message = 'artifact task namespace conflict';
  end if;

  select pg_catalog.array_agg(segment.segment_index order by segment.segment_index)
  into v_segment_indices
  from pg_catalog.jsonb_to_recordset(p_segments) as segment(
    segment_index integer,
    download_id bigint,
    timeline_start_ms integer,
    timeline_end_ms integer,
    source_in_ms integer,
    source_out_ms integer,
    caption_en text,
    caption_zh text,
    source_track_id bigint,
    source_cue_index integer
  );
  select pg_catalog.array_agg(expected_index)
  into v_expected_indices
  from pg_catalog.generate_series(0, v_persisted_job.scene_count - 1) as expected_index;

  if v_segment_indices is distinct from v_expected_indices then
    raise exception using errcode = 'P0005', message = 'render segment indices are incomplete';
  end if;

  if (select pg_catalog.count(distinct segment.download_id)
      from pg_catalog.jsonb_to_recordset(p_segments) as segment(
        segment_index integer, download_id bigint, timeline_start_ms integer, timeline_end_ms integer,
        source_in_ms integer, source_out_ms integer, caption_en text, caption_zh text,
        source_track_id bigint, source_cue_index integer
      )) <> v_persisted_job.scene_count then
    raise exception using errcode = 'P0005', message = 'render downloads are incomplete';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_segments) as segment(
      segment_index integer, download_id bigint, timeline_start_ms integer, timeline_end_ms integer,
      source_in_ms integer, source_out_ms integer, caption_en text, caption_zh text,
      source_track_id bigint, source_cue_index integer
    )
    where segment.timeline_start_ms is null
      or segment.timeline_end_ms is null
      or segment.source_in_ms is null
      or segment.source_out_ms is null
  ) then
    raise exception using errcode = 'P0005', message = 'render segment boundaries are incomplete';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_segments) as segment(
      segment_index integer,
      download_id bigint,
      timeline_start_ms integer,
      timeline_end_ms integer,
      source_in_ms integer,
      source_out_ms integer,
      caption_en text,
      caption_zh text,
      source_track_id bigint,
      source_cue_index integer
    )
    left join public.video_asset_downloads as download
      on download.id = segment.download_id
      and download.render_id = p_render_id
      and download.workflow_version = 2
    left join public.subtitle_cues as cue
      on cue.track_id = segment.source_track_id
      and cue.cue_index = segment.source_cue_index
    where download.id is null
      or segment.source_track_id <> v_persisted_job.source_track_id
      or segment.source_cue_index <> v_persisted_job.source_start_cue_index + segment.segment_index
      or cue.track_id is null
      or cue.text is distinct from segment.caption_en
      or segment.caption_zh is null or pg_catalog.btrim(segment.caption_zh) = ''
      or segment.timeline_end_ms - segment.timeline_start_ms <> cue.end_ms - cue.start_ms
      or segment.source_out_ms - segment.source_in_ms <> cue.end_ms - cue.start_ms
      or segment.source_in_ms < 0
      or segment.source_out_ms > download.duration_ms
  ) then
    raise exception using errcode = 'P0006', message = 'segment caption or duration does not match source cue';
  end if;

  if not exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_segments) as segment(
      segment_index integer, download_id bigint, timeline_start_ms integer, timeline_end_ms integer,
      source_in_ms integer, source_out_ms integer, caption_en text, caption_zh text,
      source_track_id bigint, source_cue_index integer
    )
    where segment.segment_index = 0 and segment.timeline_start_ms = 0
  ) then
    raise exception using errcode = 'P0005', message = 'render timeline must start at zero';
  end if;

  if exists (
    select 1
    from (
      select
        segment.segment_index,
        segment.timeline_start_ms,
        segment.timeline_end_ms,
        pg_catalog.lag(segment.timeline_end_ms) over (order by segment.segment_index) as previous_timeline_end_ms
      from pg_catalog.jsonb_to_recordset(p_segments) as segment(
        segment_index integer, download_id bigint, timeline_start_ms integer, timeline_end_ms integer,
        source_in_ms integer, source_out_ms integer, caption_en text, caption_zh text,
        source_track_id bigint, source_cue_index integer
      )
    ) as ordered_segment
    where ordered_segment.segment_index > 0
      and ordered_segment.timeline_start_ms <> ordered_segment.previous_timeline_end_ms
  ) or (select pg_catalog.max(segment.timeline_end_ms)
        from pg_catalog.jsonb_to_recordset(p_segments) as segment(
          segment_index integer, download_id bigint, timeline_start_ms integer, timeline_end_ms integer,
          source_in_ms integer, source_out_ms integer, caption_en text, caption_zh text,
          source_track_id bigint, source_cue_index integer
        )) <> v_persisted_job.expected_duration_ms then
    raise exception using errcode = 'P0005', message = 'render timeline is not contiguous';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'segment_index', segment.segment_index,
      'download_id', segment.download_id,
      'timeline_start_ms', segment.timeline_start_ms,
      'timeline_end_ms', segment.timeline_end_ms,
      'source_in_ms', segment.source_in_ms,
      'source_out_ms', segment.source_out_ms,
      'caption_en', segment.caption_en,
      'caption_zh', segment.caption_zh,
      'source_track_id', segment.source_track_id,
      'source_cue_index', segment.source_cue_index
    ) order by segment.segment_index
  ) into v_supplied_segments
  from pg_catalog.jsonb_to_recordset(p_segments) as segment(
    segment_index integer, download_id bigint, timeline_start_ms integer, timeline_end_ms integer,
    source_in_ms integer, source_out_ms integer, caption_en text, caption_zh text,
    source_track_id bigint, source_cue_index integer
  );

  if v_persisted_job.status = 'completed' then
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'segment_index', segment.segment_index,
        'download_id', segment.download_id,
        'timeline_start_ms', segment.timeline_start_ms,
        'timeline_end_ms', segment.timeline_end_ms,
        'source_in_ms', segment.source_in_ms,
        'source_out_ms', segment.source_out_ms,
        'caption_en', segment.caption_en,
        'caption_zh', segment.caption_zh,
        'source_track_id', segment.source_track_id,
        'source_cue_index', segment.source_cue_index
      ) order by segment.segment_index
    ) into v_stored_segments
    from public.video_render_segments as segment
    where segment.render_id = p_render_id and segment.workflow_version = 2;

    if v_persisted_job.output_artifact_key = v_output_artifact_key
      and v_persisted_job.output_sha256 = v_output_sha256
      and v_persisted_job.output_size_bytes = v_output_size_bytes
      and v_persisted_job.output_duration_ms = v_output_duration_ms
      and v_persisted_job.output_width = v_output_width
      and v_persisted_job.output_height = v_output_height
      and v_persisted_job.video_codec = v_output_video_codec
      and v_persisted_job.audio_codec is not distinct from v_output_audio_codec
      and v_persisted_job.pixel_format = v_output_pixel_format
      and v_persisted_job.ffmpeg_version = v_output_ffmpeg_version
      and v_persisted_job.manifest_sha256 = v_output_manifest_sha256
      and v_stored_segments = v_supplied_segments then
      return query select 'completed'::text;
      return;
    end if;
    raise exception using errcode = 'P0004', message = 'completed render data conflicts';
  end if;

  if v_persisted_job.status <> 'rendering' then
    raise exception using errcode = 'P0003', message = 'render is not ready to complete';
  end if;

  insert into public.video_render_segments(
    render_id, segment_index, download_id, timeline_start_ms, timeline_end_ms,
    source_in_ms, source_out_ms, caption_kind, caption_en, caption_zh,
    source_track_id, source_cue_index, workflow_version
  )
  select
    p_render_id, segment.segment_index, segment.download_id,
    segment.timeline_start_ms, segment.timeline_end_ms,
    segment.source_in_ms, segment.source_out_ms, 'quote', segment.caption_en, segment.caption_zh,
    segment.source_track_id, segment.source_cue_index, 2
  from pg_catalog.jsonb_to_recordset(p_segments) as segment(
    segment_index integer, download_id bigint, timeline_start_ms integer, timeline_end_ms integer,
    source_in_ms integer, source_out_ms integer, caption_en text, caption_zh text,
    source_track_id bigint, source_cue_index integer
  );

  update public.video_render_jobs as job
  set status = 'completed',
      output_artifact_key = v_output_artifact_key,
      output_sha256 = v_output_sha256,
      output_size_bytes = v_output_size_bytes,
      output_duration_ms = v_output_duration_ms,
      output_width = v_output_width,
      output_height = v_output_height,
      video_codec = v_output_video_codec,
      audio_codec = null,
      pixel_format = v_output_pixel_format,
      ffmpeg_version = v_output_ffmpeg_version,
      manifest_sha256 = v_output_manifest_sha256,
      completed_at = pg_catalog.clock_timestamp()
  where job.id = p_render_id;

  return query select 'completed'::text;
end;
$$;

create unique index if not exists video_asset_downloads_reservation_id_key
  on public.video_asset_downloads (reservation_id)
  where reservation_id is not null;

alter table public.video_render_segments
  drop constraint if exists video_render_segments_segment_index_check;
alter table public.video_render_segments
  add constraint video_render_segments_segment_index_check check (
    (workflow_version is null and segment_index between 0 and 3)
    or (workflow_version = 2 and segment_index between 0 and 9)
  );

alter table public.video_render_jobs
  drop constraint if exists video_render_jobs_completed_fields_check;
alter table public.video_render_jobs
  add constraint video_render_jobs_completed_fields_check check (
    (status = 'completed'
      and output_artifact_key is not null
      and output_sha256 is not null
      and output_size_bytes is not null
      and output_duration_ms is not null
      and video_codec is not null and pg_catalog.btrim(video_codec) <> ''
      and pixel_format is not null and pg_catalog.btrim(pixel_format) <> ''
      and ffmpeg_version is not null and pg_catalog.btrim(ffmpeg_version) <> ''
      and manifest_sha256 is not null
      and completed_at is not null
      and failure_code is null
      and failure_message is null
      and (
        (workflow_version is null
          and audio_codec is not null and pg_catalog.btrim(audio_codec) <> ''
          and output_width is null and output_height is null)
        or
        (workflow_version = 2
          and audio_codec is null
          and artifact_task_id is not null
          and output_width = target_width
          and output_height = target_height)
      ))
    or
    (status <> 'completed'
      and output_artifact_key is null
      and output_sha256 is null
      and output_size_bytes is null
      and output_duration_ms is null
      and output_width is null
      and output_height is null
      and video_codec is null
      and audio_codec is null
      and pixel_format is null
      and ffmpeg_version is null
      and manifest_sha256 is null
      and completed_at is null)
  );

create or replace function public.start_video_render_v2(
  p_request_digest text,
  p_theme text,
  p_aspect_ratio text,
  p_width integer,
  p_height integer,
  p_scene_count integer,
  p_source_track_id bigint,
  p_source_start_cue_index integer,
  p_source_end_cue_index integer,
  p_expected_duration_ms integer
)
returns table (render_id uuid, status text, is_existing boolean)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict error
declare
  v_persisted_job public.video_render_jobs%rowtype;
  v_cue_count bigint;
  v_min_cue_index integer;
  v_max_cue_index integer;
  v_duration_ms bigint;
  v_all_cues_long_enough boolean;
begin
  if p_request_digest is null or p_request_digest !~ '^[0-9a-f]{64}$'
    or p_theme is null or pg_catalog.char_length(p_theme) not between 1 and 300
    or p_aspect_ratio is null
    or p_width is null
    or p_height is null
    or p_scene_count is null
    or p_scene_count not between 5 and 10
    or p_source_track_id is null or p_source_track_id <= 0
    or p_source_start_cue_index is null or p_source_start_cue_index < 0
    or p_source_end_cue_index is null
    or p_source_end_cue_index <> p_source_start_cue_index + p_scene_count - 1
    or p_expected_duration_ms is null
    or p_expected_duration_ms not between 15000 and 60000
    or not (
      (p_aspect_ratio = '16:9' and p_width = 1920 and p_height = 1080)
      or (p_aspect_ratio = '9:16' and p_width = 1080 and p_height = 1920)
    ) then
    raise exception using errcode = 'P0005', message = 'render request is incomplete';
  end if;

  select
    pg_catalog.count(*),
    pg_catalog.min(cue.cue_index),
    pg_catalog.max(cue.cue_index),
    pg_catalog.sum(cue.end_ms - cue.start_ms),
    pg_catalog.bool_and(cue.end_ms - cue.start_ms >= 1200)
  into v_cue_count, v_min_cue_index, v_max_cue_index, v_duration_ms, v_all_cues_long_enough
  from public.subtitle_cues as cue
  join public.subtitle_tracks as track on track.id = cue.track_id and track.status = 'ready'
  where cue.track_id = p_source_track_id
    and cue.cue_index between p_source_start_cue_index and p_source_end_cue_index;

  if v_cue_count <> p_scene_count
    or v_min_cue_index <> p_source_start_cue_index
    or v_max_cue_index <> p_source_end_cue_index
    or v_duration_ms <> p_expected_duration_ms
    or v_all_cues_long_enough is distinct from true then
    raise exception using errcode = 'P0005', message = 'source passage is incomplete';
  end if;

  insert into public.video_render_jobs(
    request_digest, theme, status, target_width, target_height, target_fps,
    target_duration_ms, workflow_version, aspect_ratio, scene_count,
    source_track_id, source_start_cue_index, source_end_cue_index, expected_duration_ms
  ) values (
    p_request_digest, p_theme, 'planned', p_width, p_height, 30,
    p_expected_duration_ms, 2, p_aspect_ratio, p_scene_count,
    p_source_track_id, p_source_start_cue_index, p_source_end_cue_index, p_expected_duration_ms
  )
  on conflict (request_digest) do nothing
  returning * into v_persisted_job;

  if found then
    return query select v_persisted_job.id, v_persisted_job.status, false;
    return;
  end if;

  select job.* into v_persisted_job
  from public.video_render_jobs as job
  where job.request_digest = p_request_digest;

  if not found
    or v_persisted_job.workflow_version is distinct from 2
    or v_persisted_job.theme <> p_theme
    or v_persisted_job.aspect_ratio <> p_aspect_ratio
    or v_persisted_job.target_width <> p_width
    or v_persisted_job.target_height <> p_height
    or v_persisted_job.scene_count <> p_scene_count
    or v_persisted_job.source_track_id <> p_source_track_id
    or v_persisted_job.source_start_cue_index <> p_source_start_cue_index
    or v_persisted_job.source_end_cue_index <> p_source_end_cue_index
    or v_persisted_job.expected_duration_ms <> p_expected_duration_ms then
    raise exception using errcode = 'P0004', message = 'render idempotency conflict';
  end if;

  return query select v_persisted_job.id, v_persisted_job.status, true;
end;
$$;

create or replace function public.record_video_asset_download_v2(
  p_render_id uuid,
  p_selection_id bigint,
  p_reservation_id uuid,
  p_artifact_key text,
  p_file_type text,
  p_source_size_bytes bigint,
  p_source_sha256 text,
  p_width integer,
  p_height integer,
  p_duration_ms integer,
  p_frame_rate double precision,
  p_video_codec text,
  p_audio_codec text,
  p_requires_attribution boolean,
  p_required_attribution_url text,
  p_quota_limit integer,
  p_quota_remaining integer
)
returns table (render_id uuid, download_id bigint)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict error
declare
  v_persisted_job public.video_render_jobs%rowtype;
  v_selected_candidate public.video_search_candidates%rowtype;
  v_existing_download public.video_asset_downloads%rowtype;
  v_artifact_task_id uuid;
  v_download_id bigint;
begin
  select job.* into v_persisted_job
  from public.video_render_jobs as job
  where job.id = p_render_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'render not found';
  end if;
  if v_persisted_job.workflow_version is distinct from 2 then
    raise exception using errcode = 'P0003', message = 'render is not version two';
  end if;

  if p_reservation_id is null
    or p_artifact_key is null
    or p_artifact_key !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    or p_artifact_key ~ '^[A-Za-z][A-Za-z0-9+.-]*:'
    or p_artifact_key ~ '(^|/)\.\.(/|$)'
    or p_artifact_key ~ '(^|/)\.(/|$)'
    or p_artifact_key ~ '//'
    or pg_catalog.split_part(p_artifact_key, '/', 1) <> 'video-runs'
    or pg_catalog.split_part(p_artifact_key, '/', 2) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or pg_catalog.split_part(p_artifact_key, '/', 3) = '' then
    raise exception using errcode = 'P0005', message = 'download metadata is incomplete';
  end if;
  v_artifact_task_id := pg_catalog.split_part(p_artifact_key, '/', 2)::uuid;
  if v_persisted_job.artifact_task_id is not null
    and v_persisted_job.artifact_task_id is distinct from v_artifact_task_id then
    raise exception using errcode = 'P0004', message = 'artifact task namespace conflict';
  end if;

  select download.* into v_existing_download
  from public.video_asset_downloads as download
  where download.reservation_id = p_reservation_id;

  if found then
    if v_existing_download.workflow_version = 2
      and v_existing_download.render_id = p_render_id
      and v_existing_download.selection_id = p_selection_id
      and v_existing_download.artifact_key = p_artifact_key
      and v_existing_download.file_type = p_file_type
      and v_existing_download.source_size_bytes = p_source_size_bytes
      and v_existing_download.source_sha256 = p_source_sha256
      and v_existing_download.width = p_width
      and v_existing_download.height = p_height
      and v_existing_download.duration_ms = p_duration_ms
      and v_existing_download.frame_rate = p_frame_rate
      and v_existing_download.video_codec = p_video_codec
      and v_existing_download.audio_codec is not distinct from p_audio_codec
      and v_existing_download.requires_attribution = p_requires_attribution
      and v_existing_download.required_attribution_url is not distinct from p_required_attribution_url
      and v_existing_download.quota_limit is not distinct from p_quota_limit
      and v_existing_download.quota_remaining is not distinct from p_quota_remaining then
      return query select v_existing_download.render_id, v_existing_download.id;
      return;
    end if;
    raise exception using errcode = 'P0004', message = 'reservation metadata conflict';
  end if;

  select candidate.* into v_selected_candidate
  from public.video_asset_selections as selection
  join public.video_search_candidates as candidate on candidate.id = selection.candidate_id
  where selection.id = p_selection_id
  for update of selection;

  if not found then
    raise exception using errcode = 'P0002', message = 'selection not found';
  end if;
  if v_persisted_job.status not in ('planned', 'downloading') then
    raise exception using errcode = 'P0003', message = 'render is not accepting downloads';
  end if;
  if (select pg_catalog.count(*) from public.video_asset_downloads as download where download.render_id = p_render_id) >= v_persisted_job.scene_count then
    raise exception using errcode = 'P0005', message = 'render download limit reached';
  end if;

  insert into public.video_asset_downloads(
    render_id, selection_id, candidate_id, provider, provider_resource_id,
    artifact_key, file_type, source_size_bytes, source_sha256, width, height,
    duration_ms, frame_rate, video_codec, audio_codec, requires_attribution,
    required_attribution_url, quota_limit, quota_remaining, workflow_version, reservation_id
  ) values (
    p_render_id, p_selection_id, v_selected_candidate.id, v_selected_candidate.provider, v_selected_candidate.provider_resource_id,
    p_artifact_key, p_file_type, p_source_size_bytes, p_source_sha256, p_width, p_height,
    p_duration_ms, p_frame_rate, p_video_codec, p_audio_codec, p_requires_attribution,
    p_required_attribution_url, p_quota_limit, p_quota_remaining, 2, p_reservation_id
  ) returning id into v_download_id;

  update public.video_render_jobs as job
  set status = case when job.status = 'planned' then 'downloading' else job.status end,
      artifact_task_id = pg_catalog.coalesce(job.artifact_task_id, v_artifact_task_id)
  where job.id = p_render_id;

  return query select p_render_id, v_download_id;
end;
$$;

revoke all on function public.start_video_render_v2(text, text, text, integer, integer, integer, bigint, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.start_video_render_v2(text, text, text, integer, integer, integer, bigint, integer, integer, integer) to service_role, postgres;
revoke all on function public.record_video_asset_download_v2(uuid, bigint, uuid, text, text, bigint, text, integer, integer, integer, double precision, text, text, boolean, text, integer, integer) from public, anon, authenticated;
grant execute on function public.record_video_asset_download_v2(uuid, bigint, uuid, text, text, bigint, text, integer, integer, integer, double precision, text, text, boolean, text, integer, integer) to service_role, postgres;
revoke all on function public.begin_video_render_v2(uuid) from public, anon, authenticated;
grant execute on function public.begin_video_render_v2(uuid) to service_role, postgres;
revoke all on function public.complete_video_render_v2(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.complete_video_render_v2(uuid, jsonb, jsonb) to service_role, postgres;
revoke all on function public.fail_video_render_v2(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fail_video_render_v2(uuid, text, text) to service_role, postgres;
revoke all on function public.retry_video_render_v2(uuid) from public, anon, authenticated;
grant execute on function public.retry_video_render_v2(uuid) to service_role, postgres;
