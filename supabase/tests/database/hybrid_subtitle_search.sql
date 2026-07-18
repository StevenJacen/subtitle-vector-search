begin;

select plan(16);

select has_column(
  'public',
  'subtitle_chunks',
  'fts',
  'subtitle chunks have generated FTS'
);
select ok(
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'subtitle_chunks'
      and column_name = 'fts'
      and is_generated = 'ALWAYS'
  ),
  'subtitle chunks FTS is a stored generated column'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_indexes
    where schemaname = 'public'
      and tablename = 'subtitle_chunks'
      and indexname = 'subtitle_chunks_fts_gin_idx'
  ),
  'subtitle chunks have a GIN FTS index'
);
select has_function(
  'public',
  'hybrid_match_subtitle_chunks',
  array[
    'text',
    'extensions.vector',
    'integer',
    'double precision',
    'double precision',
    'integer',
    'bigint'
  ],
  'hybrid RPC exists'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'hybrid_match_subtitle_chunks'
      and not procedure.prosecdef
      and procedure.proconfig && array['search_path=', 'search_path=""']::text[]
  ),
  'hybrid RPC is security invoker with an empty search path'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.hybrid_match_subtitle_chunks(text,extensions.vector,integer,double precision,double precision,integer,bigint)',
    'execute'
  ),
  'anon cannot execute hybrid RPC'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.hybrid_match_subtitle_chunks(text,extensions.vector,integer,double precision,double precision,integer,bigint)',
    'execute'
  ),
  'authenticated cannot execute hybrid RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.hybrid_match_subtitle_chunks(text,extensions.vector,integer,double precision,double precision,integer,bigint)',
    'execute'
  ),
  'service role can execute hybrid RPC'
);

create temporary table hybrid_ids (
  movie_id bigint,
  track_id bigint,
  label text
);

with inserted_movie as (
  insert into public.movies(title, release_year, imdb_id)
  values ('Hybrid Alpha', 2031, 'hybrid-alpha')
  returning id
), inserted_track as (
  insert into public.subtitle_tracks(
    movie_id,
    language_code,
    source,
    source_sha256,
    rights_status,
    status
  )
  select id, 'en', 'synthetic', 'hybrid-alpha-sha', 'personal_research', 'ready'
  from inserted_movie
  returning id, movie_id
)
insert into hybrid_ids(movie_id, track_id, label)
select movie_id, id, 'alpha'
from inserted_track;

with inserted_movie as (
  insert into public.movies(title, release_year, imdb_id)
  values ('Hybrid Beta', 2032, 'hybrid-beta')
  returning id
), inserted_track as (
  insert into public.subtitle_tracks(
    movie_id,
    language_code,
    source,
    source_sha256,
    rights_status,
    status
  )
  select id, 'en', 'synthetic', 'hybrid-beta-sha', 'personal_research', 'ready'
  from inserted_movie
  returning id, movie_id
)
insert into hybrid_ids(movie_id, track_id, label)
select movie_id, id, 'beta'
from inserted_track;

with inserted_movie as (
  insert into public.movies(title, release_year, imdb_id)
  values ('Hybrid Processing', 2033, 'hybrid-processing')
  returning id
), inserted_track as (
  insert into public.subtitle_tracks(
    movie_id,
    language_code,
    source,
    source_sha256,
    rights_status,
    status
  )
  select id, 'en', 'synthetic', 'hybrid-processing-sha', 'personal_research', 'processing'
  from inserted_movie
  returning id, movie_id
)
insert into hybrid_ids(movie_id, track_id, label)
select movie_id, id, 'processing'
from inserted_track;

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
  hybrid_ids.track_id,
  source.chunk_index,
  source.chunk_index * 1000,
  source.chunk_index * 1000 + 900,
  source.text,
  source.chunk_index,
  source.chunk_index,
  ('[' || pg_catalog.array_to_string(
    pg_catalog.array_cat(
      array[source.x::real, source.y::real],
      pg_catalog.array_fill(0::real, array[382])
    ),
    ','
  ) || ']')::extensions.vector(384)
from hybrid_ids
join (
  values
    ('alpha', 0, 'love across time', 0.99, 0.01),
    ('alpha', 1, 'the years cannot divide us', 1.00, 0.00),
    ('alpha', 2, 'love love love through time', 0.10, 0.90),
    ('beta', 0, 'love beyond time', 0.98, 0.02),
    ('processing', 0, 'processing love and time', 1.00, 0.00)
) as source(label, chunk_index, text, x, y) on source.label = hybrid_ids.label;

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
  hybrid_ids.track_id,
  generated.chunk_index,
  generated.chunk_index * 1000,
  generated.chunk_index * 1000 + 900,
  'semantic filler ' || generated.chunk_index,
  generated.chunk_index,
  generated.chunk_index,
  ('[' || pg_catalog.array_to_string(
    pg_catalog.array_cat(
      array[0.9::real, 0.1::real],
      pg_catalog.array_fill(0::real, array[382])
    ),
    ','
  ) || ']')::extensions.vector(384)
from hybrid_ids
cross join pg_catalog.generate_series(10, 54) as generated(chunk_index)
where hybrid_ids.label = 'alpha';

create temporary table hybrid_query(embedding extensions.vector(384));
insert into hybrid_query
values (('[' || pg_catalog.array_to_string(
  pg_catalog.array_cat(
    array[1::real, 0::real],
    pg_catalog.array_fill(0::real, array[382])
  ),
  ','
) || ']')::extensions.vector(384));

select is(
  (
    select text
    from public.hybrid_match_subtitle_chunks(
      'love and time',
      (select embedding from hybrid_query),
      12,
      1,
      2,
      50,
      (select movie_id from hybrid_ids where label = 'alpha')
    )
    limit 1
  ),
  'love across time',
  'default RRF promotes a strong dual-path match'
);
select ok(
  exists (
    select 1
    from public.hybrid_match_subtitle_chunks(
      'love and time',
      (select embedding from hybrid_query),
      30,
      1,
      2,
      50,
      (select movie_id from hybrid_ids where label = 'alpha')
    )
    where text = 'the years cannot divide us'
      and full_text_rank is null
      and semantic_rank is not null
  ),
  'semantic-only candidate remains eligible'
);
select ok(
  exists (
    select 1
    from public.hybrid_match_subtitle_chunks(
      'love and time',
      (select embedding from hybrid_query),
      30,
      10,
      0,
      50,
      (select movie_id from hybrid_ids where label = 'alpha')
    )
    where text = 'love love love through time'
      and full_text_rank is not null
      and semantic_rank is null
  ),
  'keyword-only candidate remains eligible'
);
select is(
  (
    select text
    from public.hybrid_match_subtitle_chunks(
      'love and time',
      (select embedding from hybrid_query),
      12,
      10,
      0,
      50,
      (select movie_id from hybrid_ids where label = 'alpha')
    )
    limit 1
  ),
  'love love love through time',
  'keyword weight changes ordering predictably'
);
select ok(
  not exists (
    select 1
    from public.hybrid_match_subtitle_chunks(
      'love and time',
      (select embedding from hybrid_query),
      30,
      1,
      2,
      50,
      null
    )
    where movie_title = 'Hybrid Processing'
  ),
  'non-ready tracks are excluded'
);
select ok(
  not exists (
    select 1
    from public.hybrid_match_subtitle_chunks(
      'love and time',
      (select embedding from hybrid_query),
      30,
      1,
      2,
      50,
      (select movie_id from hybrid_ids where label = 'beta')
    )
    where movie_title <> 'Hybrid Beta'
  ),
  'movie filter cannot leak another movie'
);
select is(
  (
    select count(*)
    from public.hybrid_match_subtitle_chunks(
      'love and time',
      (select embedding from hybrid_query),
      999,
      -5,
      99,
      0,
      (select movie_id from hybrid_ids where label = 'alpha')
    )
  ),
  30::bigint,
  'numeric controls are clamped safely'
);
select is(
  (
    select pg_catalog.array_agg(first_call.chunk_index order by first_call.ordinality)
    from public.hybrid_match_subtitle_chunks(
      'love and time',
      (select embedding from hybrid_query),
      12,
      1,
      2,
      50,
      (select movie_id from hybrid_ids where label = 'alpha')
    ) with ordinality as first_call(
      movie_id,
      movie_title,
      movie_release_year,
      track_id,
      chunk_index,
      start_ms,
      end_ms,
      text,
      first_cue_index,
      last_cue_index,
      similarity,
      rrf_score,
      semantic_rank,
      full_text_rank,
      ordinality
    )
  ),
  (
    select pg_catalog.array_agg(second_call.chunk_index order by second_call.ordinality)
    from public.hybrid_match_subtitle_chunks(
      'love and time',
      (select embedding from hybrid_query),
      12,
      1,
      2,
      50,
      (select movie_id from hybrid_ids where label = 'alpha')
    ) with ordinality as second_call(
      movie_id,
      movie_title,
      movie_release_year,
      track_id,
      chunk_index,
      start_ms,
      end_ms,
      text,
      first_cue_index,
      last_cue_index,
      similarity,
      rrf_score,
      semantic_rank,
      full_text_rank,
      ordinality
    )
  ),
  'hybrid ordering is deterministic'
);

select * from finish();
rollback;
