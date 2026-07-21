# Subtitle Library Workbench Design

## Goal

Add a first-class subtitle library view to the existing local video workbench.
The operator can search English subtitle dialogue with an English quote or a
Chinese theme, start a video task from an exact result, and synchronize new
movies from OpenSubtitles without returning to the CLI.

## Scope

- Add `Video production` and `Subtitle library` views to the existing React
  workbench without changing its loopback-only security boundary.
- Search the existing private Supabase subtitle index through the deployed
  hybrid-search Edge Function.
- Normalize Chinese searches into a concise English query through the approved
  Ollama endpoint. If normalization times out, search the original query and
  display a non-blocking degradation notice.
- Preserve the selected result's track and cue range when creating a video.
  Expand around that anchor to the requested 5-10 consecutive scenes instead
  of running another global passage search.
- Add one resumable synchronization job with automatic and manual modes.
- Do not add authentication for a public deployment in this change. The server
  continues to bind only to `127.0.0.1`, and secrets never enter browser JSON.

## User Interface

The status bar remains the first row. A compact two-tab navigation sits below
it:

- `Video production` preserves the current task rail, creation toolbar, review,
  production, recovery, and final output behavior.
- `Subtitle library` uses an operational table-like result list. Its toolbar
  contains the search input, result-count selector, Search command, library
  counts, and `Sync new movies` command.

Each search result shows movie title, release year, timestamp, English dialogue,
and its overall, semantic, and full-text ranks. Rank labels are shown instead
of a fabricated percentage. `Create from this quote` switches to video
production and submits the current aspect ratio and scene count with an exact
track/cue anchor.

The synchronization panel has two modes:

- Automatic continues through the classic candidate list until the provider
  quota is reached, the candidate list is exhausted, or the operator stops it.
- Manual accepts title, release year, and an IMDb ID matching `tt` plus digits,
  then imports exactly that movie.

The panel shows the current movie, attempted/succeeded/failed counts, the latest
message, and the terminal reason. Only one synchronization job can run in the
process. A page refresh reloads the latest persisted snapshot. The Stop command
is cooperative and finishes the current network/database operation before
stopping.

## Architecture

### Browser API

Add these same-origin endpoints to the local control service:

- `POST /api/subtitles/search`
- `GET /api/subtitles/library`
- `GET /api/subtitles/sync`
- `POST /api/subtitles/sync`
- `POST /api/subtitles/sync/stop`
- `GET /api/subtitles/sync/events`

All mutation endpoints retain the existing boot-token and same-origin checks.
Inputs and outputs are strict, bounded JSON contracts. Provider credentials,
provider URLs, local paths, and raw upstream errors are never returned.

### Search Service

The local service detects Han characters. English input is sent directly to
`hybrid-subtitle-search`; Chinese input is normalized through Ollama with
`stream: false`, JSON output, and thinking disabled. A bounded timeout falls
back to the original query and returns a warning. Search results are validated
before they reach the browser.

The server also loads ready movie/track counts for the library summary without
granting browser access to private tables. A new `subtitle-library` Edge
Function exposes only sanitized aggregate counts behind the existing personal
token authentication; it uses the service role internally and does not add Data
API grants or public RLS policies.

### Anchored Passage Selection

Extend the additive `subtitle-passages` contract with an optional source anchor:
track ID plus first and last cue indexes. The Edge Function validates that the
track is ready, loads enough neighboring cues, and uses the existing continuous
passage rules to return exactly the requested 5-10 scenes from that movie. The
existing theme-only request remains unchanged.

The workbench task input and request digest include the optional anchor. This
keeps retries idempotent and records the real subtitle provenance in the v2
manifest.

### Synchronization Service

Refactor the existing batch importer around one reusable `syncMovie` operation
and structured progress callbacks. The CLI keeps its current behavior. The
workbench service owns a single in-process controller, persists a sanitized
snapshot beside the existing batch state, and publishes progress through an
SSE event bus.

Automatic mode skips candidates already recorded as successful or failed and
stops cleanly on OpenSubtitles quota/authentication errors. Manual mode uses the
same download, parse, chunk, batch-ingest, embedding, and finalize path. Failed
imports call the existing fail action. No partial track is reported as ready.

## Error Handling

- Empty or oversized search queries return controlled 400 errors.
- A failed Chinese normalization produces a warning and original-query search.
- Invalid upstream search payloads return a controlled 502 error.
- Duplicate sync starts return 409 without launching another job.
- Invalid manual metadata returns 400 before any provider request.
- Provider quota produces a successful terminal `quota_reached` state.
- Authentication/configuration failures produce a terminal `configuration_error`.
- Unexpected per-movie failures are recorded and automatic mode continues.
- Stopping is cooperative and produces `stopped`; it never interrupts a database
  batch halfway through.

## Security

- Keep all Supabase, OpenSubtitles, and Ollama credentials in the Node process.
- Reuse the current loopback binding, origin checks, CSP, and mutation token.
- Do not expose downloaded subtitle files or local state paths.
- Treat movie titles and provider messages as untrusted text.
- Keep imported subtitle rights status as `personal_research`.

## Verification

- Unit tests cover search parsing, result validation, Chinese fallback, anchored
  request digests, automatic/manual synchronization, quota stop, cooperative
  stop, and snapshot recovery.
- HTTP tests cover every endpoint, mutation authorization, conflicts, SSE, and
  response redaction.
- React tests cover navigation, search results, degraded translation, exact
  result creation, automatic sync, manual validation, progress, and stopping.
- Edge Function tests cover backward compatibility and anchored passage bounds.
- Playwright covers English search, a selected quote creating the exact source
  task, and both synchronization modes with fixtures only.
- Run the full Vitest suite, typecheck, production build, Playwright, linked
  pgTAP where applicable, Supabase advisors, and live read-only search smoke.
  Do not consume a formal Vecteezy download during verification.
