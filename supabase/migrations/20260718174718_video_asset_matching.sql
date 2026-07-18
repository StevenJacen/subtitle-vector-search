create table public.visual_concepts (
  id bigint generated always as identity primary key,
  concept_key text not null constraint visual_concepts_concept_key_not_blank_check check (pg_catalog.btrim(concept_key) <> ''),
  description text not null constraint visual_concepts_description_not_blank_check check (pg_catalog.btrim(description) <> ''),
  literal_query text not null constraint visual_concepts_literal_query_not_blank_check check (pg_catalog.btrim(literal_query) <> ''),
  action_query text not null constraint visual_concepts_action_query_not_blank_check check (pg_catalog.btrim(action_query) <> ''),
  metaphor_query text not null constraint visual_concepts_metaphor_query_not_blank_check check (pg_catalog.btrim(metaphor_query) <> ''),
  embedding extensions.vector(384) not null,
  enabled boolean not null default true,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint visual_concepts_concept_key_key unique (concept_key)
);

create table public.video_search_runs (
  id uuid primary key default gen_random_uuid(),
  subtitle_chunk_id bigint references public.subtitle_chunks(id),
  input_kind text not null constraint video_search_runs_input_kind_check check (input_kind in ('chunk', 'text', 'theme')),
  input_digest text not null constraint video_search_runs_input_digest_check check (input_digest ~ '^[0-9a-f]{64}$'),
  theme text constraint video_search_runs_theme_length_check check (theme is null or pg_catalog.char_length(theme) between 1 and 300),
  candidate_count integer not null constraint video_search_runs_candidate_count_check check (candidate_count between 5 and 10),
  status text not null constraint video_search_runs_status_check check (status in ('planning', 'completed', 'degraded', 'failed')),
  planner_model text not null constraint video_search_runs_planner_model_not_blank_check check (pg_catalog.btrim(planner_model) <> ''),
  prompt_version text not null constraint video_search_runs_prompt_version_not_blank_check check (pg_catalog.btrim(prompt_version) <> ''),
  fallback_used boolean not null default false,
  visual_intent jsonb,
  planner_elapsed_ms integer constraint video_search_runs_planner_elapsed_ms_check check (planner_elapsed_ms is null or planner_elapsed_ms >= 0),
  total_elapsed_ms integer constraint video_search_runs_total_elapsed_ms_check check (total_elapsed_ms is null or total_elapsed_ms >= 0),
  failure_code text,
  created_at timestamptz not null default pg_catalog.now(),
  completed_at timestamptz,
  constraint video_search_runs_input_owner_check check (
    (input_kind = 'chunk' and subtitle_chunk_id is not null)
    or (input_kind in ('text', 'theme') and subtitle_chunk_id is null)
  ),
  constraint video_search_runs_theme_input_check check (
    input_kind <> 'theme' or theme is not null
  )
);

create unique index video_search_runs_active_digest_idx
on public.video_search_runs (input_digest, prompt_version)
where status in ('planning', 'completed', 'degraded');

create index video_search_runs_subtitle_chunk_id_idx
on public.video_search_runs (subtitle_chunk_id)
where subtitle_chunk_id is not null;

create table public.video_search_queries (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.video_search_runs(id) on delete cascade,
  kind text not null constraint video_search_queries_kind_check check (kind in ('literal', 'action', 'metaphor')),
  term text not null constraint video_search_queries_term_check check (pg_catalog.char_length(pg_catalog.btrim(term)) between 1 and 180),
  weight double precision not null constraint video_search_queries_weight_check check (weight > 0 and weight <= 1),
  filters jsonb not null constraint video_search_queries_filters_check check (pg_catalog.jsonb_typeof(filters) = 'object'),
  provider_total integer constraint video_search_queries_provider_total_check check (provider_total is null or provider_total >= 0),
  status text not null constraint video_search_queries_status_check check (status in ('completed', 'failed')),
  elapsed_ms integer constraint video_search_queries_elapsed_ms_check check (elapsed_ms is null or elapsed_ms >= 0),
  created_at timestamptz not null default pg_catalog.now(),
  constraint video_search_queries_run_id_kind_key unique (run_id, kind)
);

create index video_search_queries_run_id_idx on public.video_search_queries (run_id);

create table public.video_search_candidates (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.video_search_runs(id) on delete cascade,
  provider text not null default 'vecteezy' constraint video_search_candidates_provider_check check (provider = 'vecteezy'),
  provider_resource_id bigint not null constraint video_search_candidates_provider_resource_id_check check (provider_resource_id > 0),
  title text,
  content_type text not null constraint video_search_candidates_content_type_check check (content_type = 'video'),
  license_type text,
  ai_generated boolean,
  orientation text,
  tags text[] not null default '{}',
  file_types jsonb not null default '[]'::jsonb,
  download_sizes jsonb not null default '[]'::jsonb,
  fused_score double precision not null constraint video_search_candidates_fused_score_check check (fused_score > 0 and fused_score < 'Infinity'::double precision),
  best_rank integer not null constraint video_search_candidates_best_rank_check check (best_rank > 0),
  matched_query_kinds text[] not null constraint video_search_candidates_matched_query_kinds_check check (
    pg_catalog.cardinality(matched_query_kinds) between 1 and 3
    and matched_query_kinds <@ array['literal', 'action', 'metaphor']::text[]
  ),
  created_at timestamptz not null default pg_catalog.now(),
  constraint video_search_candidates_file_types_check check (
    pg_catalog.jsonb_typeof(file_types) = 'array'
    and not pg_catalog.jsonb_path_exists(file_types, '$[*] ? (@.type() != "object")')
    and not pg_catalog.jsonb_path_exists(file_types, '$[*].keyvalue() ? (@.key != "extension" && @.key != "sizeInBytes")')
    and not pg_catalog.jsonb_path_exists(file_types, '$[*] ? (!exists(@.extension) || @.extension.type() != "string" || @.extension == "" || !exists(@.sizeInBytes) || @.sizeInBytes.type() != "number" || @.sizeInBytes <= 0)')
  ),
  constraint video_search_candidates_download_sizes_check check (
    pg_catalog.jsonb_typeof(download_sizes) = 'array'
    and not pg_catalog.jsonb_path_exists(download_sizes, '$[*] ? (@.type() != "object")')
    and not pg_catalog.jsonb_path_exists(download_sizes, '$[*].keyvalue() ? (@.key != "id" && @.key != "width" && @.key != "height")')
    and not pg_catalog.jsonb_path_exists(download_sizes, '$[*] ? (!exists(@.id) || @.id.type() != "string" || @.id == "" || !exists(@.width) || @.width.type() != "number" || @.width <= 0 || !exists(@.height) || @.height.type() != "number" || @.height <= 0)')
  ),
  constraint video_search_candidates_run_provider_resource_key unique (run_id, provider, provider_resource_id)
);

alter table public.video_search_candidates
  add constraint video_search_candidates_run_id_id_key unique (run_id, id);

create index video_search_candidates_run_id_idx on public.video_search_candidates (run_id);

create table public.video_asset_selections (
  id bigint generated always as identity primary key,
  run_id uuid not null constraint video_asset_selections_run_id_key unique references public.video_search_runs(id) on delete cascade,
  candidate_id bigint not null,
  note text constraint video_asset_selections_note_length_check check (note is null or pg_catalog.char_length(note) <= 500),
  selected_at timestamptz not null default pg_catalog.now()
);

alter table public.video_asset_selections
  add constraint video_asset_selections_candidate_owner_fkey
  foreign key (run_id, candidate_id)
  references public.video_search_candidates(run_id, id)
  on delete cascade;

create function public.begin_video_search_run(
  p_subtitle_chunk_id bigint,
  p_input_kind text,
  p_input_digest text,
  p_theme text,
  p_candidate_count integer,
  p_planner_model text,
  p_prompt_version text
)
returns table (run_id uuid, status text, is_existing boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing_run public.video_search_runs%rowtype;
  inserted_run public.video_search_runs%rowtype;
begin
  update public.video_search_runs as run
  set status = 'failed',
      failure_code = 'stale_planning',
      completed_at = pg_catalog.clock_timestamp()
  where run.input_digest = p_input_digest
    and run.prompt_version = p_prompt_version
    and run.status = 'planning'
    and run.created_at < pg_catalog.clock_timestamp() - interval '5 minutes';

  select run.*
  into existing_run
  from public.video_search_runs as run
  where run.input_digest = p_input_digest
    and run.prompt_version = p_prompt_version
    and run.status in ('planning', 'completed', 'degraded')
  order by run.created_at desc
  limit 1;

  if found then
    return query select existing_run.id, existing_run.status, true;
    return;
  end if;

  begin
    insert into public.video_search_runs(
      subtitle_chunk_id,
      input_kind,
      input_digest,
      theme,
      candidate_count,
      status,
      planner_model,
      prompt_version
    )
    values (
      p_subtitle_chunk_id,
      p_input_kind,
      p_input_digest,
      p_theme,
      p_candidate_count,
      'planning',
      p_planner_model,
      p_prompt_version
    )
    returning * into inserted_run;
  exception
    when unique_violation then
      select run.*
      into existing_run
      from public.video_search_runs as run
      where run.input_digest = p_input_digest
        and run.prompt_version = p_prompt_version
        and run.status in ('planning', 'completed', 'degraded')
      order by run.created_at desc
      limit 1;

      if not found then
        raise;
      end if;

      return query select existing_run.id, existing_run.status, true;
      return;
  end;

  return query select inserted_run.id, inserted_run.status, false;
end;
$$;

create function public.finish_video_search_run(
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
      pg_catalog.coalesce(candidate->>'provider', 'vecteezy'),
      (candidate->>'provider_resource_id')::bigint,
      candidate->>'title',
      candidate->>'content_type',
      candidate->>'license_type',
      (candidate->>'ai_generated')::boolean,
      candidate->>'orientation',
      array(select pg_catalog.jsonb_array_elements_text(pg_catalog.coalesce(candidate->'tags', '[]'::jsonb))),
      pg_catalog.coalesce(candidate->'file_types', '[]'::jsonb),
      pg_catalog.coalesce(candidate->'download_sizes', '[]'::jsonb),
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

create function public.match_visual_concept(
  query_embedding extensions.vector(384)
)
returns table (
  concept_key text,
  description text,
  literal_query text,
  action_query text,
  metaphor_query text,
  similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    concept.concept_key,
    concept.description,
    concept.literal_query,
    concept.action_query,
    concept.metaphor_query,
    1 - (concept.embedding operator(extensions.<=>) query_embedding) as similarity
  from public.visual_concepts as concept
  where concept.enabled
  order by concept.embedding operator(extensions.<=>) query_embedding, concept.id
  limit 1;
$$;

create function public.upsert_visual_concepts(
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
    pg_catalog.coalesce(concept.enabled, true)
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

create function public.select_video_asset(
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
  persisted_selection_id bigint;
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

  insert into public.video_asset_selections(run_id, candidate_id, note)
  values (p_run_id, owned_candidate_id, p_note)
  on conflict (run_id) do update
  set candidate_id = excluded.candidate_id,
      note = excluded.note,
      selected_at = pg_catalog.clock_timestamp()
  returning id into persisted_selection_id;

  return query select persisted_selection_id;
end;
$$;

alter table public.visual_concepts enable row level security;
alter table public.visual_concepts force row level security;
revoke all on table public.visual_concepts from public, anon, authenticated;
grant select, insert, update, delete on table public.visual_concepts to service_role;

alter table public.video_search_runs enable row level security;
alter table public.video_search_runs force row level security;
revoke all on table public.video_search_runs from public, anon, authenticated;
grant select, insert, update, delete on table public.video_search_runs to service_role;

alter table public.video_search_queries enable row level security;
alter table public.video_search_queries force row level security;
revoke all on table public.video_search_queries from public, anon, authenticated;
grant select, insert, update, delete on table public.video_search_queries to service_role;

alter table public.video_search_candidates enable row level security;
alter table public.video_search_candidates force row level security;
revoke all on table public.video_search_candidates from public, anon, authenticated;
grant select, insert, update, delete on table public.video_search_candidates to service_role;

alter table public.video_asset_selections enable row level security;
alter table public.video_asset_selections force row level security;
revoke all on table public.video_asset_selections from public, anon, authenticated;
grant select, insert, update, delete on table public.video_asset_selections to service_role;

revoke all on sequence public.visual_concepts_id_seq from public, anon, authenticated;
grant usage on sequence public.visual_concepts_id_seq to service_role;
revoke all on sequence public.video_search_queries_id_seq from public, anon, authenticated;
grant usage on sequence public.video_search_queries_id_seq to service_role;
revoke all on sequence public.video_search_candidates_id_seq from public, anon, authenticated;
grant usage on sequence public.video_search_candidates_id_seq to service_role;
revoke all on sequence public.video_asset_selections_id_seq from public, anon, authenticated;
grant usage on sequence public.video_asset_selections_id_seq to service_role;

revoke all on function public.begin_video_search_run(bigint, text, text, text, integer, text, text) from public, anon, authenticated;
grant execute on function public.begin_video_search_run(bigint, text, text, text, integer, text, text) to service_role, postgres;
revoke all on function public.finish_video_search_run(uuid, text, boolean, jsonb, integer, integer, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.finish_video_search_run(uuid, text, boolean, jsonb, integer, integer, text, jsonb, jsonb) to service_role, postgres;
revoke all on function public.match_visual_concept(extensions.vector) from public, anon, authenticated;
grant execute on function public.match_visual_concept(extensions.vector) to service_role, postgres;
revoke all on function public.upsert_visual_concepts(jsonb) from public, anon, authenticated;
grant execute on function public.upsert_visual_concepts(jsonb) to service_role, postgres;
revoke all on function public.select_video_asset(uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.select_video_asset(uuid, bigint, text) to service_role, postgres;
