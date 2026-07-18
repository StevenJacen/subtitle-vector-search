alter table public.subtitle_chunks
  add column fts pg_catalog.tsvector
  generated always as (
    pg_catalog.to_tsvector('english'::pg_catalog.regconfig, text)
  ) stored;

create index subtitle_chunks_fts_gin_idx
  on public.subtitle_chunks
  using gin (fts);

create function public.hybrid_match_subtitle_chunks(
  query_text text,
  query_embedding extensions.vector(384),
  match_count integer default 12,
  full_text_weight double precision default 1,
  semantic_weight double precision default 2,
  rrf_k integer default 50,
  filter_movie_id bigint default null
)
returns table (
  movie_id bigint,
  movie_title text,
  movie_release_year integer,
  track_id bigint,
  chunk_index integer,
  start_ms integer,
  end_ms integer,
  text text,
  first_cue_index integer,
  last_cue_index integer,
  similarity double precision,
  rrf_score double precision,
  semantic_rank bigint,
  full_text_rank bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with parameters as (
    select
      greatest(1, least(coalesce(match_count, 12), 30)) as result_count,
      greatest(
        0::double precision,
        least(coalesce(full_text_weight, 1), 10::double precision)
      ) as text_weight,
      greatest(
        0::double precision,
        least(coalesce(semantic_weight, 2), 10::double precision)
      ) as vector_weight,
      greatest(1, least(coalesce(rrf_k, 50), 1000)) as smoothing
  ), parsed_query as (
    select pg_catalog.websearch_to_tsquery(
      'english'::pg_catalog.regconfig,
      coalesce(query_text, '')
    ) as value
  ), full_text_candidates as materialized (
    select
      chunk.id,
      pg_catalog.ts_rank_cd(chunk.fts, parsed_query.value) as text_score
    from public.subtitle_chunks as chunk
    join public.subtitle_tracks as track on track.id = chunk.track_id
    join public.movies as movie on movie.id = track.movie_id
    cross join parsed_query
    where track.status = 'ready'
      and (filter_movie_id is null or movie.id = filter_movie_id)
      and chunk.fts @@ parsed_query.value
    order by text_score desc, chunk.id
    limit 40
  ), full_text as (
    select
      id,
      row_number() over (order by text_score desc, id) as rank_ix
    from full_text_candidates
  ), semantic_candidates as materialized (
    select
      chunk.id,
      chunk.embedding operator(extensions.<=>) query_embedding as distance
    from public.subtitle_chunks as chunk
    join public.subtitle_tracks as track on track.id = chunk.track_id
    join public.movies as movie on movie.id = track.movie_id
    where track.status = 'ready'
      and (filter_movie_id is null or movie.id = filter_movie_id)
    order by chunk.embedding operator(extensions.<=>) query_embedding
    limit 40
  ), semantic as (
    select
      id,
      distance,
      row_number() over (order by distance, id) as rank_ix
    from semantic_candidates
  ), fused as (
    select
      coalesce(full_text.id, semantic.id) as chunk_id,
      full_text.rank_ix as full_text_rank,
      semantic.rank_ix as semantic_rank,
      semantic.distance,
      coalesce(
        1.0 / (parameters.smoothing + full_text.rank_ix),
        0.0
      ) * parameters.text_weight
        + coalesce(
          1.0 / (parameters.smoothing + semantic.rank_ix),
          0.0
        ) * parameters.vector_weight as rrf_score
    from full_text
    full outer join semantic on semantic.id = full_text.id
    cross join parameters
  )
  select
    movie.id as movie_id,
    movie.title as movie_title,
    movie.release_year as movie_release_year,
    chunk.track_id,
    chunk.chunk_index,
    chunk.start_ms,
    chunk.end_ms,
    chunk.text,
    chunk.first_cue_index,
    chunk.last_cue_index,
    1 - (chunk.embedding operator(extensions.<=>) query_embedding) as similarity,
    fused.rrf_score,
    fused.semantic_rank,
    fused.full_text_rank
  from fused
  join public.subtitle_chunks as chunk on chunk.id = fused.chunk_id
  join public.subtitle_tracks as track on track.id = chunk.track_id
  join public.movies as movie on movie.id = track.movie_id
  cross join parameters
  order by
    fused.rrf_score desc,
    coalesce(
      fused.distance,
      chunk.embedding operator(extensions.<=>) query_embedding
    ),
    movie.id,
    chunk.track_id,
    chunk.chunk_index
  limit (select result_count from parameters);
$$;

revoke all on function public.hybrid_match_subtitle_chunks(
  text,
  extensions.vector,
  integer,
  double precision,
  double precision,
  integer,
  bigint
) from public;
revoke all on function public.hybrid_match_subtitle_chunks(
  text,
  extensions.vector,
  integer,
  double precision,
  double precision,
  integer,
  bigint
) from anon;
revoke all on function public.hybrid_match_subtitle_chunks(
  text,
  extensions.vector,
  integer,
  double precision,
  double precision,
  integer,
  bigint
) from authenticated;
grant execute on function public.hybrid_match_subtitle_chunks(
  text,
  extensions.vector,
  integer,
  double precision,
  double precision,
  integer,
  bigint
) to service_role;
grant execute on function public.hybrid_match_subtitle_chunks(
  text,
  extensions.vector,
  integer,
  double precision,
  double precision,
  integer,
  bigint
) to postgres;
