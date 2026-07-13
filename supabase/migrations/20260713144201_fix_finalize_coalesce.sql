create or replace function public.finalize_subtitle_track(p_track_id bigint)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1
  from public.subtitle_tracks as track
  where track.id = p_track_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'subtitle track not found';
  end if;
  if exists (
    select 1 from public.subtitle_chunk_claims as claim where claim.track_id = p_track_id
  ) then
    raise exception using errcode = 'P0003', message = 'subtitle track has pending chunk claims';
  end if;
  if not exists (
    select 1 from public.subtitle_cues as cue where cue.track_id = p_track_id
  ) or not exists (
    select 1 from public.subtitle_chunks as chunk where chunk.track_id = p_track_id
  ) or exists (
    select 1
    from public.subtitle_chunks as chunk
    cross join lateral pg_catalog.generate_series(chunk.first_cue_index, chunk.last_cue_index) as required_cue(cue_index)
    left join public.subtitle_cues as cue
      on cue.track_id = p_track_id and cue.cue_index = required_cue.cue_index
    where chunk.track_id = p_track_id and cue.id is null
  ) then
    raise exception using errcode = 'P0001', message = 'subtitle track has incomplete cue ranges';
  end if;
  if exists (
    select 1
    from public.subtitle_chunks as chunk
    join public.subtitle_cues as first_cue
      on first_cue.track_id = chunk.track_id and first_cue.cue_index = chunk.first_cue_index
    join public.subtitle_cues as last_cue
      on last_cue.track_id = chunk.track_id and last_cue.cue_index = chunk.last_cue_index
    cross join lateral (
      select coalesce(
        pg_catalog.string_agg(cue.text, ' ' order by cue.cue_index)
          filter (where pg_catalog.btrim(cue.text) <> ''),
        ''
      ) as text
      from public.subtitle_cues as cue
      where cue.track_id = chunk.track_id
        and cue.cue_index between chunk.first_cue_index and chunk.last_cue_index
    ) as expected
    where chunk.track_id = p_track_id
      and (
        first_cue.start_ms <> chunk.start_ms
        or last_cue.end_ms <> chunk.end_ms
        or expected.text <> chunk.text
      )
  ) then
    raise exception using errcode = 'P0004', message = 'subtitle chunks do not match their cue ranges';
  end if;

  update public.subtitle_tracks set status = 'ready' where id = p_track_id;
end;
$$;

revoke all on function public.finalize_subtitle_track(bigint) from public, anon, authenticated;
grant execute on function public.finalize_subtitle_track(bigint) to service_role;
