create or replace function public.search_movie_quote_montage(
  query_embedding extensions.vector(384),
  match_threshold double precision default 0.72,
  match_count integer default 8,
  max_per_movie integer default 1,
  filter_movie_ids bigint[] default null
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
  similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  with parameters as (
    select
      greatest(0::double precision, least(coalesce(match_threshold, 0.72), 1::double precision)) as threshold,
      greatest(3, least(coalesce(match_count, 8), 15)) as result_count,
      greatest(1, least(coalesce(max_per_movie, 1), 3)) as movie_limit
  ), candidates as materialized (
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
      chunk.embedding operator(extensions.<=>) query_embedding as distance
    from public.subtitle_chunks as chunk
    join public.subtitle_tracks as track on track.id = chunk.track_id
    join public.movies as movie on movie.id = track.movie_id
    cross join parameters
    where track.status = 'ready'
      and chunk.embedding is not null
      and (filter_movie_ids is null or movie.id = any(filter_movie_ids))
      and chunk.embedding operator(extensions.<=>) query_embedding <= 1 - parameters.threshold
    order by chunk.embedding operator(extensions.<=>) query_embedding
    limit least(200, (select result_count * 8 from parameters))
  ), diversified as (
    select
      candidates.*,
      row_number() over (
        partition by candidates.movie_id
        order by candidates.distance, candidates.track_id, candidates.chunk_index
      ) as movie_rank
    from candidates
  )
  select
    diversified.movie_id,
    diversified.movie_title,
    diversified.movie_release_year,
    diversified.track_id,
    diversified.chunk_index,
    diversified.start_ms,
    diversified.end_ms,
    diversified.text,
    diversified.first_cue_index,
    diversified.last_cue_index,
    1 - diversified.distance as similarity
  from diversified
  cross join parameters
  where diversified.movie_rank <= parameters.movie_limit
  order by diversified.distance, diversified.movie_id, diversified.track_id, diversified.chunk_index
  limit (select result_count from parameters);
$$;

revoke all on function public.search_movie_quote_montage(
  extensions.vector,
  double precision,
  integer,
  integer,
  bigint[]
) from public;
revoke all on function public.search_movie_quote_montage(
  extensions.vector,
  double precision,
  integer,
  integer,
  bigint[]
) from anon;
revoke all on function public.search_movie_quote_montage(
  extensions.vector,
  double precision,
  integer,
  integer,
  bigint[]
) from authenticated;
grant execute on function public.search_movie_quote_montage(
  extensions.vector,
  double precision,
  integer,
  integer,
  bigint[]
) to service_role;
grant execute on function public.search_movie_quote_montage(
  extensions.vector,
  double precision,
  integer,
  integer,
  bigint[]
) to postgres;
