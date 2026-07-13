create function public.ingest_subtitle_batch(
  p_track_id bigint,
  p_cues jsonb,
  p_chunks jsonb
)
returns table (
  accepted_cue_count integer,
  accepted_chunk_count integer
)
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
    chunk.chunk_index,
    chunk.start_ms,
    chunk.end_ms,
    chunk.text,
    chunk.first_cue_index,
    chunk.last_cue_index,
    (chunk.embedding::text)::extensions.vector
  from pg_catalog.jsonb_to_recordset(p_chunks) as chunk(
    chunk_index integer,
    start_ms integer,
    end_ms integer,
    text text,
    first_cue_index integer,
    last_cue_index integer,
    embedding jsonb
  )
  on conflict (track_id, chunk_index) do update
  set
    start_ms = excluded.start_ms,
    end_ms = excluded.end_ms,
    text = excluded.text,
    first_cue_index = excluded.first_cue_index,
    last_cue_index = excluded.last_cue_index,
    embedding = excluded.embedding;

  return query
  select
    pg_catalog.jsonb_array_length(p_cues),
    pg_catalog.jsonb_array_length(p_chunks);
end;
$$;

create function public.finalize_subtitle_track(p_track_id bigint)
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

revoke all on function public.ingest_subtitle_batch(bigint, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_subtitle_batch(bigint, jsonb, jsonb) to service_role;
revoke all on function public.finalize_subtitle_track(bigint) from public, anon, authenticated;
grant execute on function public.finalize_subtitle_track(bigint) to service_role;
