create extension if not exists vector with schema extensions;

create table public.movies (
  id bigint generated always as identity primary key,
  title text not null constraint movies_title_not_blank_check check (btrim(title) <> ''),
  release_year integer constraint movies_release_year_range_check check (release_year between 1888 and 2200),
  imdb_id text constraint movies_imdb_id_key unique,
  created_at timestamptz not null default now()
);

create table public.subtitle_tracks (
  id bigint generated always as identity primary key,
  movie_id bigint not null references public.movies(id) on delete cascade,
  language_code text not null constraint subtitle_tracks_language_code_not_blank_check check (btrim(language_code) <> ''),
  source text not null constraint subtitle_tracks_source_not_blank_check check (btrim(source) <> ''),
  source_ref text,
  source_file_name text,
  source_sha256 text not null constraint subtitle_tracks_source_sha256_not_blank_check check (btrim(source_sha256) <> ''),
  rights_status text not null constraint subtitle_tracks_rights_status_check check (rights_status in ('personal_research', 'licensed', 'unverified')),
  embedding_model text not null default 'gte-small' constraint subtitle_tracks_embedding_model_not_blank_check check (btrim(embedding_model) <> ''),
  embedding_dimensions integer not null default 384 constraint subtitle_tracks_embedding_dimensions_check check (embedding_dimensions = 384),
  status text not null constraint subtitle_tracks_status_check check (status in ('processing', 'ready', 'failed')),
  created_at timestamptz not null default now(),
  constraint subtitle_tracks_movie_language_source_sha256_key unique (movie_id, language_code, source_sha256)
);

create table public.subtitle_cues (
  id bigint generated always as identity primary key,
  track_id bigint not null references public.subtitle_tracks(id) on delete cascade,
  cue_index integer not null constraint subtitle_cues_cue_index_check check (cue_index >= 0),
  start_ms integer not null constraint subtitle_cues_start_ms_check check (start_ms >= 0),
  end_ms integer not null constraint subtitle_cues_end_ms_check check (end_ms > start_ms),
  text text not null,
  constraint subtitle_cues_track_cue_index_key unique (track_id, cue_index)
);

create table public.subtitle_chunks (
  id bigint generated always as identity primary key,
  track_id bigint not null references public.subtitle_tracks(id) on delete cascade,
  chunk_index integer not null constraint subtitle_chunks_chunk_index_check check (chunk_index >= 0),
  start_ms integer not null constraint subtitle_chunks_start_ms_check check (start_ms >= 0),
  end_ms integer not null constraint subtitle_chunks_end_ms_check check (end_ms > start_ms),
  text text not null,
  first_cue_index integer not null constraint subtitle_chunks_first_cue_index_check check (first_cue_index >= 0),
  last_cue_index integer not null constraint subtitle_chunks_last_cue_index_check check (last_cue_index >= first_cue_index),
  embedding extensions.vector(384) not null,
  constraint subtitle_chunks_track_chunk_index_key unique (track_id, chunk_index)
);

create index subtitle_tracks_movie_id_idx on public.subtitle_tracks (movie_id);
create index subtitle_cues_track_id_idx on public.subtitle_cues (track_id);
create index subtitle_cues_track_id_start_ms_idx on public.subtitle_cues (track_id, start_ms);
create index subtitle_chunks_track_id_idx on public.subtitle_chunks (track_id);
create index subtitle_chunks_embedding_hnsw_idx
  on public.subtitle_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

create function public.match_subtitle_chunks(
  query_embedding extensions.vector(384),
  match_count integer,
  filter_movie_id bigint
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
  select
    movie.id,
    movie.title,
    movie.release_year,
    chunk.track_id,
    chunk.chunk_index,
    chunk.start_ms,
    chunk.end_ms,
    chunk.text,
    chunk.first_cue_index,
    chunk.last_cue_index,
    1 - (chunk.embedding operator(extensions.<=>) query_embedding) as similarity
  from public.subtitle_chunks as chunk
  join public.subtitle_tracks as track on track.id = chunk.track_id
  join public.movies as movie on movie.id = track.movie_id
  where track.status = 'ready'
    and (filter_movie_id is null or movie.id = filter_movie_id)
  order by chunk.embedding operator(extensions.<=>) query_embedding
  limit least(greatest(coalesce(match_count, 10), 1), 50);
$$;

alter table public.movies enable row level security;
alter table public.movies force row level security;
revoke all on table public.movies from public, anon, authenticated;
grant select, insert, update, delete on table public.movies to service_role;

alter table public.subtitle_tracks enable row level security;
alter table public.subtitle_tracks force row level security;
revoke all on table public.subtitle_tracks from public, anon, authenticated;
grant select, insert, update, delete on table public.subtitle_tracks to service_role;

alter table public.subtitle_cues enable row level security;
alter table public.subtitle_cues force row level security;
revoke all on table public.subtitle_cues from public, anon, authenticated;
grant select, insert, update, delete on table public.subtitle_cues to service_role;

alter table public.subtitle_chunks enable row level security;
alter table public.subtitle_chunks force row level security;
revoke all on table public.subtitle_chunks from public, anon, authenticated;
grant select, insert, update, delete on table public.subtitle_chunks to service_role;

revoke all on sequence public.movies_id_seq from public, anon, authenticated;
grant usage on sequence public.movies_id_seq to service_role;
revoke all on sequence public.subtitle_tracks_id_seq from public, anon, authenticated;
grant usage on sequence public.subtitle_tracks_id_seq to service_role;
revoke all on sequence public.subtitle_cues_id_seq from public, anon, authenticated;
grant usage on sequence public.subtitle_cues_id_seq to service_role;
revoke all on sequence public.subtitle_chunks_id_seq from public, anon, authenticated;
grant usage on sequence public.subtitle_chunks_id_seq to service_role;

revoke all on function public.match_subtitle_chunks(extensions.vector, integer, bigint) from public, anon, authenticated;
grant execute on function public.match_subtitle_chunks(extensions.vector, integer, bigint) to service_role;
