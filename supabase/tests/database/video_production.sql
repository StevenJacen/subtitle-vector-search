begin;
select plan(36);

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
  not has_table_privilege('anon', 'public.video_render_jobs', 'select')
  and not has_table_privilege('authenticated', 'public.video_render_jobs', 'select')
  and not has_table_privilege('anon', 'public.video_asset_downloads', 'insert')
  and not has_table_privilege('authenticated', 'public.video_asset_downloads', 'insert')
  and not has_table_privilege('anon', 'public.video_render_segments', 'update')
  and not has_table_privilege('authenticated', 'public.video_render_segments', 'update'),
  'browser roles cannot access production tables'
);
select ok(
  not has_sequence_privilege('anon', 'public.video_asset_downloads_id_seq', 'usage')
  and not has_sequence_privilege('authenticated', 'public.video_asset_downloads_id_seq', 'usage')
  and not has_sequence_privilege('anon', 'public.video_render_segments_id_seq', 'usage')
  and not has_sequence_privilege('authenticated', 'public.video_render_segments_id_seq', 'usage'),
  'browser roles cannot access production sequences'
);
select ok(
  has_table_privilege('service_role', 'public.video_render_jobs', 'select')
  and has_table_privilege('service_role', 'public.video_asset_downloads', 'insert')
  and has_table_privilege('service_role', 'public.video_render_segments', 'delete')
  and has_sequence_privilege('service_role', 'public.video_asset_downloads_id_seq', 'usage')
  and has_sequence_privilege('service_role', 'public.video_render_segments_id_seq', 'usage'),
  'service role has the required private data access'
);
select ok(
  not has_function_privilege('anon', 'public.start_video_render(text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.start_video_render(text,text)', 'execute')
  and not has_function_privilege('anon', 'public.record_video_asset_download(uuid,bigint,text,text,bigint,text,integer,integer,integer,double precision,text,text,boolean,text,integer,integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.complete_video_render(uuid,jsonb,jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.select_video_asset(uuid,bigint,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.select_video_asset(uuid,bigint,text)', 'execute'),
  'browser roles cannot execute production RPCs'
);
select ok(
  has_function_privilege('service_role', 'public.start_video_render(text,text)', 'execute')
  and has_function_privilege('service_role', 'public.record_video_asset_download(uuid,bigint,text,text,bigint,text,integer,integer,integer,double precision,text,text,boolean,text,integer,integer)', 'execute')
  and has_function_privilege('service_role', 'public.begin_video_render(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.complete_video_render(uuid,jsonb,jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.fail_video_render(uuid,text,text)', 'execute')
  and has_function_privilege('service_role', 'public.retry_video_render(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.select_video_asset(uuid,bigint,text)', 'execute'),
  'service role executes production RPCs'
);
select ok(
  exists (select 1 from pg_catalog.pg_indexes where schemaname = 'public' and indexname = 'video_asset_downloads_render_id_idx')
  and exists (select 1 from pg_catalog.pg_indexes where schemaname = 'public' and indexname = 'video_asset_downloads_candidate_id_idx')
  and exists (select 1 from pg_catalog.pg_indexes where schemaname = 'public' and indexname = 'video_render_segments_render_id_idx')
  and exists (select 1 from pg_catalog.pg_indexes where schemaname = 'public' and indexname = 'video_render_segments_download_id_idx')
  and exists (select 1 from pg_catalog.pg_indexes where schemaname = 'public' and indexname = 'video_render_segments_quote_source_idx'),
  'foreign key and quote source indexes exist'
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

-- 25: four verified downloads move the render to rendering
select is(
  (select status from public.begin_video_render((select render_id from task1_ids where label = 'render-complete'))),
  'rendering',
  'begin render accepts exactly four verified downloads'
);

-- 26-27: changed quote text fails before any partial completion data persists
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

-- 28-31: valid completion persists four segments, is idempotent, and is terminal
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

-- 32-33: failed renders retry only through the controlled transition
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

-- 34-36: constraints preserve provenance and terminal consistency
select throws_ok(
  $$insert into public.video_render_segments(render_id, segment_index, download_id, timeline_start_ms, timeline_end_ms, source_in_ms, source_out_ms, caption_kind, caption_en, caption_zh, source_track_id, source_cue_index)
    values ((select render_id from task1_ids where label = 'render-incomplete'), 0, (select download_id from task1_ids where label = 'download-incomplete'), 0, 10, 0, 10, 'original', 'Original.', 'Original.', (select track_id from task1_ids where label = 'quote-source'), (select cue_index from task1_ids where label = 'quote-source'))$$,
  '23514', null, 'original segments cannot retain quote source columns'
);
select throws_ok(
  $$update public.video_asset_selections set candidate_id = (select candidate_id from task1_ids where label = 'selection-render-0-alternate') where id = (select selection_id from task1_ids where label = 'selection-incomplete')$$,
  '23503', null, 'downloaded selection candidate is frozen by the foreign key'
);
select ok(
  (select status = 'planned' and failure_code is null and failure_message is null from public.video_render_jobs where id = (select render_id from task1_ids where label = 'render-failed')),
  'retry leaves no stale failure fields'
);

select * from finish();
rollback;
