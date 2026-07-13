begin;

select plan(137);

select has_table('public', 'movies', 'movies table exists');
select has_table('public', 'subtitle_tracks', 'subtitle_tracks table exists');
select has_table('public', 'subtitle_cues', 'subtitle_cues table exists');
select has_table('public', 'subtitle_chunks', 'subtitle_chunks table exists');
select has_table('public', 'subtitle_chunk_claims', 'subtitle_chunk_claims table exists');

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
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint as constraint
    where constraint.conrelid = 'public.subtitle_chunk_claims'::pg_catalog.regclass
      and constraint.contype = 'f'
      and constraint.confrelid = 'public.subtitle_tracks'::pg_catalog.regclass
  ),
  'subtitle_chunk_claims references subtitle_tracks'
);

select ok(pg_catalog.to_regclass('public.subtitle_tracks_movie_id_idx') is not null, 'subtitle_tracks movie foreign key is indexed');
select ok(pg_catalog.to_regclass('public.subtitle_cues_track_id_idx') is not null, 'subtitle_cues track foreign key is indexed');
select ok(pg_catalog.to_regclass('public.subtitle_chunks_track_id_idx') is not null, 'subtitle_chunks track foreign key is indexed');
select ok(pg_catalog.to_regclass('public.subtitle_chunk_claims_track_id_idx') is not null, 'subtitle_chunk_claims track foreign key is indexed');
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
select ok(class.relrowsecurity, 'subtitle_chunk_claims has RLS enabled')
from pg_catalog.pg_class as class
where class.oid = 'public.subtitle_chunk_claims'::pg_catalog.regclass;

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
select ok(class.relforcerowsecurity, 'subtitle_chunk_claims forces RLS')
from pg_catalog.pg_class as class
where class.oid = 'public.subtitle_chunk_claims'::pg_catalog.regclass;

select ok(not exists (select 1 from pg_catalog.pg_policy where polrelid = 'public.movies'::pg_catalog.regclass), 'movies has no policies');
select ok(not exists (select 1 from pg_catalog.pg_policy where polrelid = 'public.subtitle_tracks'::pg_catalog.regclass), 'subtitle_tracks has no policies');
select ok(not exists (select 1 from pg_catalog.pg_policy where polrelid = 'public.subtitle_cues'::pg_catalog.regclass), 'subtitle_cues has no policies');
select ok(not exists (select 1 from pg_catalog.pg_policy where polrelid = 'public.subtitle_chunks'::pg_catalog.regclass), 'subtitle_chunks has no policies');
select ok(not exists (select 1 from pg_catalog.pg_policy where polrelid = 'public.subtitle_chunk_claims'::pg_catalog.regclass), 'subtitle_chunk_claims has no policies');

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
select ok(not has_table_privilege('anon', 'public.subtitle_chunk_claims', 'select'), 'anon cannot select subtitle_chunk_claims');
select ok(not has_table_privilege('anon', 'public.subtitle_chunk_claims', 'insert'), 'anon cannot insert subtitle_chunk_claims');
select ok(not has_table_privilege('anon', 'public.subtitle_chunk_claims', 'update'), 'anon cannot update subtitle_chunk_claims');
select ok(not has_table_privilege('anon', 'public.subtitle_chunk_claims', 'delete'), 'anon cannot delete subtitle_chunk_claims');
select ok(not has_table_privilege('authenticated', 'public.subtitle_chunk_claims', 'select'), 'authenticated cannot select subtitle_chunk_claims');
select ok(not has_table_privilege('authenticated', 'public.subtitle_chunk_claims', 'insert'), 'authenticated cannot insert subtitle_chunk_claims');
select ok(not has_table_privilege('authenticated', 'public.subtitle_chunk_claims', 'update'), 'authenticated cannot update subtitle_chunk_claims');
select ok(not has_table_privilege('authenticated', 'public.subtitle_chunk_claims', 'delete'), 'authenticated cannot delete subtitle_chunk_claims');

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
  has_table_privilege('service_role', 'public.subtitle_chunk_claims', 'select')
  and has_table_privilege('service_role', 'public.subtitle_chunk_claims', 'insert')
  and has_table_privilege('service_role', 'public.subtitle_chunk_claims', 'update')
  and has_table_privilege('service_role', 'public.subtitle_chunk_claims', 'delete'),
  'service_role has subtitle chunk claim table privileges'
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

select ok(
  not has_function_privilege('anon', 'public.reserve_subtitle_chunk_claims(bigint,uuid,jsonb,jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.reserve_subtitle_chunk_claims(bigint,uuid,jsonb,jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.reserve_subtitle_chunk_claims(bigint,uuid,jsonb,jsonb)', 'execute'),
  'reserve claim RPC is service-role only'
);
select ok(
  not has_function_privilege('anon', 'public.complete_subtitle_chunk_claims(bigint,uuid,jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.complete_subtitle_chunk_claims(bigint,uuid,jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.complete_subtitle_chunk_claims(bigint,uuid,jsonb)', 'execute'),
  'complete claim RPC is service-role only'
);
select ok(
  not has_function_privilege('anon', 'public.release_subtitle_chunk_claims(bigint,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.release_subtitle_chunk_claims(bigint,uuid)', 'execute')
  and has_function_privilege('service_role', 'public.release_subtitle_chunk_claims(bigint,uuid)', 'execute'),
  'release claim RPC is service-role only'
);
select ok(
  not has_function_privilege('anon', 'public.fail_subtitle_track(bigint)', 'execute')
  and not has_function_privilege('authenticated', 'public.fail_subtitle_track(bigint)', 'execute')
  and has_function_privilege('service_role', 'public.fail_subtitle_track(bigint)', 'execute'),
  'fail track RPC is service-role only'
);
select ok(
  not has_function_privilege('anon', 'public.reopen_subtitle_track(bigint)', 'execute')
  and not has_function_privilege('authenticated', 'public.reopen_subtitle_track(bigint)', 'execute')
  and has_function_privilege('service_role', 'public.reopen_subtitle_track(bigint)', 'execute'),
  'reopen track RPC is service-role only'
);
select ok(
  not has_function_privilege('anon', 'public.finalize_subtitle_track(bigint)', 'execute')
  and not has_function_privilege('authenticated', 'public.finalize_subtitle_track(bigint)', 'execute')
  and has_function_privilege('service_role', 'public.finalize_subtitle_track(bigint)', 'execute'),
  'finalize track RPC is service-role only'
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

create function pg_temp.raises_sqlstate(p_statement text, p_expected_sqlstate text)
returns boolean
language plpgsql
as $$
begin
  execute p_statement;
  return false;
exception when others then
  return sqlstate = p_expected_sqlstate;
end;
$$;

create temporary table claim_test_ids (
  track_id bigint not null
);

with inserted_movie as (
  insert into public.movies (title, release_year, imdb_id)
  values ('Claim behavior fixture', 2028, 'tt0000003')
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
  select id, 'en', 'synthetic', 'claim-behavior-sha256', 'personal_research', 'processing'
  from inserted_movie
  returning id
)
insert into claim_test_ids (track_id)
select id
from inserted_track;

create temporary table claim_test_vectors (
  embedding jsonb not null
);
insert into claim_test_vectors (embedding)
select pg_catalog.jsonb_agg(case when generated.value = 0 then 1 else 0 end order by generated.value)
from pg_catalog.generate_series(0, 383) as generated(value);

select is(
  (
    select count(*)
    from public.reserve_subtitle_chunk_claims(
      (select track_id from claim_test_ids),
      '00000000-0000-0000-0000-000000000001'::uuid,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'cue_index', 0,
        'start_ms', 0,
        'end_ms', 1000,
        'text', ''
      )),
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('chunk_index', 0))
    )
  ),
  1::bigint,
  'initial claim reservation accepts an uncompleted chunk'
);
select is(
  (
    select count(*)
    from public.reserve_subtitle_chunk_claims(
      (select track_id from claim_test_ids),
      '00000000-0000-0000-0000-000000000002'::uuid,
      '[]'::jsonb,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('chunk_index', 0))
    )
  ),
  0::bigint,
  'active claims remain protected'
);

update public.subtitle_chunk_claims
set claimed_at = pg_catalog.statement_timestamp() - interval '11 minutes'
where track_id = (select track_id from claim_test_ids)
  and chunk_index = 0;
select is(
  (
    select count(*)
    from public.reserve_subtitle_chunk_claims(
      (select track_id from claim_test_ids),
      '00000000-0000-0000-0000-000000000002'::uuid,
      '[]'::jsonb,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('chunk_index', 0))
    )
  ),
  1::bigint,
  'stale claims can be taken over'
);
select ok(
  (
    select accepted_chunk_count
    from public.complete_subtitle_chunk_claims(
      (select track_id from claim_test_ids),
      '00000000-0000-0000-0000-000000000001'::uuid,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'chunk_index', 0,
        'start_ms', 0,
        'end_ms', 1000,
        'text', '',
        'first_cue_index', 0,
        'last_cue_index', 0,
        'embedding', (select embedding from claim_test_vectors)
      ))
    )
  ) = 0
  and public.release_subtitle_chunk_claims(
    (select track_id from claim_test_ids),
    '00000000-0000-0000-0000-000000000001'::uuid
  ) = 0
  and not exists (
    select 1
    from public.subtitle_chunks
    where track_id = (select track_id from claim_test_ids)
  )
  and (
    select claim_token
    from public.subtitle_chunk_claims
    where track_id = (select track_id from claim_test_ids)
      and chunk_index = 0
  ) = '00000000-0000-0000-0000-000000000002'::uuid,
  'wrong-token completion and release preserve the active claim'
);
select ok(
  (
    select accepted_chunk_count
    from public.complete_subtitle_chunk_claims(
      (select track_id from claim_test_ids),
      '00000000-0000-0000-0000-000000000002'::uuid,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'chunk_index', 0,
        'start_ms', 0,
        'end_ms', 1000,
        'text', '',
        'first_cue_index', 0,
        'last_cue_index', 0,
        'embedding', (select embedding from claim_test_vectors)
      ))
    )
  ) = 1
  and not exists (
    select 1
    from public.subtitle_chunk_claims
    where track_id = (select track_id from claim_test_ids)
  ),
  'matching completion accepts and releases the claim'
);
select is(
  (
    select count(*)
    from public.reserve_subtitle_chunk_claims(
      (select track_id from claim_test_ids),
      '00000000-0000-0000-0000-000000000003'::uuid,
      '[]'::jsonb,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('chunk_index', 0))
    )
  ),
  0::bigint,
  'completed chunks cannot be re-claimed'
);

insert into public.subtitle_chunk_claims (track_id, chunk_index, claim_token)
select track_id, 0, '00000000-0000-0000-0000-000000000003'::uuid
from claim_test_ids;
select ok(
  (
    select accepted_chunk_count
    from public.complete_subtitle_chunk_claims(
      (select track_id from claim_test_ids),
      '00000000-0000-0000-0000-000000000003'::uuid,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'chunk_index', 0,
        'start_ms', 0,
        'end_ms', 1000,
        'text', 'attempted overwrite',
        'first_cue_index', 0,
        'last_cue_index', 0,
        'embedding', (select embedding from claim_test_vectors)
      ))
    )
  ) = 0
  and (
    select text
    from public.subtitle_chunks
    where track_id = (select track_id from claim_test_ids)
      and chunk_index = 0
  ) = '',
  'completed chunks are not overwritten'
);

insert into public.subtitle_chunk_claims (track_id, chunk_index, claim_token)
select track_id, 1, '00000000-0000-0000-0000-000000000004'::uuid
from claim_test_ids;
select ok(
  pg_temp.raises_sqlstate(
    pg_catalog.format('select public.finalize_subtitle_track(%s)', (select track_id from claim_test_ids)),
    'P0003'
  ),
  'finalize rejects pending claims'
);
do $$
begin
  perform public.release_subtitle_chunk_claims(
    (select track_id from claim_test_ids),
    '00000000-0000-0000-0000-000000000004'::uuid
  );
end;
$$;

update public.subtitle_chunks
set end_ms = 999
where track_id = (select track_id from claim_test_ids)
  and chunk_index = 0;
select ok(
  pg_temp.raises_sqlstate(
    pg_catalog.format('select public.finalize_subtitle_track(%s)', (select track_id from claim_test_ids)),
    'P0004'
  ),
  'finalize rejects timestamp mismatches'
);
update public.subtitle_chunks
set end_ms = 1000
where track_id = (select track_id from claim_test_ids)
  and chunk_index = 0;

update public.subtitle_chunks
set text = 'wrong text'
where track_id = (select track_id from claim_test_ids)
  and chunk_index = 0;
select ok(
  pg_temp.raises_sqlstate(
    pg_catalog.format('select public.finalize_subtitle_track(%s)', (select track_id from claim_test_ids)),
    'P0004'
  ),
  'finalize rejects text mismatches'
);
update public.subtitle_chunks
set text = ''
where track_id = (select track_id from claim_test_ids)
  and chunk_index = 0;

do $$
begin
  perform public.finalize_subtitle_track((select track_id from claim_test_ids));
end;
$$;
select is(
  (select status from public.subtitle_tracks where id = (select track_id from claim_test_ids)),
  'ready',
  'valid empty-cue ranges finalize the track'
);

update public.subtitle_tracks
set status = 'processing'
where id = (select track_id from claim_test_ids);
do $$
begin
  perform public.fail_subtitle_track((select track_id from claim_test_ids));
end;
$$;
select is(
  (select status from public.subtitle_tracks where id = (select track_id from claim_test_ids)),
  'failed',
  'fail track RPC records failure'
);
do $$
begin
  perform public.reopen_subtitle_track((select track_id from claim_test_ids));
end;
$$;
select is(
  (select status from public.subtitle_tracks where id = (select track_id from claim_test_ids)),
  'processing',
  'failed tracks reopen for processing'
);

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

select is(
  (
    select chunk_index
    from public.match_subtitle_chunks(
      (
        select chunk.embedding
        from public.subtitle_chunks as chunk
        join public.subtitle_tracks as track on track.id = chunk.track_id
        join public.movies as movie on movie.id = track.movie_id
        where movie.imdb_id = 'seed-search-fixture' and chunk.chunk_index = 0
      ),
      2,
      (select id from public.movies where imdb_id = 'seed-search-fixture')
    )
    limit 1
  ),
  0,
  'seed first vector ranks the first synthetic chunk first'
);
select is(
  (
    select pg_catalog.array_agg(cue.cue_index order by cue.cue_index)
    from public.match_subtitle_chunks(
      (
        select chunk.embedding
        from public.subtitle_chunks as chunk
        join public.subtitle_tracks as track on track.id = chunk.track_id
        join public.movies as movie on movie.id = track.movie_id
        where movie.imdb_id = 'seed-search-fixture' and chunk.chunk_index = 0
      ),
      1,
      (select id from public.movies where imdb_id = 'seed-search-fixture')
    ) as matched
    join public.subtitle_cues as cue
      on cue.track_id = matched.track_id
      and cue.cue_index between matched.first_cue_index and matched.last_cue_index
  ),
  array[0, 1]::integer[],
  'seed first chunk includes its exact inclusive cue range'
);

select * from finish();
rollback;
