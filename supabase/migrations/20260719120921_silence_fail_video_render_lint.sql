create or replace function public.fail_video_render(
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
  v_persisted_status text;
  v_failure_message text;
begin
  -- Consume the compatibility argument without persisting caller-controlled text.
  perform pg_catalog.length(p_failure_message);

  select job.status into v_persisted_status
  from public.video_render_jobs as job
  where job.id = p_render_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'render not found';
  end if;

  if v_persisted_status not in ('planned', 'downloading', 'rendering') then
    raise exception using errcode = 'P0003', message = 'render cannot fail from its current state';
  end if;

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
  set status = 'failed',
      failure_code = p_failure_code,
      failure_message = v_failure_message
  where job.id = p_render_id;

  return query select 'failed'::text;
end;
$$;
