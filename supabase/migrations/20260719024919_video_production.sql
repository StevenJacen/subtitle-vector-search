alter table public.video_asset_selections
  add constraint video_asset_selections_id_candidate_id_key unique (id, candidate_id);

create table public.video_render_jobs (
  id uuid primary key default gen_random_uuid(),
  request_digest text not null unique constraint video_render_jobs_request_digest_check check (request_digest ~ '^[0-9a-f]{64}$'),
  theme text not null constraint video_render_jobs_theme_length_check check (pg_catalog.char_length(theme) between 1 and 300),
  status text not null check (status in ('planned', 'downloading', 'rendering', 'completed', 'failed')),
  target_width integer not null default 1920 constraint video_render_jobs_target_width_check check (target_width > 0),
  target_height integer not null default 1080 constraint video_render_jobs_target_height_check check (target_height > 0),
  target_fps integer not null default 30 constraint video_render_jobs_target_fps_check check (target_fps > 0),
  target_duration_ms integer not null default 30000 constraint video_render_jobs_target_duration_ms_check check (target_duration_ms > 0),
  output_artifact_key text,
  output_sha256 text constraint video_render_jobs_output_sha256_check check (output_sha256 is null or output_sha256 ~ '^[0-9a-f]{64}$'),
  output_size_bytes bigint constraint video_render_jobs_output_size_bytes_check check (output_size_bytes is null or output_size_bytes > 0),
  output_duration_ms integer constraint video_render_jobs_output_duration_ms_check check (output_duration_ms is null or output_duration_ms > 0),
  video_codec text,
  audio_codec text,
  pixel_format text,
  ffmpeg_version text,
  manifest_sha256 text constraint video_render_jobs_manifest_sha256_check check (manifest_sha256 is null or manifest_sha256 ~ '^[0-9a-f]{64}$'),
  failure_code text constraint video_render_jobs_failure_code_check check (failure_code is null or failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  failure_message text constraint video_render_jobs_failure_message_check check (failure_message is null or pg_catalog.char_length(failure_message) between 1 and 500),
  created_at timestamptz not null default pg_catalog.now(),
  completed_at timestamptz,
  constraint video_render_jobs_output_artifact_key_check check (
    output_artifact_key is null or (
      output_artifact_key ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
      and output_artifact_key !~ '^[A-Za-z][A-Za-z0-9+.-]*:'
      and output_artifact_key !~ '(^|/)\\.\\.(/|$)'
    )
  ),
  constraint video_render_jobs_completed_fields_check check (
    (status = 'completed'
      and output_artifact_key is not null
      and output_sha256 is not null
      and output_size_bytes is not null
      and output_duration_ms is not null
      and video_codec is not null and pg_catalog.btrim(video_codec) <> ''
      and audio_codec is not null and pg_catalog.btrim(audio_codec) <> ''
      and pixel_format is not null and pg_catalog.btrim(pixel_format) <> ''
      and ffmpeg_version is not null and pg_catalog.btrim(ffmpeg_version) <> ''
      and manifest_sha256 is not null
      and completed_at is not null
      and failure_code is null
      and failure_message is null)
    or
    (status <> 'completed'
      and output_artifact_key is null
      and output_sha256 is null
      and output_size_bytes is null
      and output_duration_ms is null
      and video_codec is null
      and audio_codec is null
      and pixel_format is null
      and ffmpeg_version is null
      and manifest_sha256 is null
      and completed_at is null)
  ),
  constraint video_render_jobs_failed_fields_check check (
    (status = 'failed' and failure_code is not null and failure_message is not null)
    or (status <> 'failed' and failure_code is null and failure_message is null)
  )
);

create table public.video_asset_downloads (
  id bigint generated always as identity primary key,
  render_id uuid not null references public.video_render_jobs(id) on delete cascade,
  selection_id bigint not null unique,
  candidate_id bigint not null,
  provider text not null default 'vecteezy' constraint video_asset_downloads_provider_check check (provider = 'vecteezy'),
  provider_resource_id bigint not null constraint video_asset_downloads_provider_resource_id_check check (provider_resource_id > 0),
  artifact_key text not null,
  file_type text not null default 'mp4' constraint video_asset_downloads_file_type_check check (file_type = 'mp4'),
  source_size_bytes bigint not null constraint video_asset_downloads_source_size_bytes_check check (source_size_bytes > 0),
  source_sha256 text not null constraint video_asset_downloads_source_sha256_check check (source_sha256 ~ '^[0-9a-f]{64}$'),
  width integer not null constraint video_asset_downloads_width_check check (width > 0),
  height integer not null constraint video_asset_downloads_height_check check (height > 0),
  duration_ms integer not null constraint video_asset_downloads_duration_ms_check check (duration_ms > 0),
  frame_rate double precision not null constraint video_asset_downloads_frame_rate_check check (frame_rate > 0 and frame_rate < 'Infinity'::double precision),
  video_codec text not null constraint video_asset_downloads_video_codec_check check (pg_catalog.btrim(video_codec) <> ''),
  audio_codec text,
  requires_attribution boolean not null,
  required_attribution_url text,
  quota_limit integer,
  quota_remaining integer,
  downloaded_at timestamptz not null default pg_catalog.now(),
  constraint video_asset_downloads_render_id_provider_resource_id_key unique (render_id, provider_resource_id),
  constraint video_asset_downloads_render_id_id_key unique (render_id, id),
  constraint video_asset_downloads_selection_candidate_fkey
    foreign key (selection_id, candidate_id)
    references public.video_asset_selections(id, candidate_id)
    on update restrict,
  constraint video_asset_downloads_artifact_key_check check (
    artifact_key ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    and artifact_key !~ '^[A-Za-z][A-Za-z0-9+.-]*:'
    and artifact_key !~ '(^|/)\\.\\.(/|$)'
  ),
  constraint video_asset_downloads_audio_codec_check check (audio_codec is null or pg_catalog.btrim(audio_codec) <> ''),
  constraint video_asset_downloads_attribution_check check (
    (requires_attribution and required_attribution_url ~ '^https://[^[:space:]]+$')
    or (not requires_attribution and required_attribution_url is null)
  ),
  constraint video_asset_downloads_quota_check check (
    (quota_limit is null and quota_remaining is null)
    or (quota_limit is not null and quota_remaining is not null and quota_limit >= 0 and quota_remaining >= 0 and quota_remaining <= quota_limit)
  )
);

create table public.video_render_segments (
  id bigint generated always as identity primary key,
  render_id uuid not null references public.video_render_jobs(id) on delete cascade,
  segment_index integer not null constraint video_render_segments_segment_index_check check (segment_index between 0 and 3),
  download_id bigint not null,
  timeline_start_ms integer not null constraint video_render_segments_timeline_start_ms_check check (timeline_start_ms >= 0),
  timeline_end_ms integer not null constraint video_render_segments_timeline_end_ms_check check (timeline_end_ms > timeline_start_ms),
  source_in_ms integer not null constraint video_render_segments_source_in_ms_check check (source_in_ms >= 0),
  source_out_ms integer not null constraint video_render_segments_source_out_ms_check check (source_out_ms > source_in_ms),
  caption_kind text not null constraint video_render_segments_caption_kind_check check (caption_kind in ('original','quote')),
  caption_en text not null constraint video_render_segments_caption_en_check check (pg_catalog.btrim(caption_en) <> ''),
  caption_zh text not null constraint video_render_segments_caption_zh_check check (pg_catalog.btrim(caption_zh) <> ''),
  source_track_id bigint,
  source_cue_index integer,
  created_at timestamptz not null default pg_catalog.now(),
  constraint video_render_segments_render_id_segment_index_key unique (render_id, segment_index),
  constraint video_render_segments_render_download_fkey
    foreign key (render_id, download_id)
    references public.video_asset_downloads(render_id, id),
  constraint video_render_segments_source_cue_fkey
    foreign key (source_track_id, source_cue_index)
    references public.subtitle_cues(track_id, cue_index),
  constraint video_render_segments_source_pair_check check (
    (caption_kind = 'original' and source_track_id is null and source_cue_index is null)
    or (caption_kind = 'quote' and source_track_id is not null and source_cue_index is not null)
  )
);

create index video_asset_downloads_render_id_idx on public.video_asset_downloads (render_id);
create index video_asset_downloads_candidate_id_idx on public.video_asset_downloads (candidate_id);
create index video_render_segments_render_id_idx on public.video_render_segments (render_id);
create index video_render_segments_download_id_idx on public.video_render_segments (download_id);
create index video_render_segments_quote_source_idx
  on public.video_render_segments (source_track_id, source_cue_index)
  where source_track_id is not null;

create function public.start_video_render(
  p_request_digest text,
  p_theme text
)
returns table (render_id uuid, status text, is_existing boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  persisted_job public.video_render_jobs%rowtype;
begin
  insert into public.video_render_jobs(request_digest, theme, status)
  values (p_request_digest, p_theme, 'planned')
  on conflict (request_digest) do nothing
  returning * into persisted_job;

  if found then
    return query select persisted_job.id, persisted_job.status, false;
    return;
  end if;

  select * into persisted_job
  from public.video_render_jobs
  where request_digest = p_request_digest;

  if not found then
    raise exception using errcode = 'P0004', message = 'render idempotency conflict';
  end if;

  return query select persisted_job.id, persisted_job.status, true;
end;
$$;

create function public.record_video_asset_download(
  p_render_id uuid,
  p_selection_id bigint,
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
declare
  persisted_job public.video_render_jobs%rowtype;
  selected_candidate public.video_search_candidates%rowtype;
  existing_download public.video_asset_downloads%rowtype;
  persisted_download_id bigint;
begin
  select * into persisted_job
  from public.video_render_jobs
  where id = p_render_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'render not found';
  end if;

  select candidate.* into selected_candidate
  from public.video_asset_selections as selection
  join public.video_search_candidates as candidate on candidate.id = selection.candidate_id
  where selection.id = p_selection_id
  for update of selection;

  if not found then
    raise exception using errcode = 'P0002', message = 'selection not found';
  end if;

  select * into existing_download
  from public.video_asset_downloads
  where selection_id = p_selection_id;

  if found then
    if existing_download.render_id = p_render_id
      and existing_download.candidate_id = selected_candidate.id
      and existing_download.provider = selected_candidate.provider
      and existing_download.provider_resource_id = selected_candidate.provider_resource_id
      and existing_download.artifact_key = p_artifact_key
      and existing_download.file_type = p_file_type
      and existing_download.source_size_bytes = p_source_size_bytes
      and existing_download.source_sha256 = p_source_sha256
      and existing_download.width = p_width
      and existing_download.height = p_height
      and existing_download.duration_ms = p_duration_ms
      and existing_download.frame_rate = p_frame_rate
      and existing_download.video_codec = p_video_codec
      and existing_download.audio_codec is not distinct from p_audio_codec
      and existing_download.requires_attribution = p_requires_attribution
      and existing_download.required_attribution_url is not distinct from p_required_attribution_url
      and existing_download.quota_limit is not distinct from p_quota_limit
      and existing_download.quota_remaining is not distinct from p_quota_remaining then
      return query select existing_download.render_id, existing_download.id;
      return;
    end if;

    raise exception using errcode = 'P0004', message = 'download metadata conflicts with existing selection';
  end if;

  if persisted_job.status not in ('planned', 'downloading') then
    raise exception using errcode = 'P0003', message = 'render is not accepting downloads';
  end if;

  insert into public.video_asset_downloads(
    render_id, selection_id, candidate_id, provider, provider_resource_id,
    artifact_key, file_type, source_size_bytes, source_sha256, width, height,
    duration_ms, frame_rate, video_codec, audio_codec, requires_attribution,
    required_attribution_url, quota_limit, quota_remaining
  )
  values (
    p_render_id, p_selection_id, selected_candidate.id, selected_candidate.provider, selected_candidate.provider_resource_id,
    p_artifact_key, p_file_type, p_source_size_bytes, p_source_sha256, p_width, p_height,
    p_duration_ms, p_frame_rate, p_video_codec, p_audio_codec, p_requires_attribution,
    p_required_attribution_url, p_quota_limit, p_quota_remaining
  )
  on conflict (selection_id) do nothing
  returning id into persisted_download_id;

  if persisted_download_id is null then
    select * into existing_download
    from public.video_asset_downloads
    where selection_id = p_selection_id;

    if existing_download.render_id = p_render_id
      and existing_download.candidate_id = selected_candidate.id
      and existing_download.provider = selected_candidate.provider
      and existing_download.provider_resource_id = selected_candidate.provider_resource_id
      and existing_download.artifact_key = p_artifact_key
      and existing_download.file_type = p_file_type
      and existing_download.source_size_bytes = p_source_size_bytes
      and existing_download.source_sha256 = p_source_sha256
      and existing_download.width = p_width
      and existing_download.height = p_height
      and existing_download.duration_ms = p_duration_ms
      and existing_download.frame_rate = p_frame_rate
      and existing_download.video_codec = p_video_codec
      and existing_download.audio_codec is not distinct from p_audio_codec
      and existing_download.requires_attribution = p_requires_attribution
      and existing_download.required_attribution_url is not distinct from p_required_attribution_url
      and existing_download.quota_limit is not distinct from p_quota_limit
      and existing_download.quota_remaining is not distinct from p_quota_remaining then
      return query select existing_download.render_id, existing_download.id;
      return;
    end if;

    raise exception using errcode = 'P0004', message = 'download metadata conflicts with existing selection';
  end if;

  update public.video_render_jobs
  set status = 'downloading'
  where id = p_render_id and status = 'planned';

  return query select p_render_id, persisted_download_id;
end;
$$;

create function public.begin_video_render(p_render_id uuid)
returns table (status text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  persisted_status text;
begin
  select status into persisted_status
  from public.video_render_jobs
  where id = p_render_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'render not found';
  end if;

  if persisted_status <> 'downloading' then
    raise exception using errcode = 'P0003', message = 'render is not ready to begin';
  end if;

  if (select count(*) from public.video_asset_downloads where render_id = p_render_id) <> 4 then
    raise exception using errcode = 'P0005', message = 'render requires four verified downloads';
  end if;

  update public.video_render_jobs
  set status = 'rendering'
  where id = p_render_id;

  return query select 'rendering'::text;
end;
$$;

create function public.complete_video_render(
  p_render_id uuid,
  p_segments jsonb,
  p_output jsonb
)
returns table (status text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  persisted_job public.video_render_jobs%rowtype;
  output_artifact_key text;
  output_sha256 text;
  output_size_bytes bigint;
  output_duration_ms integer;
  output_video_codec text;
  output_audio_codec text;
  output_pixel_format text;
  output_ffmpeg_version text;
  output_manifest_sha256 text;
  supplied_segments jsonb;
  stored_segments jsonb;
begin
  select * into persisted_job
  from public.video_render_jobs
  where id = p_render_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'render not found';
  end if;

  if pg_catalog.jsonb_typeof(p_segments) <> 'array' or pg_catalog.jsonb_array_length(p_segments) <> 4 then
    raise exception using errcode = 'P0005', message = 'render requires four segments';
  end if;

  if pg_catalog.jsonb_typeof(p_output) <> 'object' then
    raise exception using errcode = 'P0005', message = 'render output is incomplete';
  end if;

  select
    output.artifact_key,
    output.output_sha256,
    output.output_size_bytes,
    output.output_duration_ms,
    output.video_codec,
    output.audio_codec,
    output.pixel_format,
    output.ffmpeg_version,
    output.manifest_sha256
  into
    output_artifact_key,
    output_sha256,
    output_size_bytes,
    output_duration_ms,
    output_video_codec,
    output_audio_codec,
    output_pixel_format,
    output_ffmpeg_version,
    output_manifest_sha256
  from pg_catalog.jsonb_to_record(p_output) as output(
    artifact_key text,
    output_sha256 text,
    output_size_bytes bigint,
    output_duration_ms integer,
    video_codec text,
    audio_codec text,
    pixel_format text,
    ffmpeg_version text,
    manifest_sha256 text
  );

  if output_artifact_key is null
    or output_artifact_key !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    or output_artifact_key ~ '^[A-Za-z][A-Za-z0-9+.-]*:'
    or output_artifact_key ~ '(^|/)\\.\\.(/|$)'
    or output_sha256 is null
    or output_sha256 !~ '^[0-9a-f]{64}$'
    or output_size_bytes is null or output_size_bytes <= 0
    or output_duration_ms is null or output_duration_ms <= 0
    or output_video_codec is null or pg_catalog.btrim(output_video_codec) = ''
    or output_audio_codec is null or pg_catalog.btrim(output_audio_codec) = ''
    or output_pixel_format is null or pg_catalog.btrim(output_pixel_format) = ''
    or output_ffmpeg_version is null or pg_catalog.btrim(output_ffmpeg_version) = ''
    or output_manifest_sha256 is null
    or output_manifest_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0005', message = 'render output is incomplete';
  end if;

  if (select count(*) from pg_catalog.jsonb_to_recordset(p_segments) as segment(
      segment_index integer,
      download_id bigint,
      timeline_start_ms integer,
      timeline_end_ms integer,
      source_in_ms integer,
      source_out_ms integer,
      caption_kind text,
      caption_en text,
      caption_zh text,
      source_track_id bigint,
      source_cue_index integer
    )) <> 4
    or (select array_agg(segment.segment_index order by segment.segment_index) from pg_catalog.jsonb_to_recordset(p_segments) as segment(
      segment_index integer,
      download_id bigint,
      timeline_start_ms integer,
      timeline_end_ms integer,
      source_in_ms integer,
      source_out_ms integer,
      caption_kind text,
      caption_en text,
      caption_zh text,
      source_track_id bigint,
      source_cue_index integer
    )) is distinct from array[0, 1, 2, 3]
    or (select count(*) from pg_catalog.jsonb_to_recordset(p_segments) as segment(
      segment_index integer,
      download_id bigint,
      timeline_start_ms integer,
      timeline_end_ms integer,
      source_in_ms integer,
      source_out_ms integer,
      caption_kind text,
      caption_en text,
      caption_zh text,
      source_track_id bigint,
      source_cue_index integer
    ) where segment.caption_kind = 'quote') <> 1 then
    raise exception using errcode = 'P0005', message = 'render segments are incomplete';
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
      caption_kind text,
      caption_en text,
      caption_zh text,
      source_track_id bigint,
      source_cue_index integer
    )
    left join public.video_asset_downloads as download
      on download.id = segment.download_id and download.render_id = p_render_id
    where download.id is null
  ) then
    raise exception using errcode = 'P0005', message = 'render segments do not own their downloads';
  end if;

  if not exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_segments) as segment(
      segment_index integer,
      download_id bigint,
      timeline_start_ms integer,
      timeline_end_ms integer,
      source_in_ms integer,
      source_out_ms integer,
      caption_kind text,
      caption_en text,
      caption_zh text,
      source_track_id bigint,
      source_cue_index integer
    )
    join public.subtitle_cues as cue
      on cue.track_id = segment.source_track_id
      and cue.cue_index = segment.source_cue_index
      and cue.text = segment.caption_en
    where segment.caption_kind = 'quote'
  ) then
    raise exception using errcode = 'P0006', message = 'quote caption does not match source cue';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'segment_index', segment.segment_index,
      'download_id', segment.download_id,
      'timeline_start_ms', segment.timeline_start_ms,
      'timeline_end_ms', segment.timeline_end_ms,
      'source_in_ms', segment.source_in_ms,
      'source_out_ms', segment.source_out_ms,
      'caption_kind', segment.caption_kind,
      'caption_en', segment.caption_en,
      'caption_zh', segment.caption_zh,
      'source_track_id', segment.source_track_id,
      'source_cue_index', segment.source_cue_index
    ) order by segment.segment_index
  ) into supplied_segments
  from pg_catalog.jsonb_to_recordset(p_segments) as segment(
    segment_index integer,
    download_id bigint,
    timeline_start_ms integer,
    timeline_end_ms integer,
    source_in_ms integer,
    source_out_ms integer,
    caption_kind text,
    caption_en text,
    caption_zh text,
    source_track_id bigint,
    source_cue_index integer
  );

  if persisted_job.status = 'completed' then
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'segment_index', segment.segment_index,
        'download_id', segment.download_id,
        'timeline_start_ms', segment.timeline_start_ms,
        'timeline_end_ms', segment.timeline_end_ms,
        'source_in_ms', segment.source_in_ms,
        'source_out_ms', segment.source_out_ms,
        'caption_kind', segment.caption_kind,
        'caption_en', segment.caption_en,
        'caption_zh', segment.caption_zh,
        'source_track_id', segment.source_track_id,
        'source_cue_index', segment.source_cue_index
      ) order by segment.segment_index
    ) into stored_segments
    from public.video_render_segments as segment
    where segment.render_id = p_render_id;

    if persisted_job.output_artifact_key = output_artifact_key
      and persisted_job.output_sha256 = output_sha256
      and persisted_job.output_size_bytes = output_size_bytes
      and persisted_job.output_duration_ms = output_duration_ms
      and persisted_job.video_codec = output_video_codec
      and persisted_job.audio_codec = output_audio_codec
      and persisted_job.pixel_format = output_pixel_format
      and persisted_job.ffmpeg_version = output_ffmpeg_version
      and persisted_job.manifest_sha256 = output_manifest_sha256
      and stored_segments = supplied_segments then
      return query select 'completed'::text;
      return;
    end if;

    raise exception using errcode = 'P0004', message = 'completed render data conflicts';
  end if;

  if persisted_job.status <> 'rendering' then
    raise exception using errcode = 'P0003', message = 'render is not ready to complete';
  end if;

  insert into public.video_render_segments(
    render_id, segment_index, download_id, timeline_start_ms, timeline_end_ms,
    source_in_ms, source_out_ms, caption_kind, caption_en, caption_zh,
    source_track_id, source_cue_index
  )
  select
    p_render_id,
    segment.segment_index,
    segment.download_id,
    segment.timeline_start_ms,
    segment.timeline_end_ms,
    segment.source_in_ms,
    segment.source_out_ms,
    segment.caption_kind,
    segment.caption_en,
    segment.caption_zh,
    segment.source_track_id,
    segment.source_cue_index
  from pg_catalog.jsonb_to_recordset(p_segments) as segment(
    segment_index integer,
    download_id bigint,
    timeline_start_ms integer,
    timeline_end_ms integer,
    source_in_ms integer,
    source_out_ms integer,
    caption_kind text,
    caption_en text,
    caption_zh text,
    source_track_id bigint,
    source_cue_index integer
  );

  update public.video_render_jobs
  set status = 'completed',
      output_artifact_key = output_artifact_key,
      output_sha256 = output_sha256,
      output_size_bytes = output_size_bytes,
      output_duration_ms = output_duration_ms,
      video_codec = output_video_codec,
      audio_codec = output_audio_codec,
      pixel_format = output_pixel_format,
      ffmpeg_version = output_ffmpeg_version,
      manifest_sha256 = output_manifest_sha256,
      completed_at = pg_catalog.clock_timestamp()
  where id = p_render_id;

  return query select 'completed'::text;
end;
$$;

create function public.fail_video_render(
  p_render_id uuid,
  p_failure_code text,
  p_failure_message text
)
returns table (status text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  persisted_status text;
begin
  select status into persisted_status
  from public.video_render_jobs
  where id = p_render_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'render not found';
  end if;

  if persisted_status not in ('planned', 'downloading', 'rendering') then
    raise exception using errcode = 'P0003', message = 'render cannot fail from its current state';
  end if;

  if p_failure_code is null
    or p_failure_code !~ '^[a-z][a-z0-9_]{0,63}$'
    or p_failure_message is null
    or pg_catalog.char_length(p_failure_message) not between 1 and 500 then
    raise exception using errcode = 'P0005', message = 'failure data is incomplete';
  end if;

  update public.video_render_jobs
  set status = 'failed',
      failure_code = p_failure_code,
      failure_message = p_failure_message
  where id = p_render_id;

  return query select 'failed'::text;
end;
$$;

create function public.retry_video_render(p_render_id uuid)
returns table (status text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  persisted_status text;
begin
  select status into persisted_status
  from public.video_render_jobs
  where id = p_render_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'render not found';
  end if;

  if persisted_status <> 'failed' then
    raise exception using errcode = 'P0003', message = 'only failed renders can retry';
  end if;

  update public.video_render_jobs
  set status = 'planned',
      failure_code = null,
      failure_message = null
  where id = p_render_id;

  return query select 'planned'::text;
end;
$$;

create or replace function public.select_video_asset(
  p_run_id uuid,
  p_provider_resource_id bigint,
  p_note text
)
returns table (selection_id bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  owned_candidate_id bigint;
  persisted_selection public.video_asset_selections%rowtype;
begin
  select candidate.id
  into owned_candidate_id
  from public.video_search_candidates as candidate
  where candidate.run_id = p_run_id
    and candidate.provider = 'vecteezy'
    and candidate.provider_resource_id = p_provider_resource_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'candidate does not belong to run';
  end if;

  select * into persisted_selection
  from public.video_asset_selections
  where run_id = p_run_id
  for update;

  if found and exists (
    select 1 from public.video_asset_downloads where selection_id = persisted_selection.id
  ) then
    if persisted_selection.candidate_id <> owned_candidate_id
      or persisted_selection.note is distinct from p_note then
      raise exception using errcode = 'P0007', message = 'selection_locked';
    end if;

    return query select persisted_selection.id;
    return;
  end if;

  insert into public.video_asset_selections(run_id, candidate_id, note)
  values (p_run_id, owned_candidate_id, p_note)
  on conflict (run_id) do update
  set candidate_id = excluded.candidate_id,
      note = excluded.note,
      selected_at = pg_catalog.clock_timestamp()
  returning * into persisted_selection;

  return query select persisted_selection.id;
end;
$$;

alter table public.video_render_jobs enable row level security;
alter table public.video_render_jobs force row level security;
revoke all on table public.video_render_jobs from public, anon, authenticated;
grant select, insert, update, delete on table public.video_render_jobs to service_role;

alter table public.video_asset_downloads enable row level security;
alter table public.video_asset_downloads force row level security;
revoke all on table public.video_asset_downloads from public, anon, authenticated;
grant select, insert, update, delete on table public.video_asset_downloads to service_role;

alter table public.video_render_segments enable row level security;
alter table public.video_render_segments force row level security;
revoke all on table public.video_render_segments from public, anon, authenticated;
grant select, insert, update, delete on table public.video_render_segments to service_role;

revoke all on sequence public.video_asset_downloads_id_seq from public, anon, authenticated;
grant usage on sequence public.video_asset_downloads_id_seq to service_role;
revoke all on sequence public.video_render_segments_id_seq from public, anon, authenticated;
grant usage on sequence public.video_render_segments_id_seq to service_role;

revoke all on function public.start_video_render(text, text) from public, anon, authenticated;
grant execute on function public.start_video_render(text, text) to service_role, postgres;
revoke all on function public.record_video_asset_download(uuid, bigint, text, text, bigint, text, integer, integer, integer, double precision, text, text, boolean, text, integer, integer) from public, anon, authenticated;
grant execute on function public.record_video_asset_download(uuid, bigint, text, text, bigint, text, integer, integer, integer, double precision, text, text, boolean, text, integer, integer) to service_role, postgres;
revoke all on function public.begin_video_render(uuid) from public, anon, authenticated;
grant execute on function public.begin_video_render(uuid) to service_role, postgres;
revoke all on function public.complete_video_render(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.complete_video_render(uuid, jsonb, jsonb) to service_role, postgres;
revoke all on function public.fail_video_render(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fail_video_render(uuid, text, text) to service_role, postgres;
revoke all on function public.retry_video_render(uuid) from public, anon, authenticated;
grant execute on function public.retry_video_render(uuid) to service_role, postgres;
revoke all on function public.select_video_asset(uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.select_video_asset(uuid, bigint, text) to service_role, postgres;
