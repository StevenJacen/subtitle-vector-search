-- Synthetic local fixture only. It contains no dialogue from copyrighted works.
insert into public.movies (title, release_year, imdb_id)
values ('Seeded Synthetic Lantern', 2030, 'seed-search-fixture');

insert into public.subtitle_tracks (
  movie_id,
  language_code,
  source,
  source_ref,
  source_file_name,
  source_sha256,
  rights_status,
  status
)
select
  id,
  'en',
  'synthetic',
  'local-search-fixture',
  'seed-search-fixture.srt',
  'seed-search-sha256',
  'personal_research',
  'ready'
from public.movies
where imdb_id = 'seed-search-fixture';

insert into public.subtitle_cues (track_id, cue_index, start_ms, end_ms, text)
select track.id, cue.cue_index, cue.start_ms, cue.end_ms, cue.text
from public.subtitle_tracks as track
cross join (
  values
    (0, 0, 2000, 'Mira sets a lantern on the workbench.'),
    (1, 2000, 4600, 'Jon paints a blue star beside the handle.'),
    (2, 4600, 7200, 'Together they carry the light to the garden.')
) as cue(cue_index, start_ms, end_ms, text)
where track.source_sha256 = 'seed-search-sha256';

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
  track.id,
  chunk.chunk_index,
  chunk.start_ms,
  chunk.end_ms,
  chunk.text,
  chunk.first_cue_index,
  chunk.last_cue_index,
  chunk.embedding::extensions.vector(384)
from public.subtitle_tracks as track
cross join (
  values
    (0, 0, 4600, 'Mira sets a lantern on the workbench. Jon paints a blue star beside the handle.', 0, 1, '[1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]'),
    (1, 2000, 7200, 'Jon paints a blue star beside the handle. Together they carry the light to the garden.', 1, 2, '[0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]')
) as chunk(chunk_index, start_ms, end_ms, text, first_cue_index, last_cue_index, embedding)
where track.source_sha256 = 'seed-search-sha256';
