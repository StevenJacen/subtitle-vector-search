create table public.subtitle_chunk_claims (
  track_id bigint not null references public.subtitle_tracks(id) on delete cascade,
  chunk_index integer not null constraint subtitle_chunk_claims_chunk_index_check check (chunk_index >= 0),
  claim_token uuid not null,
  claimed_at timestamptz not null default pg_catalog.statement_timestamp(),
  primary key (track_id, chunk_index)
);

create index subtitle_chunk_claims_track_id_idx on public.subtitle_chunk_claims (track_id);

alter table public.subtitle_chunk_claims enable row level security;
alter table public.subtitle_chunk_claims force row level security;
revoke all on table public.subtitle_chunk_claims from public, anon, authenticated;
grant select, insert, update, delete on table public.subtitle_chunk_claims to service_role;

drop function public.ingest_subtitle_batch(bigint, jsonb, jsonb);

create function public.reserve_subtitle_chunk_claims(
  p_track_id bigint,
  p_claim_token uuid,
  p_cues jsonb,
  p_chunk_indexes jsonb
)
returns table (claimed_chunk_index integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  track_status text;
begin
  select track.status
  into track_status
  from public.subtitle_tracks as track
  where track.id = p_track_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'subtitle track not found';
  end if;
  if track_status = 'ready' then
    raise exception using errcode = 'P0001', message = 'subtitle track is already ready';
  end if;

  insert into public.subtitle_cues (
    track_id,
    cue_index,
    start_ms,
    end_ms,
    text
  )
  select
    p_track_id,
    cue.cue_index,
    cue.start_ms,
    cue.end_ms,
    cue.text
  from pg_catalog.jsonb_to_recordset(p_cues) as cue(
    cue_index integer,
    start_ms integer,
    end_ms integer,
    text text
  )
  on conflict (track_id, cue_index) do update
  set
    start_ms = excluded.start_ms,
    end_ms = excluded.end_ms,
    text = excluded.text;

  return query
  insert into public.subtitle_chunk_claims as claim (
    track_id,
    chunk_index,
    claim_token,
    claimed_at
  )
  select
    p_track_id,
    requested.chunk_index,
    p_claim_token,
    pg_catalog.statement_timestamp()
  from pg_catalog.jsonb_to_recordset(p_chunk_indexes) as requested(chunk_index integer)
  where not exists (
    select 1
    from public.subtitle_chunks as completed
    where completed.track_id = p_track_id
      and completed.chunk_index = requested.chunk_index
  )
  on conflict (track_id, chunk_index) do update
  set
    claim_token = excluded.claim_token,
    claimed_at = excluded.claimed_at
  where claim.claimed_at < pg_catalog.statement_timestamp() - interval '10 minutes'
  returning claim.chunk_index;
end;
$$;

create function public.complete_subtitle_chunk_claims(
  p_track_id bigint,
  p_claim_token uuid,
  p_chunks jsonb
)
returns table (accepted_chunk_count integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  track_status text;
begin
  select track.status
  into track_status
  from public.subtitle_tracks as track
  where track.id = p_track_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'subtitle track not found';
  end if;
  if track_status = 'ready' then
    raise exception using errcode = 'P0001', message = 'subtitle track is already ready';
  end if;

  return query
  with matched_claims as (
    select
      chunk.chunk_index,
      chunk.start_ms,
      chunk.end_ms,
      chunk.text,
      chunk.first_cue_index,
      chunk.last_cue_index,
      chunk.embedding
    from pg_catalog.jsonb_to_recordset(p_chunks) as chunk(
      chunk_index integer,
      start_ms integer,
      end_ms integer,
      text text,
      first_cue_index integer,
      last_cue_index integer,
      embedding jsonb
    )
    join public.subtitle_chunk_claims as claim
      on claim.track_id = p_track_id
      and claim.chunk_index = chunk.chunk_index
      and claim.claim_token = p_claim_token
  ), inserted_chunks as (
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
      p_track_id,
      matched.chunk_index,
      matched.start_ms,
      matched.end_ms,
      matched.text,
      matched.first_cue_index,
      matched.last_cue_index,
      (matched.embedding::text)::extensions.vector
    from matched_claims as matched
    on conflict (track_id, chunk_index) do nothing
    returning chunk_index
  ), released_claims as (
    delete from public.subtitle_chunk_claims as claim
    using matched_claims as matched
    where claim.track_id = p_track_id
      and claim.chunk_index = matched.chunk_index
      and claim.claim_token = p_claim_token
      and (
        exists (
          select 1
          from inserted_chunks as inserted
          where inserted.chunk_index = matched.chunk_index
        ) or exists (
          select 1
          from public.subtitle_chunks as completed
          where completed.track_id = p_track_id
            and completed.chunk_index = matched.chunk_index
        )
      )
    returning claim.chunk_index
  )
  select pg_catalog.count(*)::integer
  from inserted_chunks;
end;
$$;

create or replace function public.finalize_subtitle_track(p_track_id bigint)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  track_status text;
begin
  select track.status
  into track_status
  from public.subtitle_tracks as track
  where track.id = p_track_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'subtitle track not found';
  end if;
  if exists (
    select 1
    from public.subtitle_chunk_claims as claim
    where claim.track_id = p_track_id
  ) then
    raise exception using errcode = 'P0003', message = 'subtitle track has pending chunk claims';
  end if;
  if not exists (
    select 1
    from public.subtitle_cues as cue
    where cue.track_id = p_track_id
  ) or not exists (
    select 1
    from public.subtitle_chunks as chunk
    where chunk.track_id = p_track_id
  ) then
    raise exception using errcode = 'P0001', message = 'subtitle track has incomplete cue ranges';
  end if;
  if exists (
    select 1
    from public.subtitle_chunks as chunk
    cross join lateral pg_catalog.generate_series(
      chunk.first_cue_index,
      chunk.last_cue_index
    ) as required_cue(cue_index)
    left join public.subtitle_cues as cue
      on cue.track_id = p_track_id
      and cue.cue_index = required_cue.cue_index
    where chunk.track_id = p_track_id
      and cue.id is null
  ) then
    raise exception using errcode = 'P0001', message = 'subtitle track has incomplete cue ranges';
  end if;

  update public.subtitle_tracks
  set status = 'ready'
  where id = p_track_id;
end;
$$;

revoke all on function public.reserve_subtitle_chunk_claims(bigint, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.reserve_subtitle_chunk_claims(bigint, uuid, jsonb, jsonb) to service_role;
revoke all on function public.complete_subtitle_chunk_claims(bigint, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.complete_subtitle_chunk_claims(bigint, uuid, jsonb) to service_role;
revoke all on function public.finalize_subtitle_track(bigint) from public, anon, authenticated;
grant execute on function public.finalize_subtitle_track(bigint) to service_role;
