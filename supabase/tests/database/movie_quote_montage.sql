begin;

select plan(10);

select has_function(
  'public',
  'search_movie_quote_montage',
  array['extensions.vector', 'double precision', 'integer', 'integer', 'bigint[]'],
  'montage RPC exists'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.search_movie_quote_montage(extensions.vector,double precision,integer,integer,bigint[])',
    'execute'
  ),
  'anon cannot execute montage RPC'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.search_movie_quote_montage(extensions.vector,double precision,integer,integer,bigint[])',
    'execute'
  ),
  'authenticated cannot execute montage RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.search_movie_quote_montage(extensions.vector,double precision,integer,integer,bigint[])',
    'execute'
  ),
  'service role can execute montage RPC'
);

create temporary table montage_ids(movie_id bigint, track_id bigint, label text);

with first_movie as (
  insert into public.movies(title, release_year, imdb_id)
  values ('Montage Alpha', 2031, 'montage-alpha')
  returning id
), first_track as (
  insert into public.subtitle_tracks(movie_id, language_code, source, source_sha256, rights_status, status)
  select id, 'en', 'synthetic', 'montage-alpha-sha', 'personal_research', 'ready'
  from first_movie
  returning id, movie_id
)
insert into montage_ids
select movie_id, id, 'alpha'
from first_track;

with second_movie as (
  insert into public.movies(title, release_year, imdb_id)
  values ('Montage Beta', 2032, 'montage-beta')
  returning id
), second_track as (
  insert into public.subtitle_tracks(movie_id, language_code, source, source_sha256, rights_status, status)
  select id, 'en', 'synthetic', 'montage-beta-sha', 'personal_research', 'ready'
  from second_movie
  returning id, movie_id
)
insert into montage_ids
select movie_id, id, 'beta'
from second_track;

insert into public.subtitle_chunks(
  track_id,
  chunk_index,
  start_ms,
  end_ms,
  text,
  first_cue_index,
  last_cue_index,
  embedding
)
select
  track_id,
  chunk_index,
  chunk_index * 1000,
  chunk_index * 1000 + 900,
  label || ' chunk ' || chunk_index,
  chunk_index,
  chunk_index,
  ('[' || pg_catalog.array_to_string(
    pg_catalog.array_cat(
      case
        when label = 'alpha' and chunk_index = 0 then array[1::real, 0::real]
        when label = 'alpha' then array[0.9::real, 0.1::real]
        else array[0.8::real, 0.2::real]
      end,
      pg_catalog.array_fill(0::real, array[382])
    ),
    ','
  ) || ']')::extensions.vector(384)
from montage_ids
cross join pg_catalog.generate_series(0, 1) as generated(chunk_index);

create temporary table montage_query(embedding extensions.vector(384));
insert into montage_query
values (('[' || pg_catalog.array_to_string(
  pg_catalog.array_cat(array[1::real, 0::real], pg_catalog.array_fill(0::real, array[382])),
  ','
) || ']')::extensions.vector(384));

select is(
  (select count(*) from public.search_movie_quote_montage(
    (select embedding from montage_query),
    0,
    15,
    1,
    array(select movie_id from montage_ids order by movie_id)
  )),
  2::bigint,
  'per-movie cap keeps one result from each movie'
);
select is(
  (select movie_title from public.search_movie_quote_montage(
    (select embedding from montage_query),
    0,
    3,
    1,
    array(select movie_id from montage_ids order by movie_id)
  ) limit 1),
  'Montage Alpha',
  'results are ordered by descending similarity'
);
select ok(
  not exists (
    select 1
    from public.search_movie_quote_montage(
      (select embedding from montage_query),
      0.95,
      15,
      3,
      array(select movie_id from montage_ids order by movie_id)
    )
    where similarity < 0.95
  ),
  'threshold excludes weaker matches'
);
select is(
  (select count(*) from public.search_movie_quote_montage(
    (select embedding from montage_query),
    0,
    15,
    3,
    array[(select movie_id from montage_ids where label = 'beta')]
  )),
  2::bigint,
  'movie filter returns only requested movie rows'
);
select ok(
  not exists (
    select 1
    from public.search_movie_quote_montage(
      (select embedding from montage_query),
      0,
      15,
      3,
      array[(select movie_id from montage_ids where label = 'beta')]
    )
    where movie_title <> 'Montage Beta'
  ),
  'movie filter never leaks other movies'
);
select is(
  (select count(*) from public.search_movie_quote_montage(
    (select embedding from montage_query),
    -9,
    0,
    99,
    array(select movie_id from montage_ids order by movie_id)
  )),
  3::bigint,
  'numeric inputs are clamped safely'
);

select * from finish();
rollback;
