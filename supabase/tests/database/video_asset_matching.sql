begin;

select plan(60);

-- 1-5: private tables
select has_table('public', 'visual_concepts', 'visual concepts table exists');
select has_table('public', 'video_search_runs', 'video search runs table exists');
select has_table('public', 'video_search_queries', 'video search queries table exists');
select has_table('public', 'video_search_candidates', 'video candidates table exists');
select has_table('public', 'video_asset_selections', 'video selections table exists');

-- 6: vector contract
select is(
  pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
  'extensions.vector(384)',
  'visual concept embeddings have 384 dimensions'
)
from pg_catalog.pg_attribute as attribute
where attribute.attrelid = 'public.visual_concepts'::pg_catalog.regclass
  and attribute.attname = 'embedding'
  and not attribute.attisdropped;

-- 7-11: RLS is both enabled and forced
select ok(class.relrowsecurity and class.relforcerowsecurity, 'visual concepts force RLS')
from pg_catalog.pg_class as class where class.oid = 'public.visual_concepts'::pg_catalog.regclass;
select ok(class.relrowsecurity and class.relforcerowsecurity, 'video search runs force RLS')
from pg_catalog.pg_class as class where class.oid = 'public.video_search_runs'::pg_catalog.regclass;
select ok(class.relrowsecurity and class.relforcerowsecurity, 'video search queries force RLS')
from pg_catalog.pg_class as class where class.oid = 'public.video_search_queries'::pg_catalog.regclass;
select ok(class.relrowsecurity and class.relforcerowsecurity, 'video candidates force RLS')
from pg_catalog.pg_class as class where class.oid = 'public.video_search_candidates'::pg_catalog.regclass;
select ok(class.relrowsecurity and class.relforcerowsecurity, 'video selections force RLS')
from pg_catalog.pg_class as class where class.oid = 'public.video_asset_selections'::pg_catalog.regclass;

-- 12-16: no policies expose these tables
select ok(not exists (select 1 from pg_catalog.pg_policy where polrelid = 'public.visual_concepts'::pg_catalog.regclass), 'visual concepts have no policies');
select ok(not exists (select 1 from pg_catalog.pg_policy where polrelid = 'public.video_search_runs'::pg_catalog.regclass), 'video search runs have no policies');
select ok(not exists (select 1 from pg_catalog.pg_policy where polrelid = 'public.video_search_queries'::pg_catalog.regclass), 'video search queries have no policies');
select ok(not exists (select 1 from pg_catalog.pg_policy where polrelid = 'public.video_search_candidates'::pg_catalog.regclass), 'video candidates have no policies');
select ok(not exists (select 1 from pg_catalog.pg_policy where polrelid = 'public.video_asset_selections'::pg_catalog.regclass), 'video selections have no policies');

-- 17-21: client roles have no table privileges
select ok(
  not has_table_privilege('anon', 'public.visual_concepts', 'select')
  and not has_table_privilege('anon', 'public.visual_concepts', 'insert')
  and not has_table_privilege('anon', 'public.visual_concepts', 'update')
  and not has_table_privilege('anon', 'public.visual_concepts', 'delete')
  and not has_table_privilege('authenticated', 'public.visual_concepts', 'select')
  and not has_table_privilege('authenticated', 'public.visual_concepts', 'insert')
  and not has_table_privilege('authenticated', 'public.visual_concepts', 'update')
  and not has_table_privilege('authenticated', 'public.visual_concepts', 'delete'),
  'client roles cannot access visual concepts'
);
select ok(
  not has_table_privilege('anon', 'public.video_search_runs', 'select')
  and not has_table_privilege('anon', 'public.video_search_runs', 'insert')
  and not has_table_privilege('anon', 'public.video_search_runs', 'update')
  and not has_table_privilege('anon', 'public.video_search_runs', 'delete')
  and not has_table_privilege('authenticated', 'public.video_search_runs', 'select')
  and not has_table_privilege('authenticated', 'public.video_search_runs', 'insert')
  and not has_table_privilege('authenticated', 'public.video_search_runs', 'update')
  and not has_table_privilege('authenticated', 'public.video_search_runs', 'delete'),
  'client roles cannot access video search runs'
);
select ok(
  not has_table_privilege('anon', 'public.video_search_queries', 'select')
  and not has_table_privilege('anon', 'public.video_search_queries', 'insert')
  and not has_table_privilege('anon', 'public.video_search_queries', 'update')
  and not has_table_privilege('anon', 'public.video_search_queries', 'delete')
  and not has_table_privilege('authenticated', 'public.video_search_queries', 'select')
  and not has_table_privilege('authenticated', 'public.video_search_queries', 'insert')
  and not has_table_privilege('authenticated', 'public.video_search_queries', 'update')
  and not has_table_privilege('authenticated', 'public.video_search_queries', 'delete'),
  'client roles cannot access video search queries'
);
select ok(
  not has_table_privilege('anon', 'public.video_search_candidates', 'select')
  and not has_table_privilege('anon', 'public.video_search_candidates', 'insert')
  and not has_table_privilege('anon', 'public.video_search_candidates', 'update')
  and not has_table_privilege('anon', 'public.video_search_candidates', 'delete')
  and not has_table_privilege('authenticated', 'public.video_search_candidates', 'select')
  and not has_table_privilege('authenticated', 'public.video_search_candidates', 'insert')
  and not has_table_privilege('authenticated', 'public.video_search_candidates', 'update')
  and not has_table_privilege('authenticated', 'public.video_search_candidates', 'delete'),
  'client roles cannot access video candidates'
);
select ok(
  not has_table_privilege('anon', 'public.video_asset_selections', 'select')
  and not has_table_privilege('anon', 'public.video_asset_selections', 'insert')
  and not has_table_privilege('anon', 'public.video_asset_selections', 'update')
  and not has_table_privilege('anon', 'public.video_asset_selections', 'delete')
  and not has_table_privilege('authenticated', 'public.video_asset_selections', 'select')
  and not has_table_privilege('authenticated', 'public.video_asset_selections', 'insert')
  and not has_table_privilege('authenticated', 'public.video_asset_selections', 'update')
  and not has_table_privilege('authenticated', 'public.video_asset_selections', 'delete'),
  'client roles cannot access video selections'
);

-- 22-25: client roles have no sequence privileges
select ok(
  not has_sequence_privilege('anon', 'public.visual_concepts_id_seq', 'usage')
  and not has_sequence_privilege('anon', 'public.visual_concepts_id_seq', 'select')
  and not has_sequence_privilege('anon', 'public.visual_concepts_id_seq', 'update')
  and not has_sequence_privilege('authenticated', 'public.visual_concepts_id_seq', 'usage')
  and not has_sequence_privilege('authenticated', 'public.visual_concepts_id_seq', 'select')
  and not has_sequence_privilege('authenticated', 'public.visual_concepts_id_seq', 'update'),
  'client roles cannot access visual concept sequence'
);
select ok(
  not has_sequence_privilege('anon', 'public.video_search_queries_id_seq', 'usage')
  and not has_sequence_privilege('anon', 'public.video_search_queries_id_seq', 'select')
  and not has_sequence_privilege('anon', 'public.video_search_queries_id_seq', 'update')
  and not has_sequence_privilege('authenticated', 'public.video_search_queries_id_seq', 'usage')
  and not has_sequence_privilege('authenticated', 'public.video_search_queries_id_seq', 'select')
  and not has_sequence_privilege('authenticated', 'public.video_search_queries_id_seq', 'update'),
  'client roles cannot access video query sequence'
);
select ok(
  not has_sequence_privilege('anon', 'public.video_search_candidates_id_seq', 'usage')
  and not has_sequence_privilege('anon', 'public.video_search_candidates_id_seq', 'select')
  and not has_sequence_privilege('anon', 'public.video_search_candidates_id_seq', 'update')
  and not has_sequence_privilege('authenticated', 'public.video_search_candidates_id_seq', 'usage')
  and not has_sequence_privilege('authenticated', 'public.video_search_candidates_id_seq', 'select')
  and not has_sequence_privilege('authenticated', 'public.video_search_candidates_id_seq', 'update'),
  'client roles cannot access video candidate sequence'
);
select ok(
  not has_sequence_privilege('anon', 'public.video_asset_selections_id_seq', 'usage')
  and not has_sequence_privilege('anon', 'public.video_asset_selections_id_seq', 'select')
  and not has_sequence_privilege('anon', 'public.video_asset_selections_id_seq', 'update')
  and not has_sequence_privilege('authenticated', 'public.video_asset_selections_id_seq', 'usage')
  and not has_sequence_privilege('authenticated', 'public.video_asset_selections_id_seq', 'select')
  and not has_sequence_privilege('authenticated', 'public.video_asset_selections_id_seq', 'update'),
  'client roles cannot access video selection sequence'
);

-- 26-30: service role owns the private data path
select ok(
  has_table_privilege('service_role', 'public.visual_concepts', 'select')
  and has_table_privilege('service_role', 'public.visual_concepts', 'insert')
  and has_table_privilege('service_role', 'public.visual_concepts', 'update')
  and has_table_privilege('service_role', 'public.visual_concepts', 'delete'),
  'service role accesses visual concepts'
);
select ok(
  has_table_privilege('service_role', 'public.video_search_runs', 'select')
  and has_table_privilege('service_role', 'public.video_search_runs', 'insert')
  and has_table_privilege('service_role', 'public.video_search_runs', 'update')
  and has_table_privilege('service_role', 'public.video_search_runs', 'delete'),
  'service role accesses video search runs'
);
select ok(
  has_table_privilege('service_role', 'public.video_search_queries', 'select')
  and has_table_privilege('service_role', 'public.video_search_queries', 'insert')
  and has_table_privilege('service_role', 'public.video_search_queries', 'update')
  and has_table_privilege('service_role', 'public.video_search_queries', 'delete'),
  'service role accesses video search queries'
);
select ok(
  has_table_privilege('service_role', 'public.video_search_candidates', 'select')
  and has_table_privilege('service_role', 'public.video_search_candidates', 'insert')
  and has_table_privilege('service_role', 'public.video_search_candidates', 'update')
  and has_table_privilege('service_role', 'public.video_search_candidates', 'delete'),
  'service role accesses video candidates'
);
select ok(
  has_table_privilege('service_role', 'public.video_asset_selections', 'select')
  and has_table_privilege('service_role', 'public.video_asset_selections', 'insert')
  and has_table_privilege('service_role', 'public.video_asset_selections', 'update')
  and has_table_privilege('service_role', 'public.video_asset_selections', 'delete'),
  'service role accesses video selections'
);

-- 31-35: exact RPC signatures
select has_function('public', 'begin_video_search_run', array['bigint', 'text', 'text', 'text', 'integer', 'text', 'text'], 'begin run RPC exists');
select has_function('public', 'finish_video_search_run', array['uuid', 'text', 'boolean', 'jsonb', 'integer', 'integer', 'text', 'jsonb', 'jsonb'], 'finish run RPC exists');
select has_function('public', 'match_visual_concept', array['extensions.vector'], 'concept match RPC exists');
select has_function('public', 'upsert_visual_concepts', array['jsonb'], 'concept upsert RPC exists');
select has_function('public', 'select_video_asset', array['uuid', 'bigint', 'text'], 'video selection RPC exists');

-- 36-40: every RPC is invoker-security with an empty search path
select ok(
  exists (select 1 from pg_catalog.pg_proc as procedure join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace where namespace.nspname = 'public' and procedure.proname = 'begin_video_search_run' and not procedure.prosecdef and procedure.proconfig && array['search_path=', 'search_path=""']::text[]),
  'begin run RPC is security invoker with empty search path'
);
select ok(
  exists (select 1 from pg_catalog.pg_proc as procedure join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace where namespace.nspname = 'public' and procedure.proname = 'finish_video_search_run' and not procedure.prosecdef and procedure.proconfig && array['search_path=', 'search_path=""']::text[]),
  'finish run RPC is security invoker with empty search path'
);
select ok(
  exists (select 1 from pg_catalog.pg_proc as procedure join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace where namespace.nspname = 'public' and procedure.proname = 'match_visual_concept' and not procedure.prosecdef and procedure.proconfig && array['search_path=', 'search_path=""']::text[]),
  'concept match RPC is security invoker with empty search path'
);
select ok(
  exists (select 1 from pg_catalog.pg_proc as procedure join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace where namespace.nspname = 'public' and procedure.proname = 'upsert_visual_concepts' and not procedure.prosecdef and procedure.proconfig && array['search_path=', 'search_path=""']::text[]),
  'concept upsert RPC is security invoker with empty search path'
);
select ok(
  exists (select 1 from pg_catalog.pg_proc as procedure join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace where namespace.nspname = 'public' and procedure.proname = 'select_video_asset' and not procedure.prosecdef and procedure.proconfig && array['search_path=', 'search_path=""']::text[]),
  'selection RPC is security invoker with empty search path'
);

-- 41-42: only service infrastructure executes RPCs
select ok(
  not has_function_privilege('anon', 'public.begin_video_search_run(bigint,text,text,text,integer,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.begin_video_search_run(bigint,text,text,text,integer,text,text)', 'execute')
  and has_function_privilege('service_role', 'public.begin_video_search_run(bigint,text,text,text,integer,text,text)', 'execute'),
  'only service role executes begin run'
);
select ok(
  not has_function_privilege('anon', 'public.finish_video_search_run(uuid,text,boolean,jsonb,integer,integer,text,jsonb,jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.finish_video_search_run(uuid,text,boolean,jsonb,integer,integer,text,jsonb,jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.finish_video_search_run(uuid,text,boolean,jsonb,integer,integer,text,jsonb,jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.match_visual_concept(extensions.vector)', 'execute')
  and not has_function_privilege('authenticated', 'public.match_visual_concept(extensions.vector)', 'execute')
  and has_function_privilege('service_role', 'public.match_visual_concept(extensions.vector)', 'execute')
  and not has_function_privilege('anon', 'public.upsert_visual_concepts(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.upsert_visual_concepts(jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.upsert_visual_concepts(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.select_video_asset(uuid,bigint,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.select_video_asset(uuid,bigint,text)', 'execute')
  and has_function_privilege('service_role', 'public.select_video_asset(uuid,bigint,text)', 'execute'),
  'only service role executes the remaining video asset RPCs'
);

create temporary table task3_runs(label text primary key, run_id uuid not null);

insert into task3_runs(label, run_id)
select 'constraints', started.run_id
from public.begin_video_search_run(null, 'text', pg_catalog.repeat('1', 64), null, 8, 'gemma4:12b', 'visual-plan-v1') as started;

-- 43-47: exact enums, bounds, and per-run uniqueness
select throws_ok(
  $$insert into public.video_search_queries(run_id, kind, term, weight, filters, status) select run_id, 'other', 'term', 0.4, '{}'::jsonb, 'completed' from task3_runs where label = 'constraints'$$,
  '23514', null, 'query kinds are exactly literal action and metaphor'
);
select throws_ok(
  $$insert into public.video_search_runs(input_kind, input_digest, candidate_count, status, planner_model, prompt_version) values ('text', repeat('2', 64), 4, 'planning', 'gemma4:12b', 'visual-plan-v1')$$,
  '23514', null, 'candidate count rejects values below five'
);
select throws_ok(
  $$insert into public.video_search_runs(input_kind, input_digest, candidate_count, status, planner_model, prompt_version) values ('text', repeat('3', 64), 11, 'planning', 'gemma4:12b', 'visual-plan-v1')$$,
  '23514', null, 'candidate count rejects values above ten'
);

insert into public.video_search_queries(run_id, kind, term, weight, filters, status)
select run_id, 'literal', 'literal term', 0.4, '{}'::jsonb, 'completed' from task3_runs where label = 'constraints';
select throws_ok(
  $$insert into public.video_search_queries(run_id, kind, term, weight, filters, status) select run_id, 'literal', 'duplicate literal', 0.4, '{}'::jsonb, 'completed' from task3_runs where label = 'constraints'$$,
  '23505', null, 'a run has at most one query of each kind'
);

insert into public.video_search_candidates(
  run_id, provider_resource_id, title, content_type, tags, file_types,
  download_sizes, fused_score, best_rank, matched_query_kinds
)
select run_id, 9001, null, 'video', array['test'], '[]'::jsonb,
  '[]'::jsonb, 0.01, 1, array['literal'] from task3_runs where label = 'constraints';
select throws_ok(
  $$insert into public.video_search_candidates(run_id, provider_resource_id, content_type, fused_score, best_rank, matched_query_kinds) select run_id, 9001, 'video', 0.02, 2, array['action'] from task3_runs where label = 'constraints'$$,
  '23505', null, 'a provider resource appears once per run'
);

-- 48: failed runs are retryable because they are outside the partial unique index
insert into task3_runs(label, run_id)
select 'failed-first', started.run_id
from public.begin_video_search_run(null, 'theme', pg_catalog.repeat('4', 64), 'retry theme', 8, 'gemma4:12b', 'visual-plan-v1') as started;
update public.video_search_runs set status = 'failed', failure_code = 'planner_unavailable'
where id = (select run_id from task3_runs where label = 'failed-first');
insert into task3_runs(label, run_id)
select 'failed-retry', started.run_id
from public.begin_video_search_run(null, 'theme', pg_catalog.repeat('4', 64), 'retry theme', 8, 'gemma4:12b', 'visual-plan-v1') as started;
select ok(
  (select count(*) = 2 and pg_catalog.count(*) filter (where status = 'planning') = 1 from public.video_search_runs where input_digest = pg_catalog.repeat('4', 64)),
  'failed runs are excluded from idempotency'
);

-- 49: an active digest returns the existing run
create temporary table task3_begin_results(run_id uuid, status text, is_existing boolean);
insert into task3_begin_results select * from public.begin_video_search_run(null, 'text', pg_catalog.repeat('5', 64), null, 8, 'gemma4:12b', 'visual-plan-v1');
insert into task3_begin_results select * from public.begin_video_search_run(null, 'text', pg_catalog.repeat('5', 64), null, 8, 'gemma4:12b', 'visual-plan-v1');
select ok(
  (select count(distinct run_id) = 1 and pg_catalog.bool_or(not is_existing) and pg_catalog.bool_or(is_existing) from task3_begin_results),
  'begin run atomically reuses an active digest'
);

-- 50: stale planning rows fail before a replacement is inserted
insert into public.video_search_runs(input_kind, input_digest, candidate_count, status, planner_model, prompt_version, created_at)
values ('text', pg_catalog.repeat('6', 64), 8, 'planning', 'gemma4:12b', 'visual-plan-v1', pg_catalog.clock_timestamp() - interval '6 minutes');
insert into task3_runs(label, run_id)
select 'stale-retry', started.run_id
from public.begin_video_search_run(null, 'text', pg_catalog.repeat('6', 64), null, 8, 'gemma4:12b', 'visual-plan-v1') as started;
select ok(
  (select count(*) = 2
    and pg_catalog.count(*) filter (where status = 'failed' and failure_code = 'stale_planning') = 1
    and pg_catalog.count(*) filter (where status = 'planning') = 1
   from public.video_search_runs where input_digest = pg_catalog.repeat('6', 64)),
  'begin run recovers planning rows older than five minutes'
);

insert into task3_runs(label, run_id)
select 'atomic-finish', started.run_id
from public.begin_video_search_run(null, 'text', pg_catalog.repeat('7', 64), null, 8, 'gemma4:12b', 'visual-plan-v1') as started;

-- 51: finish requires exactly three query records
select throws_ok(
  $$select public.finish_video_search_run(
    (select run_id from task3_runs where label = 'atomic-finish'),
    'completed', false, '{}'::jsonb, 10, 20, null,
    '[{"kind":"literal","term":"one","weight":0.4,"filters":{},"status":"completed"},{"kind":"action","term":"two","weight":0.4,"filters":{},"status":"completed"}]'::jsonb,
    '[]'::jsonb
  )$$,
  '22023', null, 'finish requires exactly three query records'
);

-- 52-53: a candidate failure rolls back all query inserts and the state transition
select throws_ok(
  $$select public.finish_video_search_run(
    (select run_id from task3_runs where label = 'atomic-finish'),
    'completed', false, '{"subject":"test"}'::jsonb, 10, 20, null,
    '[{"kind":"literal","term":"one","weight":0.4,"filters":{},"provider_total":1,"status":"completed","elapsed_ms":1},{"kind":"action","term":"two","weight":0.4,"filters":{},"provider_total":1,"status":"completed","elapsed_ms":1},{"kind":"metaphor","term":"three","weight":0.2,"filters":{},"provider_total":1,"status":"completed","elapsed_ms":1}]'::jsonb,
    '[{"provider_resource_id":7100,"title":null,"content_type":"video","license_type":"commercial","ai_generated":false,"orientation":"horizontal","tags":[],"file_types":[],"download_sizes":[],"fused_score":-1,"best_rank":1,"matched_query_kinds":["literal"]}]'::jsonb
  )$$,
  '23514', null, 'finish is atomic when candidate persistence fails'
);
select ok(
  not exists (select 1 from public.video_search_queries where run_id = (select run_id from task3_runs where label = 'atomic-finish'))
  and (select status = 'planning' from public.video_search_runs where id = (select run_id from task3_runs where label = 'atomic-finish')),
  'failed finish leaves no partial query rows or terminal state'
);

insert into task3_runs(label, run_id)
select 'successful-finish', started.run_id
from public.begin_video_search_run(null, 'theme', pg_catalog.repeat('8', 64), 'hope', 8, 'gemma4:12b', 'visual-plan-v1') as started;

do $$
begin
  perform public.finish_video_search_run(
    (select run_id from task3_runs where label = 'successful-finish'),
    'degraded', true, '{"subject":"sunrise"}'::jsonb, 12, 34, null,
    '[{"kind":"literal","term":"one","weight":0.4,"filters":{"content_type":"video"},"provider_total":10,"status":"completed","elapsed_ms":2},{"kind":"action","term":"two","weight":0.4,"filters":{"content_type":"video"},"provider_total":9,"status":"completed","elapsed_ms":3},{"kind":"metaphor","term":"three","weight":0.2,"filters":{"content_type":"video"},"provider_total":0,"status":"failed","elapsed_ms":4}]'::jsonb,
    '[{"provider_resource_id":7001,"title":null,"content_type":"video","license_type":"commercial","ai_generated":false,"orientation":"horizontal","tags":["sunrise"],"file_types":[{"extension":"mp4","sizeInBytes":123}],"download_sizes":[{"id":"hd","width":1920,"height":1080}],"fused_score":0.02,"best_rank":1,"matched_query_kinds":["literal","action"]},{"provider_resource_id":7002,"title":"Second","content_type":"video","license_type":null,"ai_generated":null,"orientation":null,"tags":[],"file_types":[],"download_sizes":[],"fused_score":0.01,"best_rank":2,"matched_query_kinds":["literal"]}]'::jsonb
  );
end;
$$;

-- 54-56: successful finish persists one coherent terminal result set
select is(
  (select count(*) from public.video_search_queries where run_id = (select run_id from task3_runs where label = 'successful-finish')),
  3::bigint,
  'finish persists exactly three query rows'
);
select is(
  (select count(*) from public.video_search_candidates where run_id = (select run_id from task3_runs where label = 'successful-finish')),
  2::bigint,
  'finish persists every supplied candidate'
);
select ok(
  (select status = 'degraded' and fallback_used and visual_intent = '{"subject":"sunrise"}'::jsonb
    and planner_elapsed_ms = 12 and total_elapsed_ms = 34 and completed_at is not null
   from public.video_search_runs where id = (select run_id from task3_runs where label = 'successful-finish')),
  'finish persists planner fields timings and terminal state together'
);

-- 57: enabled concepts are matched by ascending cosine distance
do $$
begin
  perform public.upsert_visual_concepts(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'concept_key', 'near', 'description', 'Near vector', 'literal_query', 'near literal',
      'action_query', 'near action', 'metaphor_query', 'near metaphor',
      'embedding', pg_catalog.to_jsonb(pg_catalog.array_cat(array[1::real, 0::real], pg_catalog.array_fill(0::real, array[382])))
    ),
    pg_catalog.jsonb_build_object(
      'concept_key', 'far', 'description', 'Far vector', 'literal_query', 'far literal',
      'action_query', 'far action', 'metaphor_query', 'far metaphor',
      'embedding', pg_catalog.to_jsonb(pg_catalog.array_cat(array[0::real, 1::real], pg_catalog.array_fill(0::real, array[382])))
    )
  ));
end;
$$;
select is(
  (select concept_key from public.match_visual_concept(
    ('[' || pg_catalog.array_to_string(pg_catalog.array_cat(array[1::real, 0::real], pg_catalog.array_fill(0::real, array[382])), ',') || ']')::extensions.vector
  )),
  'near',
  'concept matching returns the nearest enabled cosine vector'
);

-- 58: concept upsert replaces mutable fields without duplicating the key
do $$
begin
  perform public.upsert_visual_concepts(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'concept_key', 'near', 'description', 'Updated near vector', 'literal_query', 'new literal',
      'action_query', 'new action', 'metaphor_query', 'new metaphor',
      'embedding', pg_catalog.to_jsonb(pg_catalog.array_cat(array[1::real, 0::real], pg_catalog.array_fill(0::real, array[382])))
    )
  ));
end;
$$;
select ok(
  (select count(*) = 1 and pg_catalog.max(description) = 'Updated near vector' from public.visual_concepts where concept_key = 'near'),
  'visual concepts upsert by concept key'
);

-- 59-60: selection ownership and replacement
select throws_ok(
  $$select * from public.select_video_asset((select run_id from task3_runs where label = 'successful-finish'), 9001, null)$$,
  'P0002', 'candidate does not belong to run', 'selection rejects a provider resource owned by another run'
);

create temporary table task3_selection_results(selection_id bigint);
insert into task3_selection_results select selection_id from public.select_video_asset((select run_id from task3_runs where label = 'successful-finish'), 7001, 'first');
insert into task3_selection_results select selection_id from public.select_video_asset((select run_id from task3_runs where label = 'successful-finish'), 7002, 'replacement');
select ok(
  (select count(*) = 1
    and pg_catalog.max(note) = 'replacement'
    and pg_catalog.max(candidate_id) = (
      select id from public.video_search_candidates
      where run_id = (select run_id from task3_runs where label = 'successful-finish')
        and provider_resource_id = 7002
    )
   from public.video_asset_selections where run_id = (select run_id from task3_runs where label = 'successful-finish'))
  and (select count(distinct selection_id) = 1 from task3_selection_results),
  'selecting again replaces the one selection for the run'
);

select * from finish();
rollback;
