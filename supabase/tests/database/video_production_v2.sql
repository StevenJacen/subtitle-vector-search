begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(47);

select ok(
  (select pg_catalog.bool_and(class.relrowsecurity and class.relforcerowsecurity)
   from pg_catalog.pg_class as class
   where class.oid in (
     'public.video_render_jobs'::pg_catalog.regclass,
     'public.video_asset_downloads'::pg_catalog.regclass,
     'public.video_render_segments'::pg_catalog.regclass
   )),
  'v2 production tables keep forced RLS'
);

select ok(
  (select pg_catalog.bool_and(
     not pg_catalog.has_function_privilege('public', procedure.oid, 'execute')
     and not pg_catalog.has_function_privilege('anon', procedure.oid, 'execute')
     and not pg_catalog.has_function_privilege('authenticated', procedure.oid, 'execute')
     and pg_catalog.has_function_privilege('service_role', procedure.oid, 'execute')
     and pg_catalog.has_function_privilege('postgres', procedure.oid, 'execute')
   )
   from pg_catalog.pg_proc as procedure
   join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
   where namespace.nspname = 'public' and procedure.proname in (
     'start_video_render_v2', 'record_video_asset_download_v2', 'begin_video_render_v2',
     'complete_video_render_v2', 'fail_video_render_v2', 'retry_video_render_v2'
   )),
  'only service roles can execute all six v2 RPCs'
);

create temporary table v2_tracks (
  label text primary key,
  track_id bigint not null,
  scene_count integer not null,
  cue_duration_ms integer not null
);

with movies as (
  insert into public.movies(title, release_year)
  values ('V2 landscape fixture', 2001), ('V2 portrait fixture', 2002), ('V1 compatibility fixture', 2003)
  returning id, title
), tracks as (
  insert into public.subtitle_tracks(movie_id, language_code, source, source_sha256, rights_status, status)
  select id, 'en', 'fixture', pg_catalog.md5(title) || pg_catalog.md5(title || '-track'), 'personal_research', 'ready'
  from movies
  returning id, movie_id
)
insert into v2_tracks(label, track_id, scene_count, cue_duration_ms)
select
  case movie.title
    when 'V2 landscape fixture' then 'landscape'
    when 'V2 portrait fixture' then 'portrait'
    else 'v1'
  end,
  track.id,
  case when movie.title = 'V2 portrait fixture' then 10 when movie.title = 'V2 landscape fixture' then 5 else 1 end,
  case when movie.title = 'V2 portrait fixture' then 1500 when movie.title = 'V2 landscape fixture' then 3000 else 3000 end
from tracks as track
join movies as movie on movie.id = track.movie_id;

insert into public.subtitle_cues(track_id, cue_index, start_ms, end_ms, text)
select track.track_id, 20 + cue.ordinality - 1,
       (cue.ordinality - 1) * track.cue_duration_ms,
       cue.ordinality * track.cue_duration_ms,
       track.label || ' exact cue ' || (cue.ordinality - 1)
from v2_tracks as track
cross join lateral pg_catalog.generate_series(1, track.scene_count) as cue(ordinality);

select throws_ok(
  $$select * from public.start_video_render_v2(repeat('1', 64), 'bad four', '16:9', 1920, 1080, 4, (select track_id from v2_tracks where label = 'landscape'), 20, 23, 15000)$$,
  'P0005', null, 'v2 rejects four scenes'
);
select throws_ok(
  $$select * from public.start_video_render_v2(repeat('2', 64), 'bad eleven', '9:16', 1080, 1920, 11, (select track_id from v2_tracks where label = 'portrait'), 20, 30, 15000)$$,
  'P0005', null, 'v2 rejects eleven scenes'
);
select throws_ok(
  $$select * from public.start_video_render_v2(repeat('3', 64), 'bad dimensions', '16:9', 1080, 1920, 5, (select track_id from v2_tracks where label = 'landscape'), 20, 24, 15000)$$,
  'P0005', null, 'v2 rejects dimensions that do not match the aspect ratio'
);
select throws_ok(
  $$select * from public.start_video_render_v2(repeat('4', 64), 'bad range', '16:9', 1920, 1080, 5, (select track_id from v2_tracks where label = 'landscape'), 20, 25, 15000)$$,
  'P0005', null, 'v2 rejects a nonconsecutive source range'
);
select throws_ok(
  $$select * from public.start_video_render_v2(repeat('5', 64), 'bad duration', '16:9', 1920, 1080, 5, (select track_id from v2_tracks where label = 'landscape'), 20, 24, 15001)$$,
  'P0005', null, 'v2 rejects an expected duration that differs from the cues'
);
select throws_ok(
  $$select * from public.start_video_render_v2(repeat('e', 64), 'null aspect', null, 1920, 1080, 5, (select track_id from v2_tracks where label = 'landscape'), 20, 24, 15000)$$,
  'P0005', null, 'v2 rejects a null aspect ratio'
);
select throws_ok(
  $$select * from public.start_video_render_v2(repeat('f', 64), 'null width', '16:9', null, 1080, 5, (select track_id from v2_tracks where label = 'landscape'), 20, 24, 15000)$$,
  'P0005', null, 'v2 rejects a null width'
);
select throws_ok(
  $$select * from public.start_video_render_v2(repeat('7', 64), 'null height', '16:9', 1920, null, 5, (select track_id from v2_tracks where label = 'landscape'), 20, 24, 15000)$$,
  'P0005', null, 'v2 rejects a null height'
);
select throws_ok(
  $$select * from public.start_video_render_v2(repeat('8', 64), 'null scene count', '16:9', 1920, 1080, null, (select track_id from v2_tracks where label = 'landscape'), 20, 24, 15000)$$,
  'P0005', null, 'v2 rejects a null scene count'
);
select throws_ok(
  $$select * from public.start_video_render_v2(repeat('9', 64), 'null duration', '16:9', 1920, 1080, 5, (select track_id from v2_tracks where label = 'landscape'), 20, 24, null)$$,
  'P0005', null, 'v2 rejects a null expected duration'
);
select throws_ok(
  $$insert into public.video_render_jobs(
      request_digest, theme, status, target_width, target_height, target_fps, target_duration_ms,
      workflow_version, aspect_ratio, scene_count, source_track_id, source_start_cue_index,
      source_end_cue_index, expected_duration_ms
    ) values (
      repeat('0', 64), 'direct null v2 row', 'planned', 1920, 1080, 30, 15000,
      2, null, 5, (select track_id from v2_tracks where label = 'landscape'), 20, 24, 15000
    )$$,
  '23514', null, 'v2 job checks reject null required metadata under direct service access'
);

create temporary table v2_renders (label text primary key, task_id uuid not null, render_id uuid not null);
insert into v2_renders(label, task_id, render_id)
select 'landscape', '8a291fbb-a9e1-42c2-a8d9-fc0817508b7f'::uuid, render_id from public.start_video_render_v2(
  repeat('a', 64), 'five-scene landscape', '16:9', 1920, 1080, 5,
  (select track_id from v2_tracks where label = 'landscape'), 20, 24, 15000
);
insert into v2_renders(label, task_id, render_id)
select 'portrait', 'c9baac54-46d2-4c56-843d-d95a638edec0'::uuid, render_id from public.start_video_render_v2(
  repeat('b', 64), 'ten-scene portrait', '9:16', 1080, 1920, 10,
  (select track_id from v2_tracks where label = 'portrait'), 20, 29, 15000
);
insert into v2_renders(label, task_id, render_id)
select 'empty', '5231c651-7c9e-4843-af67-b99e523c25da'::uuid, render_id from public.start_video_render_v2(
  repeat('c', 64), 'empty fixture', '16:9', 1920, 1080, 5,
  (select track_id from v2_tracks where label = 'landscape'), 20, 24, 15000
);
insert into v2_renders(label, task_id, render_id)
select 'reject', '5bd955a9-b330-4016-bb6d-dbfcb86ffcad'::uuid, render_id from public.start_video_render_v2(
  repeat('d', 64), 'rejection fixture', '16:9', 1920, 1080, 5,
  (select track_id from v2_tracks where label = 'landscape'), 20, 24, 15000
);

select is((select status from public.video_render_jobs where id = (select render_id from v2_renders where label = 'landscape')), 'planned', 'five-scene landscape starts');
select is((select status from public.video_render_jobs where id = (select render_id from v2_renders where label = 'portrait')), 'planned', 'ten-scene portrait starts');
select throws_ok(
  $$select * from public.begin_video_render_v2((select render_id from v2_renders where label = 'empty'))$$,
  'P0003', null, 'begin rejects a render without downloads'
);

create temporary table fixture_scenes (
  workflow text not null,
  scene_index integer not null,
  selection_id bigint,
  download_id bigint,
  primary key (workflow, scene_index)
);

with requested as (
  select workflow, scene_index, row_number() over (order by workflow, scene_index) as ordinal
  from (
    select 'landscape'::text as workflow, generate_series(0, 4) as scene_index
    union all select 'portrait', generate_series(0, 9)
    union all select 'reject', generate_series(0, 4)
    union all select 'v1', generate_series(0, 3)
  ) as scenes
), runs as (
  insert into public.video_search_runs(input_kind, input_digest, theme, candidate_count, status, planner_model, prompt_version)
  select 'theme', pg_catalog.md5(workflow || scene_index) || pg_catalog.md5('v2-' || workflow || scene_index),
         workflow || ' scene ' || scene_index, 8, 'completed', 'fixture-model', 'fixture-v2'
  from requested
  returning id, theme
), candidates as (
  insert into public.video_search_candidates(
    run_id, provider_resource_id, content_type, file_types, download_sizes,
    fused_score, best_rank, matched_query_kinds
  )
  select run.id, 10000 + row_number() over (order by run.theme), 'video', '[]'::jsonb, '[]'::jsonb, 0.9, 1, array['literal']
  from runs as run
  returning id, run_id
), selections as (
  insert into public.video_asset_selections(run_id, candidate_id, note)
  select candidate.run_id, candidate.id, run.theme
  from candidates as candidate
  join runs as run on run.id = candidate.run_id
  returning id, note
)
insert into fixture_scenes(workflow, scene_index, selection_id)
select pg_catalog.split_part(note, ' ', 1), pg_catalog.split_part(note, ' ', 3)::integer, id
from selections;

do $$
declare
  v_scene record;
  v_render_id uuid;
  v_task_id uuid;
  v_download_id bigint;
begin
  for v_scene in select * from fixture_scenes where workflow in ('landscape', 'portrait', 'reject') order by workflow, scene_index loop
    select render_id, task_id into v_render_id, v_task_id from v2_renders where label = v_scene.workflow;
    select download_id into v_download_id
    from public.record_video_asset_download_v2(
      v_render_id,
      v_scene.selection_id,
      ('00000000-0000-4000-8000-' || pg_catalog.right(pg_catalog.lpad(v_scene.selection_id::text, 12, '0'), 12))::uuid,
      'video-runs/' || v_task_id || '/sources/' || v_scene.scene_index || '.mp4',
      'mp4', 1000 + v_scene.scene_index, pg_catalog.md5(v_scene.workflow || v_scene.scene_index) || pg_catalog.md5('source' || v_scene.scene_index),
      1920, 1080, 6000, 30, 'h264', null, false, null, null, null
    );
    update fixture_scenes set download_id = v_download_id
    where workflow = v_scene.workflow and scene_index = v_scene.scene_index;
  end loop;
end;
$$;

select throws_ok(
  $$select * from public.record_video_asset_download_v2(
    (select render_id from v2_renders where label = 'reject'),
    (select selection_id from fixture_scenes where workflow = 'reject' and scene_index = 1),
    (select reservation_id from public.video_asset_downloads where id = (select download_id from fixture_scenes where workflow = 'reject' and scene_index = 0)),
    'video-runs/' || (select task_id from v2_renders where label = 'reject') || '/sources/conflict.mp4',
    'mp4', 2000, repeat('e', 64), 1920, 1080, 6000, 30, 'h264', null, false, null, null, null
  )$$,
  'P0004', null, 'reservation IDs cannot be reused with changed metadata'
);
select throws_ok(
  $$select * from public.record_video_asset_download_v2(
    (select render_id from v2_renders where label = 'reject'),
    (select selection_id from fixture_scenes where workflow = 'reject' and scene_index = 1),
    '32ac67ad-506c-4580-b604-af4f7394d812'::uuid,
    'video-runs/8a291fbb-a9e1-42c2-a8d9-fc0817508b7f/sources/cross-task.mp4',
    'mp4', 2000, repeat('e', 64), 1920, 1080, 6000, 30, 'h264', null, false, null, null, null
  )$$,
  'P0004', null, 'later downloads cannot change the artifact task ID'
);

select is((select status from public.begin_video_render_v2((select render_id from v2_renders where label = 'landscape'))), 'rendering', 'five downloads begin the landscape render');

create temporary table v2_payloads (label text primary key, segments jsonb not null, output jsonb not null);
insert into v2_payloads(label, segments, output)
select render.label,
  (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'segment_index', scene.scene_index,
      'download_id', scene.download_id,
      'timeline_start_ms', scene.scene_index * track.cue_duration_ms,
      'timeline_end_ms', (scene.scene_index + 1) * track.cue_duration_ms,
      'source_in_ms', 0,
      'source_out_ms', track.cue_duration_ms,
      'caption_en', cue.text,
      'caption_zh', '字幕 ' || scene.scene_index,
      'source_track_id', track.track_id,
      'source_cue_index', cue.cue_index
    ) order by scene.scene_index)
   from fixture_scenes as scene
   join v2_tracks as track on track.label = case when render.label = 'reject' then 'landscape' else render.label end
   join public.subtitle_cues as cue on cue.track_id = track.track_id and cue.cue_index = 20 + scene.scene_index
   where scene.workflow = render.label),
  pg_catalog.jsonb_build_object(
    'artifact_key', 'video-runs/' || render.task_id || '/final.mp4',
    'output_sha256', repeat(case render.label when 'portrait' then '8' when 'reject' then '9' else '7' end, 64),
    'output_size_bytes', 5000,
    'output_duration_ms', 15000,
    'width', case when render.label = 'portrait' then 1080 else 1920 end,
    'height', case when render.label = 'portrait' then 1920 else 1080 end,
    'video_codec', 'h264',
    'audio_codec', null,
    'pixel_format', 'yuv420p',
    'ffmpeg_version', 'fixture-7.1',
    'manifest_sha256', repeat('f', 64)
  )
from v2_renders as render
where render.label in ('landscape', 'portrait', 'reject');

select is(
  (select status from public.complete_video_render_v2(
    (select render_id from v2_renders where label = 'landscape'),
    (select segments from v2_payloads where label = 'landscape'),
    (select output from v2_payloads where label = 'landscape')
  )),
  'completed', 'five-scene landscape completes'
);
select ok(
  (select count(*) = 5 and bool_and(workflow_version = 2)
   from public.video_render_segments where render_id = (select render_id from v2_renders where label = 'landscape'))
  and (select audio_codec is null and output_width = 1920 and output_height = 1080
       and artifact_task_id = (select task_id from v2_renders where label = 'landscape')
       and artifact_task_id <> id
       from public.video_render_jobs where id = (select render_id from v2_renders where label = 'landscape')),
  'five-scene landscape persists exact v2 segments and null audio'
);

select is((select status from public.begin_video_render_v2((select render_id from v2_renders where label = 'portrait'))), 'rendering', 'ten downloads begin the portrait render');
select is(
  (select status from public.complete_video_render_v2(
    (select render_id from v2_renders where label = 'portrait'),
    (select segments from v2_payloads where label = 'portrait'),
    (select output from v2_payloads where label = 'portrait')
  )),
  'completed', 'ten-scene portrait completes'
);
select ok(
  (select count(*) = 10 from public.video_render_segments where render_id = (select render_id from v2_renders where label = 'portrait'))
  and (select audio_codec is null and output_width = 1080 and output_height = 1920
       from public.video_render_jobs where id = (select render_id from v2_renders where label = 'portrait')),
  'ten-scene portrait persists chosen dimensions and null audio'
);

select is((select status from public.begin_video_render_v2((select render_id from v2_renders where label = 'reject'))), 'rendering', 'rejection fixture reaches rendering');

select throws_ok($$select * from public.complete_video_render_v2((select render_id from v2_renders where label = 'reject'), jsonb_set((select segments from v2_payloads where label = 'reject'), '{1,segment_index}', '0'), (select output from v2_payloads where label = 'reject'))$$, 'P0005', null, 'completion rejects non-0..N-1 indices');
select throws_ok($$select * from public.complete_video_render_v2((select render_id from v2_renders where label = 'reject'), jsonb_set((select segments from v2_payloads where label = 'reject'), '{1,source_track_id}', '999999'), (select output from v2_payloads where label = 'reject'))$$, 'P0006', null, 'completion rejects a different source track');
select throws_ok($$select * from public.complete_video_render_v2((select render_id from v2_renders where label = 'reject'), jsonb_set((select segments from v2_payloads where label = 'reject'), '{1,source_cue_index}', '24'), (select output from v2_payloads where label = 'reject'))$$, 'P0006', null, 'completion rejects nonconsecutive cues');
select throws_ok($$select * from public.complete_video_render_v2((select render_id from v2_renders where label = 'reject'), jsonb_set((select segments from v2_payloads where label = 'reject'), '{1,caption_en}', '"changed"'), (select output from v2_payloads where label = 'reject'))$$, 'P0006', null, 'completion rejects changed English cue text');
select throws_ok($$select * from public.complete_video_render_v2((select render_id from v2_renders where label = 'reject'), jsonb_set((select segments from v2_payloads where label = 'reject'), '{1,source_out_ms}', '2999'), (select output from v2_payloads where label = 'reject'))$$, 'P0006', null, 'completion rejects a non-cue-equal source duration');
select throws_ok($$select * from public.complete_video_render_v2((select render_id from v2_renders where label = 'reject'), jsonb_set((select segments from v2_payloads where label = 'reject'), '{1,timeline_start_ms}', '3001'), (select output from v2_payloads where label = 'reject'))$$, 'P0006', null, 'completion rejects a noncontiguous timeline');
select throws_ok($$select * from public.complete_video_render_v2((select render_id from v2_renders where label = 'reject'), (select segments from v2_payloads where label = 'reject'), jsonb_set((select output from v2_payloads where label = 'reject'), '{output_duration_ms}', '16001'))$$, 'P0005', null, 'completion rejects output beyond duration tolerance');
select throws_ok($$select * from public.complete_video_render_v2((select render_id from v2_renders where label = 'reject'), (select segments from v2_payloads where label = 'reject'), jsonb_set((select output from v2_payloads where label = 'reject'), '{video_codec}', '"hevc"'))$$, 'P0005', null, 'completion rejects a non-H.264 codec');
select throws_ok($$select * from public.complete_video_render_v2((select render_id from v2_renders where label = 'reject'), (select segments from v2_payloads where label = 'reject'), jsonb_set((select output from v2_payloads where label = 'reject'), '{pixel_format}', '"yuv444p"'))$$, 'P0005', null, 'completion rejects a non-yuv420p pixel format');
select throws_ok($$select * from public.complete_video_render_v2((select render_id from v2_renders where label = 'reject'), (select segments from v2_payloads where label = 'reject'), jsonb_set((select output from v2_payloads where label = 'reject'), '{width}', '1080'))$$, 'P0005', null, 'completion rejects dimensions different from the request');
select throws_ok($$select * from public.complete_video_render_v2((select render_id from v2_renders where label = 'reject'), (select segments from v2_payloads where label = 'reject'), jsonb_set((select output from v2_payloads where label = 'reject'), '{audio_codec}', '"aac"'))$$, 'P0005', null, 'completion rejects a non-null audio codec');
select throws_ok($$select * from public.complete_video_render_v2((select render_id from v2_renders where label = 'reject'), (select segments from v2_payloads where label = 'reject'), jsonb_set((select output from v2_payloads where label = 'reject'), '{artifact_key}', '"video-runs/8a291fbb-a9e1-42c2-a8d9-fc0817508b7f/final.mp4"'))$$, 'P0004', null, 'completion cannot change the artifact task ID');
select throws_ok($$select * from public.complete_video_render_v2((select render_id from v2_renders where label = 'reject'), (select segments from v2_payloads where label = 'reject'), jsonb_set((select output from v2_payloads where label = 'reject'), '{width}', 'null'))$$, 'P0005', null, 'completion rejects a null output width');
select throws_ok($$select * from public.complete_video_render_v2((select render_id from v2_renders where label = 'reject'), (select segments from v2_payloads where label = 'reject'), jsonb_set((select output from v2_payloads where label = 'reject'), '{height}', 'null'))$$, 'P0005', null, 'completion rejects a null output height');
select throws_ok($$select * from public.complete_video_render_v2((select render_id from v2_renders where label = 'reject'), (select segments from v2_payloads where label = 'reject'), jsonb_set((select output from v2_payloads where label = 'reject'), '{video_codec}', 'null'))$$, 'P0005', null, 'completion rejects a null output video codec');
select throws_ok($$select * from public.complete_video_render_v2((select render_id from v2_renders where label = 'reject'), (select segments from v2_payloads where label = 'reject'), jsonb_set((select output from v2_payloads where label = 'reject'), '{pixel_format}', 'null'))$$, 'P0005', null, 'completion rejects a null output pixel format');
select throws_ok($$select * from public.complete_video_render_v2((select render_id from v2_renders where label = 'reject'), jsonb_set((select segments from v2_payloads where label = 'reject'), '{1,timeline_start_ms}', 'null'), (select output from v2_payloads where label = 'reject'))$$, 'P0005', null, 'completion rejects a null timeline start');
select throws_ok($$select * from public.complete_video_render_v2((select render_id from v2_renders where label = 'reject'), jsonb_set((select segments from v2_payloads where label = 'reject'), '{1,timeline_end_ms}', 'null'), (select output from v2_payloads where label = 'reject'))$$, 'P0005', null, 'completion rejects a null timeline end');
select throws_ok($$select * from public.complete_video_render_v2((select render_id from v2_renders where label = 'reject'), jsonb_set((select segments from v2_payloads where label = 'reject'), '{1,source_in_ms}', 'null'), (select output from v2_payloads where label = 'reject'))$$, 'P0005', null, 'completion rejects a null source start');
select throws_ok($$select * from public.complete_video_render_v2((select render_id from v2_renders where label = 'reject'), jsonb_set((select segments from v2_payloads where label = 'reject'), '{1,source_out_ms}', 'null'), (select output from v2_payloads where label = 'reject'))$$, 'P0005', null, 'completion rejects a null source end');

create temporary table v1_render (render_id uuid primary key);
insert into v1_render select render_id from public.start_video_render(repeat('6', 64), 'v1 compatibility');
select is((select status from public.video_render_jobs where id = (select render_id from v1_render)), 'planned', 'v1 start remains compatible');

do $$
declare
  v_scene record;
  v_render_id uuid := (select render_id from v1_render);
  v_download_id bigint;
begin
  for v_scene in select * from fixture_scenes where workflow = 'v1' order by scene_index loop
    select download_id into v_download_id from public.record_video_asset_download(
      v_render_id, v_scene.selection_id, 'video-runs/' || v_render_id || '/v1/' || v_scene.scene_index || '.mp4',
      'mp4', 1000, repeat((v_scene.scene_index + 1)::text, 64), 1920, 1080, 7500, 30, 'h264', 'aac', false, null, null, null
    );
    update fixture_scenes set download_id = v_download_id where workflow = 'v1' and scene_index = v_scene.scene_index;
  end loop;
  perform public.begin_video_render(v_render_id);
end;
$$;

select is(
  (select status from public.complete_video_render(
    (select render_id from v1_render),
    (select jsonb_agg(jsonb_build_object(
      'segment_index', scene.scene_index, 'download_id', scene.download_id,
      'timeline_start_ms', scene.scene_index * 7500, 'timeline_end_ms', (scene.scene_index + 1) * 7500,
      'source_in_ms', 0, 'source_out_ms', 7500,
      'caption_kind', case when scene.scene_index = 0 then 'quote' else 'original' end,
      'caption_en', case when scene.scene_index = 0 then cue.text else 'original ' || scene.scene_index end,
      'caption_zh', '兼容字幕',
      'source_track_id', case when scene.scene_index = 0 then cue.track_id else null end,
      'source_cue_index', case when scene.scene_index = 0 then cue.cue_index else null end
    ) order by scene.scene_index)
    from fixture_scenes as scene
    cross join (select track_id, 20 as cue_index, 'v1 exact cue 0' as text from v2_tracks where label = 'v1') as cue
    where scene.workflow = 'v1'),
    jsonb_build_object(
      'artifact_key', 'video-runs/' || (select render_id from v1_render) || '/final.mp4',
      'output_sha256', repeat('7', 64), 'output_size_bytes', 5000, 'output_duration_ms', 30000,
      'video_codec', 'h264', 'audio_codec', 'aac', 'pixel_format', 'yuv420p',
      'ffmpeg_version', 'fixture-7.1', 'manifest_sha256', repeat('8', 64)
    )
  )),
  'completed', 'v1 complete remains compatible'
);

select * from finish();
rollback;
