begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(39);

-- 1-3: private production tables exist
select has_table('public', 'video_render_jobs', 'render jobs table exists');
select has_table('public', 'video_asset_downloads', 'asset downloads table exists');
select has_table('public', 'video_render_segments', 'render segments table exists');

-- 4-10: production and hardened selection RPCs exist
select has_function('public', 'start_video_render', array['text', 'text'], 'start render RPC exists');
select has_function('public', 'record_video_asset_download', array['uuid', 'bigint', 'text', 'text', 'bigint', 'text', 'integer', 'integer', 'integer', 'double precision', 'text', 'text', 'boolean', 'text', 'integer', 'integer'], 'record download RPC exists');
select has_function('public', 'begin_video_render', array['uuid'], 'begin render RPC exists');
select has_function('public', 'complete_video_render', array['uuid', 'jsonb', 'jsonb'], 'complete render RPC exists');
select has_function('public', 'fail_video_render', array['uuid', 'text', 'text'], 'fail render RPC exists');
select has_function('public', 'retry_video_render', array['uuid'], 'retry render RPC exists');
select has_function('public', 'select_video_asset', array['uuid', 'bigint', 'text'], 'hardened selection RPC exists');

-- 11-18: RLS, policy, grants, and FK index coverage remain private
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class where oid = 'public.video_render_jobs'::pg_catalog.regclass)
  and (select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class where oid = 'public.video_asset_downloads'::pg_catalog.regclass)
  and (select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class where oid = 'public.video_render_segments'::pg_catalog.regclass),
  'production tables force row level security'
);
select ok(
  not exists (
    select 1 from pg_catalog.pg_policy
    where polrelid in (
      'public.video_render_jobs'::pg_catalog.regclass,
      'public.video_asset_downloads'::pg_catalog.regclass,
      'public.video_render_segments'::pg_catalog.regclass
    )
  ),
  'production tables have no browser policies'
);
select ok(
  not exists (
    with client_roles(role_name) as (
      values ('public'::name), ('anon'::name), ('authenticated'::name)
    ), private_tables(table_name) as (
      values
        ('public.video_render_jobs'::text),
        ('public.video_asset_downloads'::text),
        ('public.video_render_segments'::text)
    ), table_privileges(privilege_name) as (
      select pg_catalog.unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']::text[])
    )
    select 1
    from client_roles as client_role
    cross join private_tables as private_table
    cross join table_privileges as table_privilege
    where has_table_privilege(client_role.role_name, private_table.table_name, table_privilege.privilege_name)
  ),
  'browser roles cannot access production tables'
);
select ok(
  not exists (
    with client_roles(role_name) as (
      values ('public'::name), ('anon'::name), ('authenticated'::name)
    ), private_sequences(sequence_name) as (
      values
        ('public.video_asset_downloads_id_seq'::text),
        ('public.video_render_segments_id_seq'::text)
    ), sequence_privileges(privilege_name) as (
      select pg_catalog.unnest(array['usage', 'select', 'update']::text[])
    )
    select 1
    from client_roles as client_role
    cross join private_sequences as private_sequence
    cross join sequence_privileges as sequence_privilege
    where has_sequence_privilege(client_role.role_name, private_sequence.sequence_name, sequence_privilege.privilege_name)
  ),
  'browser roles cannot access production sequences'
);
select ok(
  not exists (
    with expected_tables(table_name, allowed_privileges) as (
      values
        ('public.video_render_jobs'::text, array['select', 'insert', 'update']::text[]),
        ('public.video_asset_downloads'::text, array['select', 'insert']::text[]),
        ('public.video_render_segments'::text, array['select', 'insert']::text[])
    ), table_privileges(privilege_name) as (
      select pg_catalog.unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']::text[])
    ), expected_privileges(table_name, privilege_name, is_granted) as (
      select
        expected_table.table_name,
        table_privilege.privilege_name,
        table_privilege.privilege_name = any(expected_table.allowed_privileges)
      from expected_tables as expected_table
      cross join table_privileges as table_privilege
    )
    select 1
    from expected_privileges as expected_privilege
    where has_table_privilege('service_role', expected_privilege.table_name, expected_privilege.privilege_name)
      is distinct from expected_privilege.is_granted
  )
  and has_sequence_privilege('service_role', 'public.video_asset_downloads_id_seq', 'usage')
  and not has_sequence_privilege('service_role', 'public.video_asset_downloads_id_seq', 'select')
  and not has_sequence_privilege('service_role', 'public.video_asset_downloads_id_seq', 'update')
  and has_sequence_privilege('service_role', 'public.video_render_segments_id_seq', 'usage')
  and not has_sequence_privilege('service_role', 'public.video_render_segments_id_seq', 'select')
  and not has_sequence_privilege('service_role', 'public.video_render_segments_id_seq', 'update'),
  'service role has exactly the required private data access'
);
select ok(
  not exists (
    with client_roles(role_name) as (
      values ('public'::name), ('anon'::name), ('authenticated'::name)
    ), production_rpcs(rpc_name) as (
      values
        ('public.start_video_render(text,text)'::text),
        ('public.record_video_asset_download(uuid,bigint,text,text,bigint,text,integer,integer,integer,double precision,text,text,boolean,text,integer,integer)'::text),
        ('public.begin_video_render(uuid)'::text),
        ('public.complete_video_render(uuid,jsonb,jsonb)'::text),
        ('public.fail_video_render(uuid,text,text)'::text),
        ('public.retry_video_render(uuid)'::text),
        ('public.select_video_asset(uuid,bigint,text)'::text)
    )
    select 1
    from client_roles as client_role
    cross join production_rpcs as production_rpc
    where has_function_privilege(client_role.role_name, production_rpc.rpc_name, 'execute')
  ),
  'browser roles cannot execute production RPCs'
);
select ok(
  not exists (
    with production_rpcs(rpc_name) as (
      values
        ('public.start_video_render(text,text)'::text),
        ('public.record_video_asset_download(uuid,bigint,text,text,bigint,text,integer,integer,integer,double precision,text,text,boolean,text,integer,integer)'::text),
        ('public.begin_video_render(uuid)'::text),
        ('public.complete_video_render(uuid,jsonb,jsonb)'::text),
        ('public.fail_video_render(uuid,text,text)'::text),
        ('public.retry_video_render(uuid)'::text),
        ('public.select_video_asset(uuid,bigint,text)'::text)
    )
    select 1
    from production_rpcs as production_rpc
    where not has_function_privilege('service_role', production_rpc.rpc_name, 'execute')
  ),
  'service role executes production RPCs'
);
select ok(
  (
    with expected_indexes(index_name, table_name, expected_columns, expected_predicate) as (
      values
        ('video_asset_downloads_render_id_idx'::name, 'public.video_asset_downloads'::pg_catalog.regclass, array['render_id']::name[], null::text),
        ('video_asset_downloads_candidate_id_idx'::name, 'public.video_asset_downloads'::pg_catalog.regclass, array['candidate_id']::name[], null::text),
        ('video_render_segments_render_id_idx'::name, 'public.video_render_segments'::pg_catalog.regclass, array['render_id']::name[], null::text),
        ('video_render_segments_download_id_idx'::name, 'public.video_render_segments'::pg_catalog.regclass, array['download_id']::name[], null::text),
        ('video_render_segments_quote_source_idx'::name, 'public.video_render_segments'::pg_catalog.regclass, array['source_track_id', 'source_cue_index']::name[], '(source_track_id is not null)'::text)
    )
    select pg_catalog.count(*) = 5
    from expected_indexes as expected_index
    join pg_catalog.pg_class as index_class on index_class.relname = expected_index.index_name
    join pg_catalog.pg_index as index_info
      on index_info.indexrelid = index_class.oid
      and index_info.indrelid = expected_index.table_name
    join pg_catalog.pg_am as access_method
      on access_method.oid = index_class.relam
      and access_method.amname = 'btree'
    where (
      select pg_catalog.array_agg(attribute.attname order by index_column.ordinality)
      from pg_catalog.unnest(index_info.indkey::smallint[]) with ordinality as index_column(attnum, ordinality)
      join pg_catalog.pg_attribute as attribute
        on attribute.attrelid = index_info.indrelid
        and attribute.attnum = index_column.attnum
      where index_column.ordinality <= index_info.indnkeyatts
    ) = expected_index.expected_columns
      and (
        (expected_index.expected_predicate is null and index_info.indpred is null)
        or pg_catalog.lower(pg_catalog.pg_get_expr(index_info.indpred, index_info.indrelid)) = expected_index.expected_predicate
      )
  ),
  'foreign key and quote source index definitions are exact'
);

create temporary table task1_ids (
  label text primary key,
  render_id uuid,
  selection_id bigint,
  candidate_id bigint,
  track_id bigint,
  cue_index integer,
  download_id bigint
);

with inserted_movie as (
  insert into public.movies(title, release_year)
  values ('Synthetic production fixture', 2001)
  returning id
), inserted_track as (
  insert into public.subtitle_tracks(movie_id, language_code, source, source_sha256, rights_status, status)
  select id, 'en', 'fixture', pg_catalog.repeat('1', 64), 'personal_research', 'ready'
  from inserted_movie
  returning id
), inserted_cue as (
  insert into public.subtitle_cues(track_id, cue_index, start_ms, end_ms, text)
  select id, 4, 1000, 5000, 'Synthetic quote remains exact.'
  from inserted_track
  returning track_id, cue_index
)
insert into task1_ids(label, track_id, cue_index)
select 'quote-source', track_id, cue_index from inserted_cue;

with inserted_runs as (
  insert into public.video_search_runs(input_kind, input_digest, theme, candidate_count, status, planner_model, prompt_version)
  select 'theme', pg_catalog.lpad((700 + ordinal)::text, 64, '0'), 'fixture ' || ordinal, 8, 'completed', 'fixture-model', 'fixture-v1'
  from pg_catalog.generate_series(0, 4) as ordinal
  returning id, input_digest
), inserted_candidates as (
  insert into public.video_search_candidates(
    run_id, provider_resource_id, content_type, file_types, download_sizes,
    fused_score, best_rank, matched_query_kinds
  )
  select id, 1000 + pg_catalog.right(input_digest, 1)::integer, 'video', '[]'::jsonb, '[]'::jsonb, 0.5, 1, array['literal']
  from inserted_runs
  returning id, run_id, provider_resource_id
), inserted_selections as (
  insert into public.video_asset_selections(run_id, candidate_id, note)
  select run_id, id, 'fixture' from inserted_candidates
  returning id, run_id, candidate_id
)
insert into task1_ids(label, selection_id, candidate_id)
select
  case candidate.provider_resource_id
    when 1000 then 'selection-incomplete'
    when 1001 then 'selection-render-0'
    when 1002 then 'selection-render-1'
    when 1003 then 'selection-render-2'
    when 1004 then 'selection-render-3'
  end,
  selection.id,
  selection.candidate_id
from inserted_selections as selection
join inserted_candidates as candidate on candidate.id = selection.candidate_id;

with first_run as (
  select run_id from public.video_asset_selections where id = (select selection_id from task1_ids where label = 'selection-incomplete')
), alternate_candidate as (
  insert into public.video_search_candidates(
    run_id, provider_resource_id, content_type, file_types, download_sizes,
    fused_score, best_rank, matched_query_kinds
  )
  select run_id, 2000, 'video', '[]'::jsonb, '[]'::jsonb, 0.4, 2, array['action']
  from first_run
  returning id
)
insert into task1_ids(label, candidate_id)
select 'selection-render-0-alternate', id from alternate_candidate;

-- 19-20: start is idempotent by request digest
insert into task1_ids(label, render_id)
select 'render-incomplete', render_id
from public.start_video_render(pg_catalog.repeat('a', 64), 'Synthetic incomplete render');
select is(
  (select status from public.video_render_jobs where id = (select render_id from task1_ids where label = 'render-incomplete')),
  'planned',
  'start creates a planned render'
);
select ok(
  (select render_id from public.start_video_render(pg_catalog.repeat('a', 64), 'Synthetic incomplete render')) = (select render_id from task1_ids where label = 'render-incomplete')
  and (select is_existing from public.start_video_render(pg_catalog.repeat('a', 64), 'Synthetic incomplete render')),
  'start returns the existing render by request digest'
);

-- 21-23: downloads are exact-idempotent, conflicting data is rejected, and locks prevent replacement
insert into task1_ids(label, download_id)
select 'download-incomplete', download_id
from public.record_video_asset_download(
  (select render_id from task1_ids where label = 'render-incomplete'),
  (select selection_id from task1_ids where label = 'selection-incomplete'),
  'video-runs/incomplete/assets/scene.mp4', 'mp4', 1000, pg_catalog.repeat('2', 64),
  1920, 1080, 7500, 30, 'h264', 'aac', false, null, null, null
);
select is(
  (select download_id from public.record_video_asset_download(
    (select render_id from task1_ids where label = 'render-incomplete'),
    (select selection_id from task1_ids where label = 'selection-incomplete'),
    'video-runs/incomplete/assets/scene.mp4', 'mp4', 1000, pg_catalog.repeat('2', 64),
    1920, 1080, 7500, 30, 'h264', 'aac', false, null, null, null
  )),
  (select download_id from task1_ids where label = 'download-incomplete'),
  'record download returns the exact existing row'
);
select throws_ok(
  $$select * from public.record_video_asset_download(
    (select render_id from task1_ids where label = 'render-incomplete'),
    (select selection_id from task1_ids where label = 'selection-incomplete'),
    'video-runs/incomplete/assets/scene.mp4', 'mp4', 1000, repeat('3', 64),
    1920, 1080, 7500, 30, 'h264', 'aac', false, null, null, null
  )$$,
  'P0004', null, 'conflicting download metadata is rejected'
);
select throws_ok(
  $$select * from public.select_video_asset(
    (select selection.run_id from public.video_asset_selections as selection where selection.id = (select selection_id from task1_ids where label = 'selection-incomplete')),
    2000,
    'replacement'
  )$$,
  'P0007', 'selection_locked', 'downloaded selections cannot be replaced'
);

-- 24: rendering cannot begin without exactly four verified downloads
select throws_ok(
  $$select * from public.begin_video_render((select render_id from task1_ids where label = 'render-incomplete'))$$,
  'P0005', 'render requires four verified downloads', 'begin render requires four downloads'
);

insert into task1_ids(label, render_id)
select 'render-complete', render_id
from public.start_video_render(pg_catalog.repeat('b', 64), 'Synthetic completed render');

insert into task1_ids(label, download_id)
select 'download-render-0', download_id
from public.record_video_asset_download((select render_id from task1_ids where label = 'render-complete'), (select selection_id from task1_ids where label = 'selection-render-0'), 'video-runs/complete/assets/0.mp4', 'mp4', 1000, pg_catalog.repeat('4', 64), 1920, 1080, 7500, 30, 'h264', 'aac', false, null, null, null);
insert into task1_ids(label, download_id)
select 'download-render-1', download_id
from public.record_video_asset_download((select render_id from task1_ids where label = 'render-complete'), (select selection_id from task1_ids where label = 'selection-render-1'), 'video-runs/complete/assets/1.mp4', 'mp4', 1001, pg_catalog.repeat('5', 64), 1920, 1080, 7500, 30, 'h264', 'aac', false, null, null, null);
insert into task1_ids(label, download_id)
select 'download-render-2', download_id
from public.record_video_asset_download((select render_id from task1_ids where label = 'render-complete'), (select selection_id from task1_ids where label = 'selection-render-2'), 'video-runs/complete/assets/2.mp4', 'mp4', 1002, pg_catalog.repeat('6', 64), 1920, 1080, 7500, 30, 'h264', 'aac', false, null, null, null);
insert into task1_ids(label, download_id)
select 'download-render-3', download_id
from public.record_video_asset_download((select render_id from task1_ids where label = 'render-complete'), (select selection_id from task1_ids where label = 'selection-render-3'), 'video-runs/complete/assets/3.mp4', 'mp4', 1003, pg_catalog.repeat('7', 64), 1920, 1080, 7500, 30, 'h264', 'aac', false, null, null, null);

-- 25-27: caller text is discarded and a failed downloaded render resumes idempotently without new downloads
do $$
begin
  perform public.fail_video_render(
    (select render_id from task1_ids where label = 'render-complete'),
    'render_failure',
    'https://example.invalid/private C:\secret raw-payload prompt'
  );
end;
$$;
select ok(
  (select status = 'failed'
    and failure_code = 'render_failure'
    and failure_message = 'video render failed'
    and pg_catalog.strpos(failure_message, 'https:') = 0
    and pg_catalog.strpos(failure_message, 'C:') = 0
    and pg_catalog.strpos(failure_message, 'prompt') = 0
   from public.video_render_jobs
   where id = (select render_id from task1_ids where label = 'render-complete')),
  'fail persists only the controlled message derived from its allowlisted code'
);
select is(
  (select status from public.retry_video_render((select render_id from task1_ids where label = 'render-complete'))),
  'downloading',
  'retry resumes a render that already owns verified downloads'
);
select is(
  (select status from public.retry_video_render((select render_id from task1_ids where label = 'render-complete'))),
  'downloading',
  'retry replay returns downloading after a committed response is lost'
);

-- 28: four verified downloads move the render to rendering
select is(
  (select status from public.begin_video_render((select render_id from task1_ids where label = 'render-complete'))),
  'rendering',
  'begin render accepts exactly four verified downloads'
);

-- 29-30: changed quote text fails before any partial completion data persists
select throws_ok(
  $$select * from public.complete_video_render(
    (select render_id from task1_ids where label = 'render-complete'),
    jsonb_build_array(
      jsonb_build_object('segment_index', 0, 'download_id', (select download_id from task1_ids where label = 'download-render-0'), 'timeline_start_ms', 0, 'timeline_end_ms', 7500, 'source_in_ms', 0, 'source_out_ms', 7500, 'caption_kind', 'original', 'caption_en', 'First original.', 'caption_zh', 'Original one.', 'source_track_id', null, 'source_cue_index', null),
      jsonb_build_object('segment_index', 1, 'download_id', (select download_id from task1_ids where label = 'download-render-1'), 'timeline_start_ms', 7500, 'timeline_end_ms', 15000, 'source_in_ms', 0, 'source_out_ms', 7500, 'caption_kind', 'original', 'caption_en', 'Second original.', 'caption_zh', 'Original two.', 'source_track_id', null, 'source_cue_index', null),
      jsonb_build_object('segment_index', 2, 'download_id', (select download_id from task1_ids where label = 'download-render-2'), 'timeline_start_ms', 15000, 'timeline_end_ms', 22500, 'source_in_ms', 0, 'source_out_ms', 7500, 'caption_kind', 'quote', 'caption_en', 'Changed fixture quote.', 'caption_zh', 'Quote fixture.', 'source_track_id', (select track_id from task1_ids where label = 'quote-source'), 'source_cue_index', (select cue_index from task1_ids where label = 'quote-source')),
      jsonb_build_object('segment_index', 3, 'download_id', (select download_id from task1_ids where label = 'download-render-3'), 'timeline_start_ms', 22500, 'timeline_end_ms', 30000, 'source_in_ms', 0, 'source_out_ms', 7500, 'caption_kind', 'original', 'caption_en', 'Fourth original.', 'caption_zh', 'Original four.', 'source_track_id', null, 'source_cue_index', null)
    ),
    jsonb_build_object('artifact_key', 'video-runs/complete/final.mp4', 'output_sha256', repeat('8', 64), 'output_size_bytes', 10000, 'output_duration_ms', 30000, 'video_codec', 'h264', 'audio_codec', 'aac', 'pixel_format', 'yuv420p', 'ffmpeg_version', 'fixture', 'manifest_sha256', repeat('9', 64))
  )$$,
  'P0006', 'quote caption does not match source cue', 'changed quote text is rejected'
);
select ok(
  not exists (select 1 from public.video_render_segments where render_id = (select render_id from task1_ids where label = 'render-complete'))
  and (select status from public.video_render_jobs where id = (select render_id from task1_ids where label = 'render-complete')) = 'rendering',
  'quote mismatch leaves completion atomic'
);

-- 30-33: valid completion persists four segments, is idempotent, and is terminal
select is(
  (select status from public.complete_video_render(
    (select render_id from task1_ids where label = 'render-complete'),
    jsonb_build_array(
      jsonb_build_object('segment_index', 0, 'download_id', (select download_id from task1_ids where label = 'download-render-0'), 'timeline_start_ms', 0, 'timeline_end_ms', 7500, 'source_in_ms', 0, 'source_out_ms', 7500, 'caption_kind', 'original', 'caption_en', 'First original.', 'caption_zh', 'Original one.', 'source_track_id', null, 'source_cue_index', null),
      jsonb_build_object('segment_index', 1, 'download_id', (select download_id from task1_ids where label = 'download-render-1'), 'timeline_start_ms', 7500, 'timeline_end_ms', 15000, 'source_in_ms', 0, 'source_out_ms', 7500, 'caption_kind', 'original', 'caption_en', 'Second original.', 'caption_zh', 'Original two.', 'source_track_id', null, 'source_cue_index', null),
      jsonb_build_object('segment_index', 2, 'download_id', (select download_id from task1_ids where label = 'download-render-2'), 'timeline_start_ms', 15000, 'timeline_end_ms', 22500, 'source_in_ms', 0, 'source_out_ms', 7500, 'caption_kind', 'quote', 'caption_en', 'Synthetic quote remains exact.', 'caption_zh', 'Quote fixture.', 'source_track_id', (select track_id from task1_ids where label = 'quote-source'), 'source_cue_index', (select cue_index from task1_ids where label = 'quote-source')),
      jsonb_build_object('segment_index', 3, 'download_id', (select download_id from task1_ids where label = 'download-render-3'), 'timeline_start_ms', 22500, 'timeline_end_ms', 30000, 'source_in_ms', 0, 'source_out_ms', 7500, 'caption_kind', 'original', 'caption_en', 'Fourth original.', 'caption_zh', 'Original four.', 'source_track_id', null, 'source_cue_index', null)
    ),
    jsonb_build_object('artifact_key', 'video-runs/complete/final.mp4', 'output_sha256', repeat('8', 64), 'output_size_bytes', 10000, 'output_duration_ms', 30000, 'video_codec', 'h264', 'audio_codec', 'aac', 'pixel_format', 'yuv420p', 'ffmpeg_version', 'fixture', 'manifest_sha256', repeat('9', 64))
  )),
  'completed',
  'completion persists the final render state'
);
select ok(
  (select count(*) = 4 and count(*) filter (where caption_kind = 'quote') = 1 from public.video_render_segments where render_id = (select render_id from task1_ids where label = 'render-complete')),
  'completion persists four segments with one quote'
);
select is(
  (select status from public.complete_video_render(
    (select render_id from task1_ids where label = 'render-complete'),
    (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('segment_index', segment_index, 'download_id', download_id, 'timeline_start_ms', timeline_start_ms, 'timeline_end_ms', timeline_end_ms, 'source_in_ms', source_in_ms, 'source_out_ms', source_out_ms, 'caption_kind', caption_kind, 'caption_en', caption_en, 'caption_zh', caption_zh, 'source_track_id', source_track_id, 'source_cue_index', source_cue_index) order by segment_index) from public.video_render_segments where render_id = (select render_id from task1_ids where label = 'render-complete')),
    jsonb_build_object('artifact_key', 'video-runs/complete/final.mp4', 'output_sha256', repeat('8', 64), 'output_size_bytes', 10000, 'output_duration_ms', 30000, 'video_codec', 'h264', 'audio_codec', 'aac', 'pixel_format', 'yuv420p', 'ffmpeg_version', 'fixture', 'manifest_sha256', repeat('9', 64))
  )),
  'completed',
  'identical completion is idempotent'
);
select throws_ok(
  $$select * from public.fail_video_render((select render_id from task1_ids where label = 'render-complete'), 'render_failure', 'terminal render')$$,
  'P0003', 'render cannot fail from its current state', 'completed renders are terminal'
);

-- 35-37: failed renders with no downloads retry to planned idempotently
insert into task1_ids(label, render_id)
select 'render-failed', render_id
from public.start_video_render(pg_catalog.repeat('c', 64), 'Synthetic failed render');
select is(
  (select status from public.fail_video_render((select render_id from task1_ids where label = 'render-failed'), 'render_failure', 'sanitized fixture failure')),
  'failed',
  'fail moves a non-terminal render to failed'
);
select is(
  (select status from public.retry_video_render((select render_id from task1_ids where label = 'render-failed'))),
  'planned',
  'retry clears failure data and returns to planned'
);
select is(
  (select status from public.retry_video_render((select render_id from task1_ids where label = 'render-failed'))),
  'planned',
  'retry replay returns planned after a committed response is lost'
);

-- 38: temporary attribution URLs remain forbidden at the database boundary
select throws_ok(
  $$update public.video_asset_downloads
    set requires_attribution = true,
        required_attribution_url = 'https://example.test/license?X-Amz-Signature=private'
    where id = (select download_id from task1_ids where label = 'download-render-0')$$,
  '23514', null, 'signed attribution URLs cannot be persisted'
);

-- 39: source provenance constraints remain enforced
select throws_ok(
  $$insert into public.video_render_segments(render_id, segment_index, download_id, timeline_start_ms, timeline_end_ms, source_in_ms, source_out_ms, caption_kind, caption_en, caption_zh, source_track_id, source_cue_index)
    values ((select render_id from task1_ids where label = 'render-incomplete'), 0, (select download_id from task1_ids where label = 'download-incomplete'), 0, 10, 0, 10, 'original', 'Original.', 'Original.', (select track_id from task1_ids where label = 'quote-source'), (select cue_index from task1_ids where label = 'quote-source'))$$,
  '23514', null, 'original segments cannot retain quote source columns'
);

select * from finish();
rollback;
