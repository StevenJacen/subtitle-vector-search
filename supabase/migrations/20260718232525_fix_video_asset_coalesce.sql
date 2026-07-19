-- COALESCE is SQL syntax and cannot be schema-qualified.
create or replace function public.finish_video_search_run(
  p_run_id uuid,
  p_status text,
  p_fallback_used boolean,
  p_visual_intent jsonb,
  p_planner_elapsed_ms integer,
  p_total_elapsed_ms integer,
  p_failure_code text,
  p_queries jsonb,
  p_candidates jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  candidate jsonb;
begin
  if p_status is null or p_status not in ('completed', 'degraded', 'failed') then
    raise exception using errcode = '22023', message = 'invalid terminal status';
  end if;

  if p_queries is null
    or pg_catalog.jsonb_typeof(p_queries) <> 'array'
    or pg_catalog.jsonb_array_length(p_queries) <> 3
    or (
      select pg_catalog.count(distinct query.item->>'kind')
      from pg_catalog.jsonb_array_elements(p_queries) as query(item)
    ) <> 3
    or not p_queries @> '[{"kind":"literal"},{"kind":"action"},{"kind":"metaphor"}]'::jsonb
  then
    raise exception using errcode = '22023', message = 'exactly three query kinds are required';
  end if;

  if p_candidates is null
    or pg_catalog.jsonb_typeof(p_candidates) <> 'array'
    or pg_catalog.jsonb_array_length(p_candidates) > 10
  then
    raise exception using errcode = '22023', message = 'candidates must contain zero to ten records';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_candidates) as owned(item)
    where owned.item ? 'run_id'
      and owned.item->>'run_id' <> p_run_id::text
  ) then
    raise exception using errcode = '22023', message = 'candidate run ownership mismatch';
  end if;

  perform 1
  from public.video_search_runs as run
  where run.id = p_run_id
    and run.status = 'planning'
  for update;

  if not found then
    raise exception using errcode = '55000', message = 'run is not planning';
  end if;

  insert into public.video_search_queries(
    run_id,
    kind,
    term,
    weight,
    filters,
    provider_total,
    status,
    elapsed_ms
  )
  select
    p_run_id,
    query.kind,
    query.term,
    query.weight,
    query.filters,
    query.provider_total,
    query.status,
    query.elapsed_ms
  from pg_catalog.jsonb_to_recordset(p_queries) as query(
    kind text,
    term text,
    weight double precision,
    filters jsonb,
    provider_total integer,
    status text,
    elapsed_ms integer
  );

  for candidate in
    select item from pg_catalog.jsonb_array_elements(p_candidates) as candidates(item)
  loop
    insert into public.video_search_candidates(
      run_id,
      provider,
      provider_resource_id,
      title,
      content_type,
      license_type,
      ai_generated,
      orientation,
      tags,
      file_types,
      download_sizes,
      fused_score,
      best_rank,
      matched_query_kinds
    )
    values (
      p_run_id,
      coalesce(candidate->>'provider', 'vecteezy'),
      (candidate->>'provider_resource_id')::bigint,
      candidate->>'title',
      candidate->>'content_type',
      candidate->>'license_type',
      (candidate->>'ai_generated')::boolean,
      candidate->>'orientation',
      array(select pg_catalog.jsonb_array_elements_text(coalesce(candidate->'tags', '[]'::jsonb))),
      coalesce(candidate->'file_types', '[]'::jsonb),
      coalesce(candidate->'download_sizes', '[]'::jsonb),
      (candidate->>'fused_score')::double precision,
      (candidate->>'best_rank')::integer,
      array(select pg_catalog.jsonb_array_elements_text(candidate->'matched_query_kinds'))
    );
  end loop;

  update public.video_search_runs as run
  set status = p_status,
      fallback_used = p_fallback_used,
      visual_intent = p_visual_intent,
      planner_elapsed_ms = p_planner_elapsed_ms,
      total_elapsed_ms = p_total_elapsed_ms,
      failure_code = p_failure_code,
      completed_at = pg_catalog.clock_timestamp()
  where run.id = p_run_id;
end;
$$;

create or replace function public.upsert_visual_concepts(
  p_concepts jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected_count integer;
begin
  if p_concepts is null or pg_catalog.jsonb_typeof(p_concepts) <> 'array' then
    raise exception using errcode = '22023', message = 'concepts must be an array';
  end if;

  insert into public.visual_concepts(
    concept_key,
    description,
    literal_query,
    action_query,
    metaphor_query,
    embedding,
    enabled
  )
  select
    concept.concept_key,
    concept.description,
    concept.literal_query,
    concept.action_query,
    concept.metaphor_query,
    (concept.embedding::text)::extensions.vector,
    coalesce(concept.enabled, true)
  from pg_catalog.jsonb_to_recordset(p_concepts) as concept(
    concept_key text,
    description text,
    literal_query text,
    action_query text,
    metaphor_query text,
    embedding jsonb,
    enabled boolean
  )
  on conflict (concept_key) do update
  set description = excluded.description,
      literal_query = excluded.literal_query,
      action_query = excluded.action_query,
      metaphor_query = excluded.metaphor_query,
      embedding = excluded.embedding,
      enabled = excluded.enabled,
      updated_at = pg_catalog.clock_timestamp();

  get diagnostics affected_count = row_count;
  return affected_count;
end;
$$;

revoke all on function public.finish_video_search_run(uuid, text, boolean, jsonb, integer, integer, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.finish_video_search_run(uuid, text, boolean, jsonb, integer, integer, text, jsonb, jsonb) to service_role, postgres;
revoke all on function public.upsert_visual_concepts(jsonb) from public, anon, authenticated;
grant execute on function public.upsert_visual_concepts(jsonb) to service_role, postgres;
