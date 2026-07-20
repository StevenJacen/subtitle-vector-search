# Local Video Workbench Design

## Status

Approved in conversation on 2026-07-21. Implementation has not started.

## Goal

Provide a local browser workbench that turns a theme into one reviewed,
resumable movie-quote montage without requiring a Codex conversation. The
workbench finds a continuous subtitle passage, translates it, creates one
visual scene per cue, collects incremental Vecteezy candidates, requires an
explicit selection for every scene, and renders a silent bilingual video with
local FFmpeg.

## Confirmed Product Decisions

- The UI is a React and Vite single-page application backed by a local Node
  control service.
- The workbench binds to localhost and operates on one active task at a time.
- A task accepts a theme, an aspect ratio (`9:16` or `16:9`), and a scene count
  from 5 through 10.
- All scenes come from 5-10 consecutive subtitle cues in one movie and one
  subtitle track.
- Every cue lasts at least 1.2 seconds. The sum of cue durations must be 15-60
  seconds.
- One cue maps to one visual scene, and its exact subtitle duration determines
  the scene's timeline interval.
- The existing remote Ollama endpoint translates the exact dialogue and derives
  generic visual concepts. The user explicitly accepted that this endpoint is
  unauthenticated plaintext HTTP.
- Each scene starts with eight Vecteezy candidates. Loading more appends another
  eight candidates and preserves prior results and selections.
- Every scene requires an explicit user selection. Formal downloads and render
  production remain disabled until all scenes are confirmed.
- Formal Vecteezy download count equals scene count and is capped at ten per
  task. Candidate search and preview do not consume formal download quota.
- The first version produces no background music, ambient track, narration, or
  source audio. The output contains no audio stream.
- All source media and rendered media remain local and ignored by Git.
- Existing completed version-1 four-scene renders remain readable and
  resumable; the workbench uses a version-2 production contract.

## Non-Goals

- Batch task creation or scheduling
- Fully automatic asset selection
- Music or sound-effect search
- Text-to-speech narration
- Supabase Storage upload or remote media hosting
- Mobile rendering or FFmpeg execution in an Edge Function
- Changing or paraphrasing the English subtitle text

## Architecture

### Browser Application

The React application owns presentation and user intent only. It displays
health, passage results, candidate previews, confirmation state, production
progress, history, and final playback. It never receives provider API keys,
Supabase service-role credentials, signed download URLs, or raw Ollama payloads.

### Local Control Service

A Node service owns the trusted process boundary. It:

- serves the built Vite application;
- exposes a narrow localhost JSON API and an SSE progress stream;
- reuses the existing subtitle, Vecteezy, artifact, probe, and FFmpeg modules;
- calls Supabase Edge Functions with the personal subtitle token;
- calls Ollama and validates its structured output;
- proxies allowlisted preview media for browser display;
- reads and writes only registered paths beneath `artifacts/`;
- serializes the single active task and supports deterministic resume.

The service binds only to `127.0.0.1`. It creates a random session token when it
starts, embeds that token into the initially served application, validates the
request origin, and requires the token on every mutating endpoint. This limits
cross-site requests and localhost DNS-rebinding abuse.

### Hosted Supabase

Supabase remains the private source of truth for subtitle retrieval, candidate
search runs, selections, formal-download metadata, render segments, and final
output metadata. Edge Functions authenticate the existing custom subtitle token
before parsing request bodies or creating service-role clients.

### External Providers

- OpenSubtitles remains an offline corpus-ingestion source and is not called by
  normal workbench video creation.
- Ollama translates the selected passage and creates generic visual concepts.
- Vecteezy supplies candidate metadata, previews, and confirmed formal source
  downloads.
- FFmpeg and ffprobe execute only on the local machine.

## User Workflow

### 1. Health Check

The status bar probes Supabase, Ollama, Vecteezy account information, FFmpeg,
ffprobe, required fonts, and local disk space. It shows the Vecteezy account
quota without exposing credentials. The Ollama status explicitly warns that
exact dialogue is sent over unauthenticated HTTP.

### 2. Create Task

The user enters:

- a theme;
- aspect ratio `9:16` or `16:9`;
- scene count from 5 through 10.

The initial candidate count is fixed at eight per scene. The first version does
not expose render codec controls or an arbitrary duration input.

### 3. Select A Continuous Passage

The service performs full-corpus vector search and treats each high-ranking
chunk as an anchor. It expands anchors into windows of exactly the requested
cue count and keeps only windows that:

- belong to one ready track and one movie;
- contain consecutive cue indices;
- preserve each `subtitle_cues.text` value exactly;
- contain no empty, speaker-label-only, or sound-effect-only cue;
- have a duration of at least 1.2 seconds per cue;
- total 15-60 seconds when cue durations are summed.

Windows are ordered deterministically by parent similarity, theme-word coverage
across the passage, completeness penalties, movie ID, track ID, starting cue
index, and ending cue index. The selected passage records canonical movie,
track, cue, millisecond, timestamp, and text metadata before translation.

### 4. Translate And Derive Visual Concepts

Ollama receives the ordered exact English cue array. It must return a strict JSON
array with the same number and order of entries. Each item contains:

- one Chinese translation;
- one generic English visual concept;
- optional generic mood, action, setting, and lighting terms.

The English cue is never accepted back from Ollama and can therefore never be
rewritten by the model. Visual concepts must not contain the movie title,
character names, provider URLs, the exact English cue, or the Chinese
translation. Invalid or incomplete output stops before Vecteezy search.

### 5. Build Incremental Candidate Pools

Each scene starts with one Vecteezy search that requests eight candidates. The
candidate pool stores stable metadata plus the owning search `runId`; preview
references remain in ignored local state.

`Load more` issues the next provider search page, appends eight results, and
deduplicates by provider and resource ID. Previously loaded candidates and the
current selection remain stable. If a newly appended candidate ranks higher,
the recommendation marker may move, but confirmation never moves
automatically. A candidate selected from a later page is confirmed through its
own originating `runId`.

Candidate ranking considers theme relevance, per-cue visual relevance, aspect
ratio, orientation, usable MP4 variants, license type, AI-generation flag, and
stable provider rank. Preview inspection consumes no formal download quota.

### 6. Confirm Selections

The UI requires exactly one confirmed resource per scene. Replacing a selection
clears confirmation for that scene. Production remains disabled until all
scene confirmations are current and every selected resource still belongs to a
known candidate page.

### 7. Produce And Resume

After confirmation, the service computes a canonical version-2 request digest,
starts or attaches to the remote render job, preflights every selected resource,
and reserves at most `sceneCount` formal calls. It downloads, probes, and hashes
one source per scene before rendering.

The progress view reports controlled stages: starting, preflight, downloading,
probing, rendering, validating, completing metadata, and completed. A later
browser session discovers the current manifest and resumes without repeating
confirmed selections or verified downloads.

## Timeline And Rendering

Let each cue duration be `end_ms - start_ms`. Cue timeline boundaries are the
cumulative sum of those durations, so the final duration is exactly the sum of
the selected cue durations.

Scene source media is normalized to the selected aspect ratio:

- `16:9`: 1920x1080 at 30 fps;
- `9:16`: 1080x1920 at 30 fps.

The renderer uses center-safe cover cropping by default and bounded motion only
when it does not expose blank pixels. Crossfades do not shorten the output:
non-final sources receive transition handles, and xfade offsets are placed at
the cumulative cue boundaries. Transition duration is bounded by the shorter
adjacent cue and never exceeds 400 ms.

ASS events use the same cumulative cue boundaries. Every scene displays the
exact English cue, its generated Chinese translation, and a compact movie/year
and source timestamp line inside a 10 percent title-safe margin. Portrait and
landscape layouts use separate font sizes and vertical placement.

All source audio is discarded. The final MP4 contains H.264 `yuv420p` video and
no audio stream.

## Versioned Local Artifacts

Version-1 manifests remain immutable and continue through their current parser
and resume path. Workbench tasks use a version-2 manifest containing:

- task and render ownership IDs;
- theme, aspect ratio, requested scene count, and render settings;
- canonical passage and all cue source metadata;
- translations and generic visual concepts;
- paginated candidate references in a separate ignored review-state file;
- confirmed selection IDs and provider resource IDs;
- formal reservations and verified source hashes;
- final output metadata and manifest hash;
- current resumable stage and controlled failure state.

Candidate preview URLs and signed/status URLs are never included in the durable
manifest. Atomic writes, path registration, completed-manifest immutability, and
hash-based resume continue to apply.

## Supabase Version-2 Contract

The existing version-1 rows and RPC behavior remain valid. New migrations add a
version-2 production path rather than retroactively invalidating the completed
four-scene render.

Version 2 uses separate `start_video_render_v2`,
`record_video_asset_download_v2`, `begin_video_render_v2`,
`complete_video_render_v2`, `fail_video_render_v2`, and
`retry_video_render_v2` RPCs. The metadata Edge Function exposes corresponding
version-2 actions. Existing version-1 actions and RPCs remain unchanged for
old-manifest resume and audit compatibility.

Version-2 render metadata records:

- workflow version;
- aspect ratio and dimensions;
- requested scene count;
- source track ID and starting/ending cue indices;
- expected total duration;
- nullable audio codec for silent output.

Version-2 completion requires:

- 5-10 downloads owned by the render;
- 5-10 segment indices exactly equal to `0..N-1`;
- every segment to reference a cue;
- all cues to share one track and have consecutive cue indices;
- every English caption to equal the referenced `subtitle_cues.text` exactly;
- every segment duration to equal the referenced cue duration;
- segment timeline boundaries to be contiguous and start at zero;
- output duration to equal the final segment end within the probe tolerance;
- H.264 `yuv420p` output with the selected dimensions and no audio codec.

RLS remains forced. No `anon` or `authenticated` table policy or RPC execution
grant is added. Production writes continue through the authenticated metadata
Edge Function.

## Local HTTP Interface

The intended API surface is:

```text
GET    /api/health
GET    /api/tasks
POST   /api/tasks
GET    /api/tasks/:taskId
GET    /api/tasks/:taskId/events
POST   /api/tasks/:taskId/scenes/:sceneIndex/candidates
PUT    /api/tasks/:taskId/scenes/:sceneIndex/selection
POST   /api/tasks/:taskId/produce
POST   /api/tasks/:taskId/resume
GET    /api/tasks/:taskId/final
GET    /api/previews/:previewId
```

Task IDs and preview IDs are opaque UUIDs. Routes never accept arbitrary local
paths or arbitrary proxy URLs.

## Interface Design

The first screen is the operational workbench, not a landing page.

- A compact top status bar shows provider and local-runtime health.
- A left task rail lists local history and the active task.
- The create toolbar contains theme, aspect-ratio segmented control, scene-count
  stepper, and one clear create command.
- The passage area shows movie, year, source range, total duration, and ordered
  bilingual cues.
- Scene rows show cue timing and an eight-item candidate grid with video
  previews, metadata, recommendation state, selection state, and `Load more`.
- The produce command remains disabled until all rows are confirmed.
- Production replaces candidate controls with stable stage progress without
  changing the page's major geometry.
- Completion shows an inline video player, source attribution summary, output
  path, formal-call count, and integrity metadata.
- Failures show controlled messages and a resume action when recovery is safe.

The palette is neutral and work-focused, candidate media carries most of the
color, cards are limited to repeated candidate items, and sections remain
unframed. Controls use icons, segmented controls, steppers, and tooltips where
appropriate. Desktop is the primary viewport, but all text and controls remain
usable on a narrow browser window.

## Failure And Recovery Rules

- Passage, translation, and candidate-search failures consume no formal
  Vecteezy downloads and are retryable.
- Provider exhaustion preserves current candidate pools and offers another
  search only when a next page exists.
- An incomplete confirmation set cannot enter preflight or production.
- Preflight rejection returns the affected scene to selection without a formal
  call.
- A formal reservation is durable before the provider request. An uncertain
  reservation is never silently spent again.
- Transfer failure retains completed files and audit metadata. It does not
  automatically select or formally download a replacement.
- Render failure reuses all verified sources on resume.
- Metadata-completion failure preserves the final output and retries only the
  idempotent completion request.
- Browser output and server logs contain no credentials, signed URLs, raw
  provider responses, or full Ollama prompts.

## Verification Strategy

### Unit And Contract Tests

- deterministic continuous-passage window selection;
- 5 and 10 scene boundaries, 1.2 second cue minimum, and 15-60 second total;
- exact cue preservation and strict Ollama response parsing;
- candidate pagination, append, deduplication, owning-run selection, and
  confirmation invalidation;
- formal budget concurrency for 5-10 calls;
- artifact versioning, path containment, URL redaction, and resume stages;
- silent-media probe validation and dynamic ASS timing.

### Database And Edge Tests

- version-1 compatibility;
- version-2 RLS, grants, state transitions, and idempotency;
- dynamic 5-10 download and segment gates;
- same-track consecutive cues and exact text equality;
- exact segment timing and silent output metadata;
- authentication before JSON parsing and stable controlled errors.

### Real FFmpeg Tests

- five-scene landscape render;
- ten-scene portrait render;
- exact cumulative duration within probe tolerance;
- correct dimensions, 30 fps, H.264, `yuv420p`, and no audio stream;
- non-black sampled frames, safe captions, and no layout overlap.

### Browser Tests

Playwright verifies health states, task creation, passage display, both aspect
ratios, scene-count bounds, initial eight candidates, repeated load-more,
deduplication, confirmation gating, selection replacement, progress events,
failure resume, history reopening, final playback, and desktop/narrow layouts.

## Acceptance Criteria

A user can start the local service, open the workbench, enter a theme, choose an
aspect ratio and 5-10 scenes, review one continuous bilingual movie passage,
incrementally inspect eight candidates per scene, confirm one candidate for
every scene, and produce a silent video without a Codex conversation. The final
duration equals the cumulative cue duration, all English captions equal hosted
cue text, the final metadata is consistent locally and in Supabase, and failed
work resumes without hidden provider calls.
