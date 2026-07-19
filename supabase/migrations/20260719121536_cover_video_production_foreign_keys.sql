create index video_asset_downloads_selection_candidate_idx
on public.video_asset_downloads (selection_id, candidate_id);

create index video_asset_selections_run_candidate_idx
on public.video_asset_selections (run_id, candidate_id);

create index video_render_segments_render_download_idx
on public.video_render_segments (render_id, download_id);
