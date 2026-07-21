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
      artifact_task_id = coalesce(job.artifact_task_id, v_artifact_task_id)
  where job.id = p_render_id;

  return query select p_render_id, v_download_id;
end;
$$;

revoke all on function public.record_video_asset_download_v2(uuid, bigint, uuid, text, text, bigint, text, integer, integer, integer, double precision, text, text, boolean, text, integer, integer) from public, anon, authenticated;
grant execute on function public.record_video_asset_download_v2(uuid, bigint, uuid, text, text, bigint, text, integer, integer, integer, double precision, text, text, boolean, text, integer, integer) to service_role, postgres;
