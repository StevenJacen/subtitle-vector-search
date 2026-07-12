begin;

select plan(101);

select has_table('public', 'movies', 'movies table exists');
select has_table('public', 'subtitle_tracks', 'subtitle_tracks table exists');
select has_table('public', 'subtitle_cues', 'subtitle_cues table exists');
select has_table('public', 'subtitle_chunks', 'subtitle_chunks table exists');

select is(
  pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
  'extensions.vector(384)',
  'subtitle_chunks.embedding has 384 dimensions in the extensions schema'
)
from pg_catalog.pg_attribute as attribute
where attribute.attrelid = 'public.subtitle_chunks'::pg_catalog.regclass
  and attribute.attname = 'embedding'
  and not attribute.attisdropped;

select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint as constraint
    where constraint.conrelid = 'public.subtitle_tracks'::pg_catalog.regclass
      and constraint.contype = 'f'
      and constraint.confrelid = 'public.movies'::pg_catalog.regclass
  ),
  'subtitle_tracks references movies'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint as constraint
    where constraint.conrelid = 'public.subtitle_cues'::pg_catalog.regclass
      and constraint.contype = 'f'
      and constraint.confrelid = 'public.subtitle_tracks'::pg_catalog.regclass
  ),
  'subtitle_cues references subtitle_tracks'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint as constraint
    where constraint.conrelid = 'public.subtitle_chunks'::pg_catalog.regclass
      and constraint.contype = 'f'
      and constraint.confrelid = 'public.subtitle_tracks'::pg_catalog.regclass
  ),
  'subtitle_chunks references subtitle_tracks'
);

select ok(pg_catalog.to_regclass('public.subtitle_tracks_movie_id_idx') is not null, 'subtitle_tracks movie foreign key is indexed');
select ok(pg_catalog.to_regclass('public.subtitle_cues_track_id_idx') is not null, 'subtitle_cues track foreign key is indexed');
select ok(pg_catalog.to_regclass('public.subtitle_chunks_track_id_idx') is not null, 'subtitle_chunks track foreign key is indexed');
select ok(pg_catalog.to_regclass('public.subtitle_cues_track_id_start_ms_idx') is not null, 'subtitle_cues track timestamp lookup is indexed');
select ok(
  exists (
    select 1
    from pg_catalog.pg_class as index_class
    join pg_catalog.pg_am as access_method on access_method.oid = index_class.relam
    join pg_catalog.pg_index as index_definition on index_definition.indexrelid = index_class.oid
    join pg_catalog.pg_opclass as operator_class on operator_class.oid = (index_definition.indclass::oid[])[1]
    join pg_catalog.pg_namespace as operator_namespace on operator_namespace.oid = operator_class.opcnamespace
    where index_class.oid = 'public.subtitle_chunks_embedding_hnsw_idx'::pg_catalog.regclass
      and access_method.amname = 'hnsw'
      and operator_class.opcname = 'vector_cosine_ops'
      and operator_namespace.nspname = 'extensions'
  ),
  'subtitle_chunks has an HNSW embedding index'
);

select ok(class.relrowsecurity, 'movies has RLS enabled')
from pg_catalog.pg_class as class
where class.oid = 'public.movies'::pg_catalog.regclass;
select ok(class.relrowsecurity, 'subtitle_tracks has RLS enabled')
from pg_catalog.pg_class as class
where class.oid = 'public.subtitle_tracks'::pg_catalog.regclass;
select ok(class.relrowsecurity, 'subtitle_cues has RLS enabled')
from pg_catalog.pg_class as class
where class.oid = 'public.subtitle_cues'::pg_catalog.regclass;
select ok(class.relrowsecurity, 'subtitle_chunks has RLS enabled')
from pg_catalog.pg_class as class
where class.oid = 'public.subtitle_chunks'::pg_catalog.regclass;

select ok(class.relforcerowsecurity, 'movies forces RLS')
from pg_catalog.pg_class as class
where class.oid = 'public.movies'::pg_catalog.regclass;
select ok(class.relforcerowsecurity, 'subtitle_tracks forces RLS')
from pg_catalog.pg_class as class
where class.oid = 'public.subtitle_tracks'::pg_catalog.regclass;
select ok(class.relforcerowsecurity, 'subtitle_cues forces RLS')
from pg_catalog.pg_class as class
where class.oid = 'public.subtitle_cues'::pg_catalog.regclass;
select ok(class.relforcerowsecurity, 'subtitle_chunks forces RLS')
from pg_catalog.pg_class as class
where class.oid = 'public.subtitle_chunks'::pg_catalog.regclass;

select ok(not exists (select 1 from pg_catalog.pg_policy where polrelid = 'public.movies'::pg_catalog.regclass), 'movies has no policies');
select ok(not exists (select 1 from pg_catalog.pg_policy where polrelid = 'public.subtitle_tracks'::pg_catalog.regclass), 'subtitle_tracks has no policies');
select ok(not exists (select 1 from pg_catalog.pg_policy where polrelid = 'public.subtitle_cues'::pg_catalog.regclass), 'subtitle_cues has no policies');
select ok(not exists (select 1 from pg_catalog.pg_policy where polrelid = 'public.subtitle_chunks'::pg_catalog.regclass), 'subtitle_chunks has no policies');

select ok(not has_table_privilege('anon', 'public.movies', 'select'), 'anon cannot select movies');
select ok(not has_table_privilege('anon', 'public.subtitle_tracks', 'select'), 'anon cannot select subtitle_tracks');
select ok(not has_table_privilege('anon', 'public.subtitle_cues', 'select'), 'anon cannot select subtitle_cues');
select ok(not has_table_privilege('anon', 'public.subtitle_chunks', 'select'), 'anon cannot select subtitle_chunks');
select ok(not has_table_privilege('authenticated', 'public.movies', 'select'), 'authenticated cannot select movies');
select ok(not has_table_privilege('authenticated', 'public.subtitle_tracks', 'select'), 'authenticated cannot select subtitle_tracks');
select ok(not has_table_privilege('authenticated', 'public.subtitle_cues', 'select'), 'authenticated cannot select subtitle_cues');
select ok(not has_table_privilege('authenticated', 'public.subtitle_chunks', 'select'), 'authenticated cannot select subtitle_chunks');
select ok(not has_table_privilege('anon', 'public.movies', 'insert'), 'anon cannot insert movies');
select ok(not has_table_privilege('anon', 'public.movies', 'update'), 'anon cannot update movies');
select ok(not has_table_privilege('anon', 'public.movies', 'delete'), 'anon cannot delete movies');
select ok(not has_table_privilege('anon', 'public.subtitle_tracks', 'insert'), 'anon cannot insert subtitle_tracks');
select ok(not has_table_privilege('anon', 'public.subtitle_tracks', 'update'), 'anon cannot update subtitle_tracks');
select ok(not has_table_privilege('anon', 'public.subtitle_tracks', 'delete'), 'anon cannot delete subtitle_tracks');
select ok(not has_table_privilege('anon', 'public.subtitle_cues', 'insert'), 'anon cannot insert subtitle_cues');
select ok(not has_table_privilege('anon', 'public.subtitle_cues', 'update'), 'anon cannot update subtitle_cues');
select ok(not has_table_privilege('anon', 'public.subtitle_cues', 'delete'), 'anon cannot delete subtitle_cues');
select ok(not has_table_privilege('anon', 'public.subtitle_chunks', 'insert'), 'anon cannot insert subtitle_chunks');
select ok(not has_table_privilege('anon', 'public.subtitle_chunks', 'update'), 'anon cannot update subtitle_chunks');
select ok(not has_table_privilege('anon', 'public.subtitle_chunks', 'delete'), 'anon cannot delete subtitle_chunks');
select ok(not has_table_privilege('authenticated', 'public.movies', 'insert'), 'authenticated cannot insert movies');
select ok(not has_table_privilege('authenticated', 'public.movies', 'update'), 'authenticated cannot update movies');
select ok(not has_table_privilege('authenticated', 'public.movies', 'delete'), 'authenticated cannot delete movies');
select ok(not has_table_privilege('authenticated', 'public.subtitle_tracks', 'insert'), 'authenticated cannot insert subtitle_tracks');
select ok(not has_table_privilege('authenticated', 'public.subtitle_tracks', 'update'), 'authenticated cannot update subtitle_tracks');
select ok(not has_table_privilege('authenticated', 'public.subtitle_tracks', 'delete'), 'authenticated cannot delete subtitle_tracks');
select ok(not has_table_privilege('authenticated', 'public.subtitle_cues', 'insert'), 'authenticated cannot insert subtitle_cues');
select ok(not has_table_privilege('authenticated', 'public.subtitle_cues', 'update'), 'authenticated cannot update subtitle_cues');
select ok(not has_table_privilege('authenticated', 'public.subtitle_cues', 'delete'), 'authenticated cannot delete subtitle_cues');
select ok(not has_table_privilege('authenticated', 'public.subtitle_chunks', 'insert'), 'authenticated cannot insert subtitle_chunks');
select ok(not has_table_privilege('authenticated', 'public.subtitle_chunks', 'update'), 'authenticated cannot update subtitle_chunks');
select ok(not has_table_privilege('authenticated', 'public.subtitle_chunks', 'delete'), 'authenticated cannot delete subtitle_chunks');

select ok(
  has_table_privilege('service_role', 'public.movies', 'select')
  and has_table_privilege('service_role', 'public.movies', 'insert')
  and has_table_privilege('service_role', 'public.movies', 'update')
  and has_table_privilege('service_role', 'public.movies', 'delete'),
  'service_role has movie table privileges'
);
select ok(
  has_table_privilege('service_role', 'public.subtitle_tracks', 'select')
  and has_table_privilege('service_role', 'public.subtitle_tracks', 'insert')
  and has_table_privilege('service_role', 'public.subtitle_tracks', 'update')
  and has_table_privilege('service_role', 'public.subtitle_tracks', 'delete'),
  'service_role has subtitle track table privileges'
);
select ok(
  has_table_privilege('service_role', 'public.subtitle_cues', 'select')
  and has_table_privilege('service_role', 'public.subtitle_cues', 'insert')
  and has_table_privilege('service_role', 'public.subtitle_cues', 'update')
  and has_table_privilege('service_role', 'public.subtitle_cues', 'delete'),
  'service_role has subtitle cue table privileges'
);
select ok(
  has_table_privilege('service_role', 'public.subtitle_chunks', 'select')
  and has_table_privilege('service_role', 'public.subtitle_chunks', 'insert')
  and has_table_privilege('service_role', 'public.subtitle_chunks', 'update')
  and has_table_privilege('service_role', 'public.subtitle_chunks', 'delete'),
  'service_role has subtitle chunk table privileges'
);

select ok(
  exists (
    select 1
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'match_subtitle_chunks'
      and procedure.prosecdef is false
      and exists (
        select 1
        from pg_catalog.unnest(coalesce(procedure.proconfig, array[]::text[])) as setting
        where setting = 'search_path='
      )
  ),
  'match_subtitle_chunks is a security invoker function with an explicit search path'
);
select ok(
  not has_function_privilege('anon', 'public.match_subtitle_chunks(extensions.vector,integer,bigint)', 'execute'),
  'anon cannot execute match_subtitle_chunks'
);
select ok(
  not has_function_privilege('authenticated', 'public.match_subtitle_chunks(extensions.vector,integer,bigint)', 'execute'),
  'authenticated cannot execute match_subtitle_chunks'
);
select ok(
  has_function_privilege('service_role', 'public.match_subtitle_chunks(extensions.vector,integer,bigint)', 'execute'),
  'service_role can execute match_subtitle_chunks'
);

select ok(has_sequence_privilege('service_role', 'public.movies_id_seq', 'usage'), 'service_role can use movies identity sequence');
select ok(has_sequence_privilege('service_role', 'public.subtitle_tracks_id_seq', 'usage'), 'service_role can use subtitle_tracks identity sequence');
select ok(has_sequence_privilege('service_role', 'public.subtitle_cues_id_seq', 'usage'), 'service_role can use subtitle_cues identity sequence');
select ok(has_sequence_privilege('service_role', 'public.subtitle_chunks_id_seq', 'usage'), 'service_role can use subtitle_chunks identity sequence');
select ok(not has_sequence_privilege('anon', 'public.movies_id_seq', 'usage'), 'anon cannot use movies identity sequence');
select ok(not has_sequence_privilege('anon', 'public.movies_id_seq', 'select'), 'anon cannot select movies identity sequence');
select ok(not has_sequence_privilege('anon', 'public.movies_id_seq', 'update'), 'anon cannot update movies identity sequence');
select ok(not has_sequence_privilege('anon', 'public.subtitle_tracks_id_seq', 'usage'), 'anon cannot use subtitle_tracks identity sequence');
select ok(not has_sequence_privilege('anon', 'public.subtitle_tracks_id_seq', 'select'), 'anon cannot select subtitle_tracks identity sequence');
select ok(not has_sequence_privilege('anon', 'public.subtitle_tracks_id_seq', 'update'), 'anon cannot update subtitle_tracks identity sequence');
select ok(not has_sequence_privilege('anon', 'public.subtitle_cues_id_seq', 'usage'), 'anon cannot use subtitle_cues identity sequence');
select ok(not has_sequence_privilege('anon', 'public.subtitle_cues_id_seq', 'select'), 'anon cannot select subtitle_cues identity sequence');
select ok(not has_sequence_privilege('anon', 'public.subtitle_cues_id_seq', 'update'), 'anon cannot update subtitle_cues identity sequence');
select ok(not has_sequence_privilege('anon', 'public.subtitle_chunks_id_seq', 'usage'), 'anon cannot use subtitle_chunks identity sequence');
select ok(not has_sequence_privilege('anon', 'public.subtitle_chunks_id_seq', 'select'), 'anon cannot select subtitle_chunks identity sequence');
select ok(not has_sequence_privilege('anon', 'public.subtitle_chunks_id_seq', 'update'), 'anon cannot update subtitle_chunks identity sequence');
select ok(not has_sequence_privilege('authenticated', 'public.movies_id_seq', 'usage'), 'authenticated cannot use movies identity sequence');
select ok(not has_sequence_privilege('authenticated', 'public.movies_id_seq', 'select'), 'authenticated cannot select movies identity sequence');
select ok(not has_sequence_privilege('authenticated', 'public.movies_id_seq', 'update'), 'authenticated cannot update movies identity sequence');
select ok(not has_sequence_privilege('authenticated', 'public.subtitle_tracks_id_seq', 'usage'), 'authenticated cannot use subtitle_tracks identity sequence');
select ok(not has_sequence_privilege('authenticated', 'public.subtitle_tracks_id_seq', 'select'), 'authenticated cannot select subtitle_tracks identity sequence');
select ok(not has_sequence_privilege('authenticated', 'public.subtitle_tracks_id_seq', 'update'), 'authenticated cannot update subtitle_tracks identity sequence');
select ok(not has_sequence_privilege('authenticated', 'public.subtitle_cues_id_seq', 'usage'), 'authenticated cannot use subtitle_cues identity sequence');
select ok(not has_sequence_privilege('authenticated', 'public.subtitle_cues_id_seq', 'select'), 'authenticated cannot select subtitle_cues identity sequence');
select ok(not has_sequence_privilege('authenticated', 'public.subtitle_cues_id_seq', 'update'), 'authenticated cannot update subtitle_cues identity sequence');
select ok(not has_sequence_privilege('authenticated', 'public.subtitle_chunks_id_seq', 'usage'), 'authenticated cannot use subtitle_chunks identity sequence');
select ok(not has_sequence_privilege('authenticated', 'public.subtitle_chunks_id_seq', 'select'), 'authenticated cannot select subtitle_chunks identity sequence');
select ok(not has_sequence_privilege('authenticated', 'public.subtitle_chunks_id_seq', 'update'), 'authenticated cannot update subtitle_chunks identity sequence');

create temporary table inserted_ids (
  movie_id bigint not null,
  track_id bigint not null
);

with inserted_movie as (
  insert into public.movies (title, release_year, imdb_id)
  values ('Synthetic film', 2026, 'tt0000001')
  returning id
), inserted_track as (
  insert into public.subtitle_tracks (
    movie_id,
    language_code,
    source,
    source_sha256,
    rights_status,
    status
  )
  select id, 'en', 'synthetic', 'test-sha256', 'personal_research', 'processing'
  from inserted_movie
  returning id, movie_id
)
insert into inserted_ids (movie_id, track_id)
select movie_id, id
from inserted_track;

insert into public.subtitle_cues (track_id, cue_index, start_ms, end_ms, text)
select track_id, 0, 0, 1000, ''
from inserted_ids
on conflict (track_id, cue_index) do update
set start_ms = excluded.start_ms,
    end_ms = excluded.end_ms,
    text = excluded.text;
insert into public.subtitle_cues (track_id, cue_index, start_ms, end_ms, text)
select track_id, 0, 0, 1000, ''
from inserted_ids
on conflict (track_id, cue_index) do update
set start_ms = excluded.start_ms,
    end_ms = excluded.end_ms,
    text = excluded.text;
select is(
  (select count(*) from public.subtitle_cues where track_id = (select track_id from inserted_ids)),
  1::bigint,
  'retrying a cue upsert leaves one cue'
);
select is(
  (select text from public.subtitle_cues where track_id = (select track_id from inserted_ids) and cue_index = 0),
  '',
  'empty cue text is preserved'
);

insert into public.subtitle_chunks (
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
  0,
  0,
  1000,
  '',
  0,
  0,
  ('[' || pg_catalog.array_to_string(pg_catalog.array_prepend(1::real, pg_catalog.array_fill(0::real, array[383])), ',') || ']')::extensions.vector
from inserted_ids
on conflict (track_id, chunk_index) do update
set start_ms = excluded.start_ms,
    end_ms = excluded.end_ms,
    text = excluded.text,
    first_cue_index = excluded.first_cue_index,
    last_cue_index = excluded.last_cue_index,
    embedding = excluded.embedding;
insert into public.subtitle_chunks (
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
  0,
  0,
  1000,
  '',
  0,
  0,
  ('[' || pg_catalog.array_to_string(pg_catalog.array_prepend(1::real, pg_catalog.array_fill(0::real, array[383])), ',') || ']')::extensions.vector
from inserted_ids
on conflict (track_id, chunk_index) do update
set start_ms = excluded.start_ms,
    end_ms = excluded.end_ms,
    text = excluded.text,
    first_cue_index = excluded.first_cue_index,
    last_cue_index = excluded.last_cue_index,
    embedding = excluded.embedding;
select is(
  (select count(*) from public.subtitle_chunks where track_id = (select track_id from inserted_ids)),
  1::bigint,
  'retrying a chunk upsert leaves one chunk'
);

update public.subtitle_tracks
set status = 'ready'
where id = (select track_id from inserted_ids);

create temporary table retrieval_ids (
  secondary_movie_id bigint not null,
  ready_track_id bigint not null,
  processing_track_id bigint not null
);

with inserted_movie as (
  insert into public.movies (title, release_year, imdb_id)
  values ('Second synthetic film', 2027, 'tt0000002')
  returning id
), inserted_ready_track as (
  insert into public.subtitle_tracks (
    movie_id,
    language_code,
    source,
    source_sha256,
    rights_status,
    status
  )
  select id, 'en', 'synthetic', 'ready-sha256', 'personal_research', 'ready'
  from inserted_movie
  returning id, movie_id
), inserted_processing_track as (
  insert into public.subtitle_tracks (
    movie_id,
    language_code,
    source,
    source_sha256,
    rights_status,
    status
  )
  select id, 'en', 'synthetic', 'processing-sha256', 'personal_research', 'processing'
  from inserted_movie
  returning id
)
insert into retrieval_ids (secondary_movie_id, ready_track_id, processing_track_id)
select inserted_ready_track.movie_id, inserted_ready_track.id, inserted_processing_track.id
from inserted_ready_track
cross join inserted_processing_track;

insert into public.subtitle_chunks (
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
  retrieval_ids.ready_track_id,
  chunk_index,
  chunk_index * 1000,
  chunk_index * 1000 + 500,
  'ready synthetic chunk ' || chunk_index,
  chunk_index,
  chunk_index,
  ('[' || pg_catalog.array_to_string(pg_catalog.array_prepend(0::real, pg_catalog.array_prepend(1::real, pg_catalog.array_fill(0::real, array[382]))), ',') || ']')::extensions.vector
from retrieval_ids
cross join pg_catalog.generate_series(0, 50) as generated(chunk_index);

insert into public.subtitle_chunks (
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
  processing_track_id,
  0,
  0,
  500,
  'processing synthetic chunk',
  0,
  0,
  ('[' || pg_catalog.array_to_string(pg_catalog.array_prepend(0::real, pg_catalog.array_prepend(0::real, pg_catalog.array_prepend(1::real, pg_catalog.array_fill(0::real, array[381])))), ',') || ']')::extensions.vector
from retrieval_ids;

create temporary table query_vectors (
  embedding extensions.vector(384) not null
);
insert into query_vectors (embedding)
values (('[' || pg_catalog.array_to_string(pg_catalog.array_prepend(1::real, pg_catalog.array_fill(0::real, array[383])), ',') || ']')::extensions.vector);

select is(
  (select track_id from public.match_subtitle_chunks((select embedding from query_vectors), 1, null)),
  (select track_id from inserted_ids),
  'nearest embedding ranks first'
);
select ok(
  not exists (
    select 1
    from public.match_subtitle_chunks((select embedding from query_vectors), 100, null)
    where track_id = (select processing_track_id from retrieval_ids)
  ),
  'only ready tracks are returned by match_subtitle_chunks'
);
select is(
  (select count(*) from public.match_subtitle_chunks((select embedding from query_vectors), 100, (select movie_id from inserted_ids))),
  1::bigint,
  'optional movie filter returns only the requested movie'
);
select is(
  (select count(*) from public.match_subtitle_chunks((select embedding from query_vectors), 0, null)),
  1::bigint,
  'match_count is clamped to one result'
);
select is(
  (select count(*) from public.match_subtitle_chunks((select embedding from query_vectors), 100, null)),
  50::bigint,
  'match_count is capped at fifty results'
);

select * from finish();
rollback;
