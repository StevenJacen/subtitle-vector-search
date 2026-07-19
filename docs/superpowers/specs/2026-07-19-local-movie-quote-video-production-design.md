# Local Movie-Quote Video Production Design

## Goal

Extend the private subtitle and Vecteezy candidate-matching system into one
auditable end-to-end production run that:

1. Adds as many new classic-film subtitle tracks as the current OpenSubtitles
   allowance permits.
2. Searches the resulting full Supabase corpus for one concise movie quote
   related to hope, resilience, and moving from darkness toward dawn.
3. Builds a four-scene, approximately 30-second, 16:9 storyboard with bilingual
   English and Chinese captions.
4. Searches and reviews 5-10 Vecteezy candidates per scene, then formally
   downloads no more than four selected videos.
5. Renders and verifies an H.264/AAC MP4 with the installed local FFmpeg.
6. Writes download, timeline, and render metadata back to private Supabase
   tables while all media files remain local.

This first production is for private personal research. It is a controlled
proof of the production path, not an unattended publishing system.

## Confirmed Decisions

- Use the existing Supabase project and hosted Edge Functions for private data,
  embeddings, quote retrieval, Vecteezy candidate search, and audit records.
- Use a local TypeScript orchestrator for provider downloads, media inspection,
  FFmpeg rendering, artifact management, and final verification.
- Expand the classic-film corpus until OpenSubtitles reports a quota, rate, or
  daily download limit. Preserve resumable state and continue to quote search
  even if the current allowance permits no new film.
- Search across every ready subtitle track after the expansion attempt.
- Use one exact, short, timestamped movie cue in the finished video.
- Use original copy for the other scenes and display English and manually
  reviewed Chinese captions.
- Use no narration. Mute provider clip audio and generate a restrained local
  ambient bed with FFmpeg.
- Produce a 1920x1080, 30 fps, approximately 30-second landscape video.
- Retain 5-10 Vecteezy candidates per scene, review previews, and formally
  download at most four resources.
- Keep source clips and the final video in ignored local artifact directories.
  Supabase stores stable metadata and hashes, not the media bytes.
- Never store Vecteezy signed download URLs. They expire after 24 hours and are
  used only for immediate transfer.
- Never send exact movie dialogue to the unauthenticated plaintext Ollama test
  endpoint. Ollama receives only generic, non-copyrighted visual concepts and
  original scene descriptions.

## Existing System

The implementation extends the current repository rather than replacing it:

- The hosted project currently contains 17 ready films, 29,681 timestamped
  subtitle cues, and 1,160 embedded subtitle chunks.
- Subtitle embeddings use normalized 384-dimensional `gte-small` vectors.
- `search-subtitles` returns ranked chunks plus the exact cue rows contained in
  each match. This is the preferred quote endpoint because the final video needs
  one precise cue, not an entire joined montage.
- `movie-quote-montage` remains unchanged and is not required for this run.
- `match-video-assets` creates one literal, one action, and one metaphor search,
  fuses provider ranks, and persists 5-10 candidates.
- `select-video-asset` records one selected candidate for a search run without
  downloading it.
- The current local classic-film state records 11 successful batch imports.
  `The Matrix` is the next ranked candidate not present in the hosted corpus.
- The local FFmpeg build includes H.264, AAC, libass, and font rendering support.

All existing subtitle, search, and video-candidate tables remain private under
forced RLS with no browser-role policies.

## Chosen Architecture

Three implementation approaches were considered:

1. A Supabase-orchestrated workflow with local download and FFmpeg rendering.
2. An Edge Function job queue consumed by a persistent local rendering worker.
3. A one-off local script that bypasses the existing candidate and audit APIs.

Approach 1 is selected. Supabase remains the source of truth and policy boundary,
while large file transfers and FFmpeg stay on the user's machine. This minimizes
new infrastructure, preserves the existing authentication model, and creates a
reusable CLI without introducing a queue before repeated production requires
one.

## Components

### 1. Existing classic-film batch importer

Invoke the existing resumable importer with the candidate-pool target and a
matching attempt ceiling:

```powershell
npx tsx src/batch-classics.ts --target 230 --max-attempts 230
```

The command starts at the next unprocessed candidate, downloads only through
the official OpenSubtitles API, stores subtitle files under the ignored
`downloads/classics` directory, and imports normalized cues and chunks through
the existing private ingestion Edge Function.

A quota or configuration stop is terminal for the expansion phase but not for
the video run. Ordinary per-film failures are recorded and the importer moves
to the next candidate. The local state remains the resume cursor for a later
day.

After the importer stops, query hosted counts rather than assuming that local
state and remote state are identical. Only tracks with `status = 'ready'` and
non-null chunk embeddings participate in retrieval.

### 2. Quote selection

Call `search-subtitles` with this canonical English semantic query:

```text
hope after hardship, moving through darkness toward dawn, resilience and a new beginning
```

Request 20 results across the complete corpus. Select deterministically from
the returned exact cue arrays:

- prefer higher parent-chunk similarity;
- require one non-empty cue with 5-18 English words;
- require a cue duration of at most eight seconds;
- reject bracketed sound descriptions, speaker labels without dialogue, and
  formatting-only text;
- break ties by shorter duration, movie ID, track ID, and cue index.

If no cue passes every preferred bound, relax the word-count bound once to
3-24 words and the duration bound to 10 seconds. If no usable cue remains, stop
before any Vecteezy formal download.

The selected English cue is preserved exactly. The Chinese translation is
manually reviewed for this first run and passed to the local command as
production input. Translation is not delegated to Ollama. The quote segment
stores a composite source reference to `(track_id, cue_index)`, which is already
unique in `subtitle_cues`.

### 3. Storyboard builder

Create four scenes under the canonical theme `Crossing darkness toward dawn`.
The storyboard contains:

1. an original opening image of darkness or a storm;
2. an original scene of a solitary person continuing forward;
3. the selected exact movie quote paired with a generic visual interpretation;
4. an original closing image of sunrise and an open horizon.

Each scene includes original English copy, reviewed Chinese copy, and a generic
visual description. The quote scene's visual description describes only its
theme and physical imagery; it does not contain the quote, movie title,
character, or a request to recreate the copyrighted scene.

The first implementation uses a checked-in storyboard schema and locally
generated run data. It does not check copyrighted dialogue, Chinese subtitle
text, or provider payloads into Git.

### 4. Candidate search and review

For each of the four scene descriptions:

1. Call `match-video-assets` with a generic theme and `candidateCount = 8`.
2. Let the existing planner produce literal, action, and metaphor Vecteezy
   searches.
3. Prefer horizontal, commercial, non-AI candidates when metadata is available,
   but do not discard a strong candidate solely because optional metadata is
   absent.
4. Review candidate previews and technical metadata.
5. Call `select-video-asset` for the chosen candidate.

This produces four independent search runs and four selections. Visual review
is intentionally human-in-the-loop in this phase because provider rank and text
metadata cannot prove that a video frame actually matches the intended action.

### 5. Local Vecteezy download client

Add a local client that reads `VECTEEZY_ACCOUNT` and `VECTEEZY_API_KEY` from the
ignored `.env` file and uses Bearer authentication.

For each selected candidate:

1. Fetch fresh resource details and verify that an MP4 source is available.
2. Call `GET /v2/{account_id}/resources/{id}/download_info?file_type=mp4`.
3. Reject a source larger than 512 MiB before consuming download quota. Also
   enforce a 2 GiB aggregate source budget for the run.
4. Call `GET /v2/{account_id}/resources/{id}/download?file_type=mp4` without a
   resize request. The free API does not support dynamic video resizing.
5. Count every formal download API call against a process-wide hard budget of
   four, regardless of its HTTP outcome.
6. Stream the returned signed URL directly to a `.part` file, atomically rename
   it after transfer, and never expose the URL in logs or persisted objects.
7. If transfer fails after a signed URL was issued, retry the same signed URL
   with bounded backoff. Do not request a second signed URL automatically.
8. Compute SHA-256 and inspect the finished file with `ffprobe` before recording
   the download.

If the endpoint returns `download_status_url`, poll only that provider-supplied
status URL until completion, terminal failure, or timeout. Polling does not
increase the formal download counter. The client stores attribution requirements
and stable attribution URLs when returned, but never a media URL.

### 6. Local FFmpeg renderer

Create one run directory and keep all generated files inside it:

```text
artifacts/video-runs/<render-id>/
  assets/
    scene-01.mp4
    scene-02.mp4
    scene-03.mp4
    scene-04.mp4
  normalized/
    scene-01.mp4
    scene-02.mp4
    scene-03.mp4
    scene-04.mp4
  subtitles.ass
  manifest.json
  contact-sheet.jpg
  final.mp4
```

The entire `artifacts/` tree is ignored by Git.

Normalize every selected clip to 1920x1080, square pixels, 30 fps, and a common
time base. Scale to fill and center-crop rather than letterbox. Source audio is
discarded. A short source may loop; a long source is trimmed from a reviewed
in-point.

Use four 7.95-second normalized scenes with 0.60-second crossfades. The resulting
timeline is exactly 30 seconds:

```text
4 * 7.95 seconds - 3 * 0.60 seconds = 30.00 seconds
```

Generate a low-level pink-noise ambient bed locally, filter it into a restrained
frequency range, and fade it in and out. Burn an ASS subtitle file with two-line
English and Chinese captions inside a 10% title-safe margin. The quote scene also
shows a smaller movie title, release year, and source timestamp.

Encode the final file with:

- H.264, CRF 18, medium preset;
- `yuv420p` pixel format;
- AAC stereo at 192 kbps and 48 kHz;
- `+faststart` for local preview and future upload compatibility.

Record the exact FFmpeg and ffprobe versions, stable command options, and output
hash in the manifest. Do not put secrets, absolute paths, signed URLs, or raw
provider responses in the manifest.

### 7. Private production-metadata Edge Function

Add `video-production-metadata`, authenticated through the existing
`x-subtitle-token` helper before request parsing or database access. It exposes
six actions:

- `start`: create or return an idempotent render job and its UUID;
- `recordDownload`: insert one verified source download after the local file is
  complete;
- `beginRender`: require four verified downloads and move the job to
  `rendering`;
- `complete`: atomically insert the four timeline segments, write final output
  metadata, and move the job to `completed`;
- `fail`: write a controlled failure code and move a non-terminal job to
  `failed`;
- `retry`: clear controlled failure fields and return the same failed job to
  `planned`, preserving its verified download rows.

The function uses service-role-only SQL RPCs for state transitions. Requests
contain stable metadata only. The function rejects URL-shaped artifact keys and
rejects any unrecognized fields so a signed provider URL cannot be persisted by
mistake. `recordDownload` accepts a selection ID but does not trust a caller-
supplied provider or resource ID; its RPC resolves both values through the
selected candidate and stores that authoritative snapshot.

## Database Design

### `video_render_jobs`

- `id uuid primary key default gen_random_uuid()`
- `request_digest text not null unique`
- `theme text not null` limited to 300 characters
- `status text not null` constrained to `planned`, `downloading`, `rendering`,
  `completed`, or `failed`
- `target_width integer not null default 1920`
- `target_height integer not null default 1080`
- `target_fps integer not null default 30`
- `target_duration_ms integer not null default 30000`
- `output_artifact_key text null`
- `output_sha256 text null`
- `output_size_bytes bigint null`
- `output_duration_ms integer null`
- `video_codec text null`
- `audio_codec text null`
- `pixel_format text null`
- `ffmpeg_version text null`
- `manifest_sha256 text null`
- `failure_code text null`
- `failure_message text null` limited to 500 characters
- `created_at timestamptz not null default now()`
- `completed_at timestamptz null`

Constraints require positive dimensions, frame rate, duration, and byte counts;
lowercase 64-character hexadecimal SHA-256 values; relative artifact keys; and
complete output fields only when status is `completed`. Failed jobs require a
controlled failure code and no `completed_at`.

### `video_asset_downloads`

- `id bigint generated always as identity primary key`
- `render_id uuid not null references public.video_render_jobs(id)`
- `selection_id bigint not null unique references public.video_asset_selections(id)`
- `provider text not null default 'vecteezy'`
- `provider_resource_id bigint not null`
- `artifact_key text not null`
- `file_type text not null default 'mp4'`
- `source_size_bytes bigint not null`
- `source_sha256 text not null`
- `width integer not null`
- `height integer not null`
- `duration_ms integer not null`
- `frame_rate double precision not null`
- `video_codec text not null`
- `audio_codec text null`
- `requires_attribution boolean not null`
- `required_attribution_url text null`
- `quota_limit integer null`
- `quota_remaining integer null`
- `downloaded_at timestamptz not null default now()`

Use a unique `(render_id, provider_resource_id)` constraint in addition to the
unique selection, plus unique `(render_id, id)` to support an ownership foreign
key from timeline segments. Require exactly `vecteezy`, positive technical
values, an MP4 file type, valid SHA-256, and a stable relative artifact key.
Attribution URL is the only allowed URL field and is accepted only when
attribution is required. There is deliberately no download-URL column.

### `video_render_segments`

- `id bigint generated always as identity primary key`
- `render_id uuid not null references public.video_render_jobs(id) on delete cascade`
- `segment_index integer not null` constrained to 0-3
- `download_id bigint not null`
- `timeline_start_ms integer not null`
- `timeline_end_ms integer not null`
- `source_in_ms integer not null`
- `source_out_ms integer not null`
- `caption_kind text not null` constrained to `original` or `quote`
- `caption_en text not null`
- `caption_zh text not null`
- `source_track_id bigint null`
- `source_cue_index integer null`
- `created_at timestamptz not null default now()`

Create unique `(render_id, segment_index)`, a composite ownership foreign key
from `(render_id, download_id)` to `video_asset_downloads(render_id, id)`, and a
composite source foreign key from `(source_track_id, source_cue_index)` to
`subtitle_cues(track_id, cue_index)`. Original segments require both source
columns to be null. The one quote segment requires both to be non-null. A
completion RPC verifies exactly four contiguous segment indices and exactly one
quote segment before marking the render complete. It also verifies that the
quote segment's English caption exactly equals the referenced subtitle cue, so
the production record cannot silently alter retrieved dialogue.

### Indexes, RLS, and privileges

Index every foreign-key column that is not already the leading column of a
unique index. Add partial indexes for non-terminal jobs and completed jobs by
creation time only if the CLI query path needs them.

Enable and force RLS on all three tables. Create no policies for `anon` or
`authenticated`. Revoke table, sequence, and RPC access from `public`, `anon`,
and `authenticated`; grant only the required operations to `service_role` and
`postgres`. Use qualified object names, `security invoker`, and an empty
`search_path` for RPCs.

## Local Command Contract

Expose one operator command after the metadata schema and download client are
implemented:

```powershell
npx tsx src/video-pipeline.ts produce \
  --theme "Crossing darkness toward dawn" \
  --quote-query "hope after hardship, moving through darkness toward dawn, resilience and a new beginning" \
  --quote-zh "<reviewed Chinese translation>" \
  --candidate-count 8 \
  --max-downloads 4
```

The first run remains interactive at two review points:

1. show the selected quote source and require confirmation of the exact English
   cue and reviewed Chinese translation;
2. show candidate metadata and local preview references for each scene, then
   require one resource selection per scene before formal downloads.

For agent-driven acceptance, the operator can supply reviewed quote and
selection IDs through a generated local run-input file. That file is ignored by
Git and contains no secrets or signed URLs.

The command prints progress, IDs, counts, quota headers, file names, and
controlled failures. It never prints full subtitle chunks, secrets, model
prompts, raw provider responses, or signed URLs.

## Idempotency and Recovery

- The render request digest covers a versioned canonical theme, quote source,
  storyboard, target specification, and selected candidate IDs.
- Re-running a completed request returns the existing render record and verifies
  local hashes instead of downloading or rendering again.
- Re-running an active request reads `manifest.json`, verifies each existing
  source hash, and continues from the first missing stage. A failed request must
  use the explicit `retry` action before it can resume under the same UUID.
- A completed local source file with a matching download row is reused.
- A `.part` file is never considered complete and may be resumed only if the
  provider response supports byte ranges; otherwise it is replaced before the
  signed URL expires.
- `recordDownload` is idempotent by selection ID and rejects conflicting hashes.
- `complete` is idempotent for identical segment and output metadata and rejects
  conflicting terminal data.
- OpenSubtitles quota exhaustion is recorded in local execution output, not as a
  failed video-render job.
- Vecteezy `402` and `403` responses are terminal for that selected resource.
  The command does not silently spend another formal download without renewed
  operator approval.

## Security and Rights Boundaries

- Use only the official OpenSubtitles and Vecteezy APIs under the user's own
  configured accounts and permissions.
- Downloaded subtitle and media files remain ignored and local.
- Treat the one movie quote as private research output. Do not expose complete
  subtitle files or long dialogue passages in logs, tests, or Git.
- Keep `OPENSUBTITLES_*`, `VECTEEZY_*`, `SUBTITLE_PERSONAL_TOKEN`, publishable
  keys, and any local access token in `.env` or Supabase secrets as appropriate.
- Do not put provider secrets in Edge Function request bodies.
- The plaintext Ollama test endpoint receives only generic visual concepts and
  original scene descriptions. It never receives exact movie dialogue,
  provider credentials, candidate payloads, or download metadata.
- Because the Vecteezy secret was previously shared in conversation, rotate it
  before using this workflow outside the current controlled test.
- Preserve attribution metadata. The final manifest and database must identify
  any resource that requires attribution, even though the first output remains
  local.

## Failure Handling

### Corpus expansion

- Quota, rate, or daily-limit responses stop the expansion loop cleanly.
- Authentication or configuration errors stop immediately with no further
  provider calls.
- A per-film missing subtitle or parse failure is recorded and skipped.
- The video path continues against all already-ready tracks.

### Quote retrieval

- An empty corpus or no usable exact cue stops before Vecteezy download.
- Search and embedding failures return controlled errors without exposing
  database or inference details.
- Translation remains a review gate; the pipeline does not invent a Chinese
  translation when none is supplied.

### Candidate search and download

- Fewer than five candidates for a scene sends that scene back for a revised
  generic concept before formal download.
- Missing MP4, excessive size, or failed preview review causes reselection, not
  a formal download call.
- The formal download counter is incremented before the provider request and
  cannot exceed four.
- A signed-URL transfer retries only the same URL. Expiration requires explicit
  operator approval before another quota-consuming call.

### Rendering and metadata

- `ffprobe` rejects unreadable, audio-only, zero-duration, or implausibly small
  source files before normalization.
- FFmpeg failures preserve inputs and a sanitized local error summary, then mark
  the job `failed`.
- Metadata completion occurs only after all source hashes and final validation
  pass.
- A failed metadata write never deletes a valid local final video; the same
  manifest can retry the idempotent write.

## Testing Strategy

Implementation follows test-driven development.

### Unit tests

- Quote-cue filtering, relaxation, tie-breaking, and source preservation.
- Storyboard schema, exactly four scenes, and exactly one quote scene.
- Vecteezy download-info and download response normalization.
- Process-wide formal download budget and increment-before-request behavior.
- Signed URL redaction from logs, database payloads, and manifests.
- Streaming `.part` handling, atomic completion, checksum verification, and
  idempotent reuse.
- ffprobe JSON parsing and invalid-source rejection.
- ASS escaping, bilingual line layout, source credit formatting, and title-safe
  margins.
- FFmpeg argument generation, exact transition offsets, muted source audio,
  ambient-audio generation, and stable output options.
- Manifest validation and resumable stage selection.

### Database tests

Use pgTAP to cover table shapes, check constraints, composite source foreign
keys, foreign-key indexes, forced RLS, absent browser policies, grants, legal
state transitions, one quote segment, four contiguous segments, idempotent
download recording, and atomic completion.

### Edge Function tests

- Authenticate before parsing or database access.
- Validate action-specific unions and reject unknown fields.
- Reject URL-shaped artifact keys, malformed hashes, and inconsistent terminal
  metadata.
- Map controlled conflicts, invalid transitions, and database failures without
  leaking internals.

### Local integration tests

Use generated test videos and mocked HTTP rather than provider quota. Run the
real local FFmpeg to normalize four synthetic clips, crossfade, burn bilingual
ASS captions, synthesize audio, and produce a deterministic valid container.

### Hosted acceptance

The final acceptance run may consume real provider quotas only after all mocked
and local integration tests pass. It performs the approved corpus expansion,
quote search, four candidate reviews, no more than four formal Vecteezy download
calls, one local render, and private metadata writes.

## Acceptance Criteria

The work is complete when one run demonstrates all of the following:

- The OpenSubtitles importer attempted new classic films until it reached the
  current provider limit, candidate exhaustion, or an explicit configuration
  stop, and preserved resume state.
- Hosted counts were measured after expansion. Any newly imported tracks are
  `ready` and their chunks have embeddings.
- Quote search used every ready film and selected one exact timestamped cue with
  movie provenance.
- Four Vecteezy search runs each retained 5-10 candidates and one reviewed
  selection.
- The process made at most four formal Vecteezy download calls and stored no
  signed media URL.
- Every downloaded source has matching local and database SHA-256 values.
- `final.mp4` is 1920x1080, 30 fps, between 29 and 31 seconds, H.264 `yuv420p`,
  and contains an AAC audio stream.
- Four visual sections are present, the bilingual text remains inside title-safe
  bounds, the movie source is legible, and sampled frames are non-black.
- `video_render_jobs`, `video_asset_downloads`, and `video_render_segments`
  contain a consistent completed record whose output hash matches the local
  file.
- `manifest.json`, `subtitles.ass`, `contact-sheet.jpg`, and `final.mp4` remain
  local and ignored by Git.
- Database security and performance advisors show no new issues caused by this
  schema.

## Rollout Sequence

1. Add database tests, the three private tables, state-transition RPCs, and
   metadata Edge Function.
2. Add quote selection and storyboard contracts with unit tests.
3. Add the local Vecteezy download client and hard quota budget with mocked
   tests.
4. Add ffprobe inspection, ASS generation, FFmpeg rendering, manifests, and
   local integration tests.
5. Add the resumable `video-pipeline produce` orchestrator and documentation.
6. Deploy migration and metadata Edge Function to the linked hosted project.
7. Run the OpenSubtitles expansion until the provider stop condition.
8. Retrieve and review the exact quote and Chinese translation.
9. Search, review, select, and formally download four Vecteezy resources.
10. Render, verify, inspect the contact sheet, and write final metadata.

## Non-Goals

- Running FFmpeg inside a Supabase Edge Function
- Uploading source clips or the final video to Supabase Storage
- Fully automatic visual approval or vision-model scoring
- Sending movie dialogue to the plaintext Ollama endpoint
- Generating narration or using a text-to-speech service
- Training or fine-tuning on Vecteezy assets or metadata
- Publishing the result or granting browser access to private records
- Automatically spending more than four Vecteezy downloads
- Replacing the existing subtitle, montage, or candidate-search APIs
