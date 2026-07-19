create or replace function public.retry_video_render(p_render_id uuid)
returns table (status text)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict error
declare
  v_persisted_status text;
  v_retry_status text;
begin
  select job.status into v_persisted_status
  from public.video_render_jobs as job
  where job.id = p_render_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'render not found';
  end if;

  v_retry_status := case
    when exists (
      select 1
      from public.video_asset_downloads as download
      where download.render_id = p_render_id
    ) then 'downloading'
    else 'planned'
  end;

  if v_persisted_status in ('planned', 'downloading')
     and v_persisted_status = v_retry_status then
    return query select v_persisted_status;
    return;
  end if;

  if v_persisted_status <> 'failed' then
    raise exception using errcode = 'P0003', message = 'only failed renders can retry';
  end if;

  update public.video_render_jobs as job
  set status = v_retry_status,
      failure_code = null,
      failure_message = null
  where job.id = p_render_id;

  return query select v_retry_status;
end;
$$;

revoke all on function public.retry_video_render(uuid) from public, anon, authenticated;
grant execute on function public.retry_video_render(uuid) to service_role, postgres;
