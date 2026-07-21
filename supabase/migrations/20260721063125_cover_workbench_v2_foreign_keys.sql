create index if not exists video_render_jobs_v2_source_start_idx
  on public.video_render_jobs (source_track_id, source_start_cue_index);

create index if not exists video_render_jobs_v2_source_end_idx
  on public.video_render_jobs (source_track_id, source_end_cue_index);
