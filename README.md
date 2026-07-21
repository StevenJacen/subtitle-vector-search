# Private Subtitle Semantic Search

This is a private, English-only subtitle research tool. It parses authorized `.srt` or `.vtt` files locally, stores source cues and normalized `gte-small` embeddings in a private Supabase project, and returns ranked dialogue with exact timestamps.

Only import subtitles you are authorized to possess and use for personal research. This repository does not provide subtitle files, and its seed data is wholly synthetic.

## Requirements

- Node.js and npm
- Supabase CLI
- Docker Desktop for local Supabase testing
- A Supabase project you control for hosted use
- Optional OpenSubtitles credentials for the `download` command

The current pipeline accepts English subtitle tracks only. It does not translate, detect, or search non-English subtitle content.

## Environment

Create `.env` from `.env.example` and set the following values for the project you intend to use:

```dotenv
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<publishable-key>
SUBTITLE_PERSONAL_TOKEN=<long-random-secret>
OPENSUBTITLES_API_KEY=<opensubtitles-api-key>
OPENSUBTITLES_TOKEN=<opensubtitles-user-token>
OPENSUBTITLES_USER_AGENT=private-subtitle-search v1.0
```

`OPENSUBTITLES_API_KEY`, `OPENSUBTITLES_TOKEN`, and `OPENSUBTITLES_USER_AGENT` are required only when using `subtitle download`. Obtain and use OpenSubtitles credentials in accordance with its terms and your account permissions. Keep `.env`, database passwords, and personal tokens out of source control.

### Video Candidate Matching Configuration

The Vecteezy matching workflow uses server-only Edge Function secrets. Do not put
these values in a browser, CLI request, commit, or client-side application:

```dotenv
VECTEEZY_ACCOUNT=<account-id>
VECTEEZY_API_KEY=<api-key>
AI_INFERENCE_API_HOST=https://<authenticated-ollama-gateway>
OLLAMA_MODEL=gemma4:12b
VIDEO_PLANNER_TRANSPORT=supabase-ai
OLLAMA_GATEWAY_SECURITY_CONFIRMED=true
```

Before enabling hosted inference, an unauthenticated `GET /api/tags` must return HTTP 401 or 403 from `AI_INFERENCE_API_HOST`. A public response means the gateway is not ready: keep hosted inference disabled and fix its authentication. Never bypass this gate for production.

The `supabase-ai` transport instantiates `Supabase.ai.Session('gemma4:12b')`
directly; this code path does not itself read `AI_INFERENCE_API_HOST` or
`OLLAMA_MODEL`, and its hosted compatibility with `AI_INFERENCE_API_HOST` is not
yet proven. Keep hosted inference disabled until both the security gate and the
hosted compatibility spike pass.

The direct authenticated fallback is available only for a protected Ollama
endpoint. The `ollama-http` transport explicitly consumes
`AI_INFERENCE_API_HOST`, `OLLAMA_AUTH_TOKEN`, and `OLLAMA_MODEL`:

```dotenv
VIDEO_PLANNER_TRANSPORT=ollama-http
OLLAMA_AUTH_TOKEN=<bearer-token>
```

For an internal test gateway with explicit approval for unauthenticated calls,
omit `OLLAMA_AUTH_TOKEN` and set this server-only exception:

```dotenv
VIDEO_PLANNER_TRANSPORT=ollama-http
OLLAMA_ALLOW_UNAUTHENTICATED_TEST_GATEWAY=true
```

Never enable this test exception in production or for a publicly accessible
Ollama service. It only controls whether the direct transport sends a Bearer
header; all normal request authentication and response sanitization remain in
place.

A local `GET /api/tags` check is not sufficient for hosted compatibility:
verify the gateway from a deployed Edge Function as well. A tunnel or proxy
that returns a `text/html` interstitial to Supabase instead of Ollama JSON will
cause the planner to use the deterministic visual-concept fallback.

## Local Testing

Local Supabase uses Docker. The seed adds one synthetic ready track with three synthetic cues and two normalized 384-dimensional vectors; it never adds real subtitle dialogue.

```powershell
npm install
npx supabase start
npx supabase db reset
npx supabase test db
npm test
npm run typecheck
```

To exercise both Edge Functions locally, set a non-production token in the current PowerShell session and start the functions:

```powershell
$env:SUBTITLE_PERSONAL_TOKEN='local-test-token'
npx supabase functions serve --no-verify-jwt
```

In a second PowerShell session, an invalid custom token must receive HTTP 401 from both routes:

```powershell
Invoke-WebRequest -Method Post -Uri http://127.0.0.1:54321/functions/v1/ingest-subtitles -Headers @{ 'x-subtitle-token' = 'wrong-token' } -ContentType 'application/json' -Body '{"action":"start"}'
Invoke-WebRequest -Method Post -Uri http://127.0.0.1:54321/functions/v1/search-subtitles -Headers @{ 'x-subtitle-token' = 'wrong-token' } -ContentType 'application/json' -Body '{"query":"lantern"}'
```

Both commands are expected to report a 401 response. Do not use a hosted token for local testing.

## Remote Deployment

Remote deployment changes hosted project state. Link the CLI to a Supabase project you control before running the commands below, and set the local CLI environment values required by your project. The Edge Runtime receives `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from Supabase; set the separate personal token as a function secret.

```powershell
npm install
npx supabase login
npx supabase link --project-ref kwoppqigrtvgmmbnzbpx
npx supabase db push
npx supabase secrets set SUBTITLE_PERSONAL_TOKEN=<random-secret>
npx supabase functions deploy ingest-subtitles --no-verify-jwt
npx supabase functions deploy search-subtitles --no-verify-jwt
npx supabase functions deploy movie-quote-montage --no-verify-jwt
npx supabase functions deploy hybrid-subtitle-search --no-verify-jwt
npx supabase functions deploy seed-visual-concepts --no-verify-jwt
npx supabase functions deploy match-video-assets --no-verify-jwt
npx supabase functions deploy select-video-asset --no-verify-jwt
npx tsx src/cli.ts import <authorized-file.srt> --title "The Shawshank Redemption" --year 1994 --imdb tt0111161 --source manual
npx tsx src/cli.ts search "hope during hard times"
```

Migrations must be pushed before any function is deployed. The project ref above is the target project for this workflow; substitute a different ref only when intentionally deploying elsewhere. Remote deployment compilation is mandatory because local Deno semantic checking is not available in every Node development environment.

Verify the linked migration state and run hosted database advisors after deployment:

```powershell
npx supabase migration list
npx supabase db lint --linked --level warning
```

The schema and Edge Functions are deployed to the project above. Deployment does not import subtitle content; import only English subtitle files you are authorized to retain and use.

## Video Candidate Matching

`match-video-assets` turns a stored chunk, supplied text, or a theme into 5-10
Vecteezy video candidates for manual selection. It uses exactly three English
search query kinds: `literal`, `action`, and `metaphor`. Candidate counts are in
the inclusive range 5-10; use the default of eight unless a review needs a
smaller or larger short list.

Push the matching migration before deploying any of its functions. Then set the
server-only values above with `npx supabase secrets set`, deploy in this exact
order, and seed the private fallback concepts once:

```powershell
npx supabase db push
npx supabase functions deploy seed-visual-concepts --no-verify-jwt
npx supabase functions deploy match-video-assets --no-verify-jwt
npx supabase functions deploy select-video-asset --no-verify-jwt

0..23 | ForEach-Object {
  Invoke-RestMethod -Method Post `
    -Uri "https://kwoppqigrtvgmmbnzbpx.supabase.co/functions/v1/seed-visual-concepts?index=$_" `
    -Headers @{ 'x-subtitle-token' = $env:SUBTITLE_PERSONAL_TOKEN } `
    -ContentType 'application/json' `
    -Body '{}'
}
```

The loop intentionally generates one native `gte-small` embedding per Edge
invocation to stay within the hosted compute budget. Every indexed upsert is
idempotent, so rerunning the complete loop is safe.

Use a generic synthetic visual theme or non-sensitive context in requests. Do
not send real movie dialogue as ad hoc text. This request returns an idempotent
run and temporary previews for review; retrying the same request reuses the
persisted result rather than repeating planning and provider search:

```powershell
$match = Invoke-RestMethod -Method Post `
  -Uri https://kwoppqigrtvgmmbnzbpx.supabase.co/functions/v1/match-video-assets `
  -Headers @{ 'x-subtitle-token' = $env:SUBTITLE_PERSONAL_TOKEN } `
  -ContentType 'application/json' `
  -Body '{"theme":"a fresh start after uncertainty","candidateCount":8}'

Invoke-RestMethod -Method Post `
  -Uri https://kwoppqigrtvgmmbnzbpx.supabase.co/functions/v1/select-video-asset `
  -Headers @{ 'x-subtitle-token' = $env:SUBTITLE_PERSONAL_TOKEN } `
  -ContentType 'application/json' `
  -Body ("{`"runId`":`"{0}`",`"providerResourceId`":{1},`"note`":`"selected after manual review`"}" -f $match.runId, $match.candidates[0].providerResourceId)
```

Inspect private matching records in the Supabase Dashboard with a service-role
administrator only: `visual_concepts`, `video_search_runs`,
`video_search_queries`, `video_search_candidates`, and
`video_asset_selections`. These tables have forced RLS and are not a public API.
The selection endpoint records one manual selection for a run and replaces a
previous selection atomically.

This phase does not call a Vecteezy download endpoint, does not fetch media,
does not store preview URLs, and does not train on Vecteezy material. It only
persists stable candidate metadata and the selected provider resource ID.

### Rollback and deactivation

To stop the workflow immediately, stop calling the two matching endpoints or
delete the `match-video-assets` and `select-video-asset` deployments; the
subtitle search endpoints remain independent. Use a reviewed follow-up
migration to remove the five private matching tables and their RPCs only when
their audit records are no longer needed. Do not call Vecteezy media or download
routes as part of rollback.

## Local Video Workbench

The localhost workbench combines continuous subtitle retrieval, bilingual
planning, incremental Vecteezy review, explicit selection confirmation, silent
FFmpeg rendering, task history, and recovery in one operational interface. It
binds only to `127.0.0.1`; provider credentials and temporary provider URLs stay
inside the Node control service and are never returned to the browser.

Set the existing Supabase, Vecteezy, and Ollama values plus these local values
in `.env`:

```dotenv
AI_INFERENCE_API_HOST=http://<approved-internal-ollama-host>
OLLAMA_MODEL=qwen3:30b
WORKBENCH_PORT=4173
WORKBENCH_ARTIFACT_ROOT=artifacts
WORKBENCH_FONT_PATH=C:\Windows\Fonts\msyh.ttc
WORKBENCH_FIXTURE_MODE=0
```

The approved internal Ollama endpoint uses plaintext HTTP and receives the
exact ordered English cues selected for the video. The status bar keeps this
warning visible. Use this exception only for the explicitly approved test
endpoint; use authenticated HTTPS before sending sensitive dialogue anywhere
else.

Start the development interface or the built interface:

```powershell
npm run workbench:dev

npm run workbench:build
npm run workbench:start
```

The server prints the actual loopback URL and moves to the next available port
if the configured port is occupied. Health checks verify Supabase, the selected
Ollama model, Vecteezy account access, FFmpeg, ffprobe, the font, and disk space.
The Vecteezy health check uses an ordinary search and never calls the formal
download endpoint.

Creating a task selects 5-10 consecutive cues from one ready subtitle track and
loads exactly eight review candidates per scene. `Load more` appends up to eight
deduplicated candidates and preserves prior pages and selections. Candidate
search, preview, selection, and confirmation consume no formal download quota.
Production remains disabled until every scene has one current explicit
confirmation; there is no automatic confirmation.

Starting production reserves and performs one formal Vecteezy download for each
confirmed scene, so the initial set consumes 5-10 formal calls. A replacement
after a deterministic source rejection can use only the task's remaining
capacity, and no task can exceed ten formal calls; a 10-scene task therefore has
no replacement capacity. Only one production run executes at a time in the
local process. Other review tasks remain available in history. A retryable
failure can be reopened from history and resumed; uncertain provider
reservations fail closed rather than silently spending another formal call.

Version-2 files remain local under:

```text
artifacts/video-runs/<task-id>/manifest-v2.json
artifacts/video-runs/<task-id>/review-state.json
artifacts/video-runs/<task-id>/sources/
artifacts/video-runs/<task-id>/subtitles.ass
artifacts/video-runs/<task-id>/final.mp4
```

The final MP4 is H.264, `yuv420p`, 30 fps, and has no audio stream. The workflow
does not add music, ambience, narration, TTS, or a Storage upload.

Before using the real workbench, apply the additive v2 migration and deploy the
three changed Edge Functions in this order:

```powershell
npx supabase db push --linked
npx supabase functions deploy subtitle-passages --no-verify-jwt
npx supabase functions deploy match-video-assets --no-verify-jwt
npx supabase functions deploy video-production-metadata --no-verify-jwt
```

The v2 schema, RPCs, API actions, manifests, and renderer are additive. Existing
v1 `video plan`, `video produce`, and `video resume` commands and completed v1
manifests remain unchanged.

For browser verification, install Chromium once and run the test-only fixture:

```powershell
npx playwright install chromium
npm run test:e2e
```

`WORKBENCH_FIXTURE_MODE=1` is accepted only with `NODE_ENV=test`; production
startup rejects that combination before reading credentials. The fixture makes
no Supabase, Ollama, or Vecteezy request.

## Local Video Production

This resumable workflow keeps every source clip, review file, subtitle file,
render, contact sheet, manifest, and retry record under ignored `artifacts/`.
There is no Storage upload: media remains on the trusted operator machine. The
three private metadata tables are `video_render_jobs`, `video_asset_downloads`,
and `video_render_segments`.

Remote-only migration and database testing are required for this workflow.
Review the linked project before applying changes, then run the dry run,
migration, focused database test, and metadata deployment in this order:

```powershell
npx supabase db push --dry-run --linked
npx supabase db push --linked
npx supabase test db --linked supabase/tests/database/video_production.sql
npx supabase db query --linked --file supabase/tests/database/video_production.sql
npx supabase functions deploy video-production-metadata --no-verify-jwt
```

The `db query` form is the Docker-free fallback for CLI builds where linked
`test db` still invokes a local container. The test transaction temporarily
enables pgTAP and rolls back the extension together with all fixture rows.

Local rendering requires `ffmpeg` and `ffprobe` on `PATH`, plus the Microsoft
YaHei font at the renderer's configured Windows font path. Set the existing
Supabase, subtitle token, Vecteezy, and planner environment values in `.env`.
The plan command requires only `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and
`SUBTITLE_PERSONAL_TOKEN`; produce and resume also require `VECTEEZY_ACCOUNT`
and `VECTEEZY_API_KEY`.

Create a plan with the approved generic theme:

```powershell
$plan = npm run --silent video -- plan --theme "Crossing darkness toward dawn" --candidate-count 8 --json | ConvertFrom-Json
```

The command emits one path-only JSON object and writes the same pointer to
`artifacts/latest-plan.json`. Planning searches the private subtitle index,
protects the exact quote so it is never trimmed or rewritten, and creates four
generic visual searches. It sends no dialogue to Ollama. Plan does not consume
any Vecteezy download quota and makes no formal download request.

Open the generated `review-candidates.json` beside `$plan.reviewPath`, inspect
its temporary previews locally, and fill the strict `review-input.json` with a
reviewed Chinese quote translation, one listed resource ID per scene, a review
note, and a nonnegative source in-point. Review must finish before `produce`.
Do not paste signed or status URLs into the input.

```powershell
npm run video -- produce --manifest $plan.manifestPath --review $plan.reviewPath --max-downloads 4
```

The production contract has a hard exactly-four-download budget. The runner
records four manual selections and starts one idempotent render job to learn the
existing status before any download-info preflight. An existing completed job
short-circuits with zero Vecteezy provider calls. For a fresh job, download-info
preflight validates sizes and attribution before local render ownership or any
formal provider call. A fresh preflight rejection restores the local plan to
editable review so the operator can replace the candidate and rerun `produce`;
the already-created remote job may remain failed as an audit record. Only after
preflight succeeds does the runner permit at most four formal provider calls.
Matching local hashes are reused.
An uncertain transfer reservation fails closed and requires a new reviewed plan, not resume,
so the run can never silently spend the reservation again. A render failure preserves verified
source files for resume, and a completed local manifest is immutable even when
remote completion needs another attempt.

In a later PowerShell session, resume from the current render-owned path rather
than guessing a UUID:

```powershell
$active = Get-Content -Raw artifacts/latest-plan.json | ConvertFrom-Json
npm run video -- resume --manifest $active.manifestPath
```

### Rollback and deactivation

Stop `video produce` and `video resume`, then delete or deactivate the
`video-production-metadata` function deployment. Existing local files remain
under ignored `artifacts/` and are not uploaded. Remove `video_render_segments`,
`video_asset_downloads`, and `video_render_jobs` only through a reviewed
follow-up migration after their audit records are no longer required. The
subtitle search and candidate matching workflows remain independent.

## Movie Quote Montage

`movie-quote-montage` accepts an English theme and returns a deterministic montage of exact stored subtitle chunks. It limits how many chunks can come from one movie, so a single title does not dominate the result. The `copy` field joins the selected chunks with blank lines; it is retrieved dialogue, not newly generated prose.

The Edge Function generates the query vector inside Supabase with `new Supabase.ai.Session('gte-small')`, using the same normalized 384-dimensional model as the stored chunks. No external embedding API is required.

After pushing the migration and deploying the function, test a theme such as `love and time` with the existing private token:

```powershell
Invoke-RestMethod -Method Post `
  -Uri https://kwoppqigrtvgmmbnzbpx.supabase.co/functions/v1/movie-quote-montage `
  -Headers @{ 'x-subtitle-token' = $env:SUBTITLE_PERSONAL_TOKEN } `
  -ContentType 'application/json' `
  -Body '{"theme":"love and time","quoteCount":8,"matchThreshold":0.72,"maxPerMovie":1}'
```

The response includes `copy` plus source metadata for every selected chunk: movie title, release year, timestamps, chunk indexes, and similarity score. Raise `matchThreshold` for stricter matches or lower it when the result set is empty.

## Hybrid RRF Experiment

`hybrid-subtitle-search` is an isolated all-Supabase experiment based on the
official Supabase hybrid-search pattern. PostgreSQL retrieves one candidate list
with English full-text search and another with the existing `gte-small` cosine
vectors, then combines their ranks with Reciprocal Rank Fusion (RRF). The
existing `search-subtitles` endpoint remains unchanged as the vector-only
baseline.

The initial experiment fixes these RPC controls:

```text
full_text_weight = 1
semantic_weight = 2
rrf_k = 50
```

The higher semantic weight prevents short literal phrases from overwhelming
strong thematic matches. These values are experimental and should be changed
only after comparing returned dialogue.

After pushing the migration and deploying `hybrid-subtitle-search`, call both
endpoints with the same private token and request body:

```powershell
$body = '{"query":"love and time","limit":12}'
$vector = Invoke-RestMethod -Method Post `
  -Uri https://kwoppqigrtvgmmbnzbpx.supabase.co/functions/v1/search-subtitles `
  -Headers @{ 'x-subtitle-token' = $env:SUBTITLE_PERSONAL_TOKEN } `
  -ContentType 'application/json' `
  -Body $body
$hybrid = Invoke-RestMethod -Method Post `
  -Uri https://kwoppqigrtvgmmbnzbpx.supabase.co/functions/v1/hybrid-subtitle-search `
  -Headers @{ 'x-subtitle-token' = $env:SUBTITLE_PERSONAL_TOKEN } `
  -ContentType 'application/json' `
  -Body $body
```

Hybrid results include the normal `similarity`, source, timestamps, text, and
cues plus three diagnostics. `rrfScore` is the final fused score;
`semanticRank` is the candidate's vector rank; and `fullTextRank` is its keyword
rank. Either rank can be `null` when the candidate appeared in only one of the
two bounded candidate lists.

The experiment is independently reversible. Stop calling or delete the
`hybrid-subtitle-search` deployment, then use a reviewed follow-up migration to
drop `public.hybrid_match_subtitle_chunks`, `subtitle_chunks_fts_gin_idx`, and
`public.subtitle_chunks.fts`. Do not run ad-hoc destructive SQL as part of the
normal deployment workflow. `search-subtitles` remains available throughout.

The CLI can also retrieve a subtitle through the official OpenSubtitles API when your credentials and rights permit it:

```powershell
npx tsx src/cli.ts download --imdb 0111161 --output downloads/authorized.srt
npx tsx src/cli.ts import downloads/authorized.srt --title "Authorized Title" --year 2026 --imdb tt0000001 --source opensubtitles --source-ref opensubtitles:42
npx tsx src/cli.ts search "quiet determination" --limit 10
npx tsx src/cli.ts search "quiet determination" --movie-id 7
```

To add a large classic-film batch, use the resumable importer. It uses the
ranked candidate pool in `data/classic-movie-candidates.json`, stores downloaded
subtitle files under ignored `downloads/classics`, and writes resume progress to
ignored `.batch-state/classic-import-state.json`.

```powershell
npx tsx src/batch-classics.ts --target 200
```

If OpenSubtitles returns a daily quota or rate-limit response, the command stops
cleanly. Rerun the same command later to continue from the saved state.

Search output is compact and timestamped:

```text
0.842  00:42:13.120 --> 00:42:18.900
The matching dialogue text...
```

## Privacy And Data Lifecycle

All subtitle tables use forced row-level security with no policies for `anon` or `authenticated`. Direct table, sequence, and `match_subtitle_chunks` access is revoked from public roles; only the Edge Functions' service role can read and write subtitle data after custom-token authentication. Search fetches only the exact cue interval for each ranked chunk, never an entire track.

Back up only data you are entitled to retain. For a hosted project, an operator can export the private tables with a protected database URL:

```powershell
pg_dump --data-only --table=public.movies --table=public.subtitle_tracks --table=public.subtitle_cues --table=public.subtitle_chunks "$env:DATABASE_URL" > subtitle-backup.sql
```

Deleting a movie cascades to its tracks, cues, embeddings, and chunk claims:

```sql
delete from public.movies where imdb_id = 'tt0111161';
```

Use the movie ID or a more specific predicate when removing content. Verify the selected rows before running destructive SQL.

## Troubleshooting

- **Docker is unavailable:** `npx supabase start`, `db reset`, `test db`, and local function serving require Docker Desktop with a running engine. Start Docker Desktop, verify `docker version`, then rerun the local workflow.
- **Function secret missing:** set `SUBTITLE_PERSONAL_TOKEN` with `npx supabase secrets set SUBTITLE_PERSONAL_TOKEN=<random-secret>`, redeploy both functions, and use that same value in the CLI `.env` file.
- **HTTP 401:** confirm the request sends `x-subtitle-token`, the value exactly matches the function secret, and the function deployment is the intended project. The Supabase publishable key does not replace this custom token.
- **OpenSubtitles HTTP 429:** wait for the `Retry-After` duration and retry within your account quota. The client retries bounded transient responses, but it cannot override provider limits.
- **Model dimension error:** this project requires `gte-small` embeddings with `mean_pool: true`, `normalize: true`, and exactly 384 finite numeric dimensions. Do not mix vectors from another model or change the vector column dimension.
- **No matching dialogue found:** this is a successful search with no ranked results. An `empty_ready_track` API error means the requested movie has no finalized ready subtitle track; import authorized English subtitles and finalize the track first.
