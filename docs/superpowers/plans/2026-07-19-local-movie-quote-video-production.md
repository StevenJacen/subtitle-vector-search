# Local Movie-Quote Video Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the hosted subtitle corpus to the current OpenSubtitles limit, retrieve one exact thematic movie cue, match and formally download four reviewed Vecteezy clips, and render one verified bilingual 30-second video locally while recording stable production metadata in private Supabase tables.

**Architecture:** Supabase remains the private source of truth for subtitle retrieval, Vecteezy candidate searches, selections, and production audit records. A local TypeScript pipeline owns quote selection, review state, formal provider downloads, ffprobe/FFmpeg work, hashes, and resumable artifacts; a custom-token-authenticated Edge Function mediates every production metadata write. Source clips and final media remain local and ignored by Git.

**Tech Stack:** TypeScript 7, Node.js 22+, Commander 15, Vitest 4, Supabase Edge Runtime/Deno, `@supabase/supabase-js` 2.110.2, PostgreSQL 17, pgTAP, Supabase AI `gte-small`, Ollama `gemma4:12b`, Vecteezy API V2, FFmpeg/ffprobe N-120402.

## Global Constraints

- Work in `D:\Project\subtitle\.worktrees\subtitle-vector-search` on the existing `agent/subtitle-vector-search` branch; do not create another worktree.
- Use remote Supabase project `kwoppqigrtvgmmbnzbpx` directly with `--linked`; do not require Docker or a local Supabase stack.
- Follow strict red-green-refactor: every production behavior starts with a focused failing test, then the minimum implementation, then focused and full verification.
- Keep `@supabase/supabase-js` pinned to `2.110.2` in Edge imports and add no npm dependency.
- Authenticate `video-production-metadata` with `SUBTITLE_PERSONAL_TOKEN` / `x-subtitle-token` before parsing JSON or creating a service-role client.
- Force RLS on all three production tables, create no `anon` or `authenticated` policies, and grant data/RPC access only to `service_role` and `postgres`.
- Keep source clips, final media, subtitle files, manifests, run-input files, and provider preview captures in ignored local directories.
- Never persist or log Vecteezy signed download URLs, status URLs, API secrets, raw provider payloads, absolute local paths, or model prompts.
- Count every call to Vecteezy `/download` against a hard process-wide budget of four before issuing the request; retries may reuse only the same signed URL.
- Do not request Vecteezy dynamic resizing. Download MP4 source files after `download_info`, with a 512 MiB per-file and 2 GiB aggregate source limit.
- Never send exact movie dialogue, Chinese quote translations, Vecteezy metadata, or credentials to the plaintext Ollama test endpoint. Ollama receives only original generic scene descriptions.
- Preserve the retrieved English quote exactly as one `subtitle_cues.text` value; the completion RPC must compare it to the referenced `(track_id, cue_index)`.
- Render production output at 1920x1080, 30 fps, 30 seconds, H.264 CRF 18 `yuv420p`, AAC stereo 192 kbps/48 kHz, with four 7.95-second scenes and three 0.60-second crossfades.
- Use `Microsoft YaHei` from `C:\Windows\Fonts\msyh.ttc` for Chinese ASS subtitles and keep text inside a 10% title-safe margin.
- Commit code and tests after each task. Never commit ignored media, `.env`, `.batch-state`, `downloads`, or `artifacts`.

## File Map

- `supabase/migrations/*_video_production.sql`: three private tables, ownership constraints, state transitions, idempotency, and six service-role RPCs.
- `supabase/tests/database/video_production.sql`: linked-project pgTAP coverage for schema, RLS, grants, transitions, exact quote preservation, and atomic completion.
- `supabase/functions/_shared/video-production.ts`: strict action contracts and controlled production errors.
- `supabase/functions/_shared/video-production-repository.ts`: typed service-role RPC adapter.
- `supabase/functions/_shared/video-production-handler.ts`: authenticated action dispatch and stable HTTP errors.
- `supabase/functions/_shared/video-asset-repository.ts`: map the new locked-selection SQLSTATE without exposing database details.
- `supabase/functions/_shared/video-asset-selection.ts`: return a stable 409 when a downloaded selection is immutable.
- `supabase/functions/video-production-metadata/index.ts`: pinned Edge entry and service-role dependency creation.
- `src/video-production-api.ts`: authenticated local client for candidate matching, selection, and metadata actions.
- `src/quote-selection.ts`: deterministic exact-cue selection from full-corpus search results.
- `src/storyboard.ts`: fixed four-scene bilingual storyboard and generic visual descriptions.
- `src/vecteezy-download.ts`: V2 download-info/formal-download client, hard budget, polling, signed-URL transfer, and quota headers.
- `src/video-artifacts.ts`: safe relative artifact keys, run directories, SHA-256, atomic JSON, and resume manifests.
- `src/media-probe.ts`: ffprobe process boundary and validated media metadata.
- `src/ass-subtitles.ts`: bilingual ASS generation and exact quote source line.
- `src/video-renderer.ts`: normalization, crossfades, ambient audio, final encoding, black-frame check, and contact sheet.
- `src/video-pipeline-runner.ts`: injected orchestration for plan/review/produce/resume stages.
- `src/video-pipeline.ts`: Commander entry for operator commands.
- `tests/video-production-migration-static.test.ts`: migration shape, privilege, ownership, and no-URL static checks.
- `tests/video-production-contract.test.ts`: Edge action union and strict field validation.
- `tests/video-production-handler.test.ts`: auth ordering, RPC dispatch, and error mapping.
- `tests/video-production-entry-static.test.ts`: pinned imports and service-role creation after authentication.
- `tests/video-asset-selection.test.ts`: downloaded-selection lock response and existing selection regression coverage.
- `tests/video-production-api.test.ts`: local Edge response validation and request contract.
- `tests/quote-selection.test.ts`: preferred/relaxed quote rules and deterministic ordering.
- `tests/storyboard.test.ts`: four scenes, one quote, generic visual inputs, and bilingual copy.
- `tests/vecteezy-download.test.ts`: budget, provider parsing, limits, polling, redaction, and transfer recovery.
- `tests/video-artifacts.test.ts`: safe paths, atomic manifests, hashes, URL rejection, and resume state.
- `tests/media-probe.test.ts`: ffprobe parsing and invalid-source/final-output checks.
- `tests/ass-subtitles.test.ts`: ASS escaping, timing, font, safe margins, and source formatting.
- `tests/video-renderer.test.ts`: exact FFmpeg filters/options and a small real-FFmpeg integration render.
- `tests/video-pipeline.test.ts`: complete mocked stage order, review stop, resume, failure, and no-repeat-download behavior.
- `tests/deployment-docs.test.ts`: remote-only deployment order and operator safety documentation.
- `.gitignore`: ignore `artifacts/`.
- `package.json`: add the `video` operator script.
- `README.md`: production setup, commands, review gate, deployment, quota, recovery, and acceptance SQL.

---

### Task 1: Private Video Production Schema And RPCs

**Files:**
- Create: `supabase/migrations/*_video_production.sql` using `npx supabase migration new video_production`
- Create: `supabase/tests/database/video_production.sql`
- Create: `tests/video-production-migration-static.test.ts`

**Interfaces:**
- Consumes: `subtitle_cues(track_id, cue_index)`, `video_asset_selections(id)`, selected candidates, and service-role RPC calls.
- Produces: `video_render_jobs`, `video_asset_downloads`,
  `video_render_segments`, six production RPCs, and a hardened
  `select_video_asset` that freezes downloaded selections.

- [ ] **Step 1: Write the failing static migration tests**

Create a migration resolver matching exactly one `_video_production.sql` file and add these assertions:

```typescript
const tables = ['video_render_jobs', 'video_asset_downloads', 'video_render_segments']
const functions = [
  'start_video_render',
  'record_video_asset_download',
  'begin_video_render',
  'complete_video_render',
  'fail_video_render',
  'retry_video_render',
]

for (const table of tables) {
  expect(source).toContain(`create table public.${table}`)
  expect(source).toContain(`alter table public.${table} enable row level security`)
  expect(source).toContain(`alter table public.${table} force row level security`)
  expect(source).toContain(`revoke all on table public.${table} from public, anon, authenticated`)
}
for (const name of functions) {
  expect(source).toContain(`create function public.${name}`)
}
expect(source.match(/security invoker/g)).toHaveLength(7)
expect(source.match(/set search_path = ''/g)).toHaveLength(7)
expect(source).toContain('foreign key (render_id, download_id)')
expect(source).toContain('references public.video_asset_downloads(render_id, id)')
expect(source).toContain('foreign key (selection_id, candidate_id)')
expect(source).toContain('create or replace function public.select_video_asset')
expect(source).not.toMatch(/download_url|signed_url|status_url/i)
```

Expect seven `security invoker` and seven empty-search-path declarations: six
new production RPCs plus the replacement selection RPC.

- [ ] **Step 2: Run the static test and verify RED**

Run: `npm test -- tests/video-production-migration-static.test.ts`

Expected: FAIL because no video-production migration exists.

- [ ] **Step 3: Generate and implement the migration**

Run: `npx supabase migration new video_production`

Create the three tables with the exact columns and checks from the approved design. Use these state and ownership definitions:

```sql
status text not null check (status in ('planned', 'downloading', 'rendering', 'completed', 'failed')),
request_digest text not null unique check (request_digest ~ '^[0-9a-f]{64}$'),
constraint video_asset_downloads_render_id_id_key unique (render_id, id),
constraint video_asset_downloads_selection_candidate_fkey
  foreign key (selection_id, candidate_id)
  references public.video_asset_selections(id, candidate_id)
  on update restrict,
constraint video_render_segments_render_download_fkey
  foreign key (render_id, download_id)
  references public.video_asset_downloads(render_id, id),
constraint video_render_segments_source_cue_fkey
  foreign key (source_track_id, source_cue_index)
  references public.subtitle_cues(track_id, cue_index)
```

Add `candidate_id bigint not null` to `video_asset_downloads` and unique
`(id, candidate_id)` to `video_asset_selections`. Add checks for positive
dimensions, frame rates, durations, and byte counts; lowercase SHA-256; exactly
`vecteezy` and `mp4`; null-paired source columns; `caption_kind in
('original','quote')`; relative non-URL artifact keys; and completed/failed field
consistency. Index `video_asset_downloads(render_id)`,
`video_asset_downloads(candidate_id)`, `video_render_segments(render_id)`,
`video_render_segments(download_id)`, and the nullable composite quote source.

Implement the six new RPCs and replace `select_video_asset`; all seven use
`security invoker set search_path = ''`:

```text
start_video_render       insert planned or return existing by request_digest
record_video_asset_download resolve provider/resource through selection_id;
                            insert once or return exact existing row; reject conflicts
begin_video_render       require exactly four verified downloads; set rendering
complete_video_render    require rendering, four segment indices 0..3, one quote,
                            owned downloads, exact cue text, valid output; insert
                            segments and mark completed in one transaction
fail_video_render        reject completed jobs; set failed and controlled message
retry_video_render       require failed; clear failure fields; return to planned
select_video_asset       preserve replacement until a selection is referenced by
                            a download; then raise P0007 selection_locked
```

Use controlled SQLSTATE values `P0002` for not found, `P0003` for invalid
transition, `P0004` for idempotency conflict, `P0005` for incomplete production
data, `P0006` for quote mismatch, and `P0007` for a downloaded selection that is
locked. Revoke every table, sequence, and RPC from `public`, `anon`, and
`authenticated`; grant only the minimum service-role table/sequence access and
RPC execution to `service_role, postgres`.

- [ ] **Step 4: Write linked-project pgTAP coverage before deployment**

Create `supabase/tests/database/video_production.sql` with a transaction-scoped
synthetic render, candidate, selection, and cue. Assert table/RPC existence,
forced RLS, no browser policies, function privilege revocation, foreign-key
indexes, start idempotency, download idempotency/conflict, downloaded-selection
locking, four-download gate, exact quote comparison, atomic completion,
failed-to-retry transition, and completed terminality.

Use explicit test plans and rollback:

```sql
begin;
select plan(36);
select has_table('public', 'video_render_jobs');
select has_function('public', 'complete_video_render', array['uuid', 'jsonb', 'jsonb']);
select * from finish();
rollback;
```

The actual test must create IDs through SQL CTEs and the temporary table rather
than hardcoding generated IDs. Its changed-quote assertion calls
`complete_video_render` with the stored render/track/cue IDs and expects SQLSTATE
`P0006` before rollback.

- [ ] **Step 5: Verify local static coverage**

Run: `npm test -- tests/video-production-migration-static.test.ts`

Expected: PASS.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 6: Commit the schema task**

```powershell
git add supabase/migrations supabase/tests/database/video_production.sql tests/video-production-migration-static.test.ts
git commit -m "feat: add private video production schema"
```

---

### Task 2: Production Metadata Edge Function

**Files:**
- Create: `supabase/functions/_shared/video-production.ts`
- Create: `supabase/functions/_shared/video-production-repository.ts`
- Create: `supabase/functions/_shared/video-production-handler.ts`
- Create: `supabase/functions/video-production-metadata/index.ts`
- Modify: `supabase/functions/_shared/video-asset-repository.ts`
- Modify: `supabase/functions/_shared/video-asset-selection.ts`
- Create: `tests/video-production-contract.test.ts`
- Create: `tests/video-production-handler.test.ts`
- Create: `tests/video-production-entry-static.test.ts`
- Modify: `tests/video-asset-selection.test.ts`

**Interfaces:**
- Consumes: six strict JSON action variants, shared constant-time auth, a service-role Supabase client, and the six Task 1 RPCs.
- Produces: `parseVideoProductionRequest`, `VideoProductionRepository`, `handleVideoProductionRequest`, and private `POST /functions/v1/video-production-metadata`.

- [ ] **Step 1: Write failing action-contract tests**

Define tests around this exact discriminated union:

```typescript
export type VideoProductionRequest =
  | { action: 'start'; requestDigest: string; theme: string }
  | ({ action: 'recordDownload'; renderId: string; selectionId: number } & DownloadMetadata)
  | { action: 'beginRender'; renderId: string }
  | { action: 'complete'; renderId: string; segments: RenderSegmentInput[]; output: RenderOutputInput }
  | { action: 'fail'; renderId: string; failureCode: string; failureMessage: string }
  | { action: 'retry'; renderId: string }
```

Use one valid fixture per action. Assert unknown keys, URL-shaped artifact keys, absolute paths, signed/status/download URL key names at any depth, malformed UUID/SHA-256, nonpositive media values, more or fewer than four segments, wrong segment indices, missing quote source, quote source on original copy, and failure text over 500 characters are rejected with `VideoProductionError(400, 'invalid_request', 'invalid request')`.

- [ ] **Step 2: Run contract tests and verify RED**

Run: `npm test -- tests/video-production-contract.test.ts`

Expected: FAIL because the shared production module does not exist.

- [ ] **Step 3: Implement strict contracts and stable types**

Export these stable metadata shapes:

```typescript
export interface DownloadMetadata {
  artifactKey: string
  fileType: 'mp4'
  sourceSizeBytes: number
  sourceSha256: string
  width: number
  height: number
  durationMs: number
  frameRate: number
  videoCodec: string
  audioCodec: string | null
  requiresAttribution: boolean
  requiredAttributionUrl: string | null
  quotaLimit: number | null
  quotaRemaining: number | null
}

export interface RenderSegmentInput {
  segmentIndex: 0 | 1 | 2 | 3
  downloadId: number
  timelineStartMs: number
  timelineEndMs: number
  sourceInMs: number
  sourceOutMs: number
  captionKind: 'original' | 'quote'
  captionEn: string
  captionZh: string
  sourceTrackId: number | null
  sourceCueIndex: number | null
}

export interface RenderOutputInput {
  artifactKey: string
  outputSha256: string
  outputSizeBytes: number
  outputDurationMs: number
  videoCodec: string
  audioCodec: string
  pixelFormat: string
  ffmpegVersion: string
  manifestSha256: string
}
```

Implement exact-key allowlists per action, depth-first forbidden-key scanning,
`https:`-only stable attribution URLs, relative forward-slash artifact keys
under `video-runs/d62a53a1-08fb-4bee-a1ed-d8ba13de85f2/` in contract fixtures,
and finite safe-number checks. Production validation requires `video-runs/`, a
valid UUID path segment, and a nonempty relative file suffix. Never accept
provider or provider-resource fields in `recordDownload`; the RPC resolves them
from `selectionId`.

- [ ] **Step 4: Write failing repository and handler tests**

Test each action's exact RPC name and snake_case payload. Test SQLSTATE mapping and prove auth occurs before `request.json()` and before repository construction:

```typescript
const response = await handleVideoProductionRequest(incoming, environment, createRepository)
expect(response.status).toBe(401)
expect(json).not.toHaveBeenCalled()
expect(createRepository).not.toHaveBeenCalled()
```

Expected production mappings are `404 render_not_found`, `409
invalid_render_state`, `409 metadata_conflict`, `422 incomplete_render`, `422
quote_mismatch`, and stable `500 production_metadata_failed`. Add a repository
mapping from SQLSTATE `P0007` to
`VideoAssetError(409, 'selection_locked', 'selected asset is already downloaded')`
and make the existing selection handler return that exact controlled 409. Raw
database details must never appear in response text.

- [ ] **Step 5: Run handler tests and verify RED**

Run: `npm test -- tests/video-production-handler.test.ts tests/video-production-entry-static.test.ts tests/video-asset-selection.test.ts`

Expected: FAIL because repository, handler, and entry are absent.

- [ ] **Step 6: Implement repository, handler, and pinned entry**

Define one repository method per RPC:

```typescript
export interface VideoProductionRepository {
  start(input: Extract<VideoProductionRequest, { action: 'start' }>): Promise<{ renderId: string; status: string; isExisting: boolean }>
  recordDownload(input: Extract<VideoProductionRequest, { action: 'recordDownload' }>): Promise<{ downloadId: number }>
  beginRender(renderId: string): Promise<{ status: 'rendering' }>
  complete(input: Extract<VideoProductionRequest, { action: 'complete' }>): Promise<{ status: 'completed' }>
  fail(input: Extract<VideoProductionRequest, { action: 'fail' }>): Promise<{ status: 'failed' }>
  retry(renderId: string): Promise<{ status: 'planned' }>
}
```

The Edge entry must pin runtime types and `npm:@supabase/supabase-js@2.110.2`, delegate to `handleVideoProductionRequest`, and create the service-role client only inside the authenticated callback. The handler returns only IDs and statuses, not stored captions or provider metadata.

- [ ] **Step 7: Verify Edge code**

Run: `npm test -- tests/video-production-contract.test.ts tests/video-production-handler.test.ts tests/video-production-entry-static.test.ts tests/video-asset-selection.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit the Edge task**

```powershell
git add supabase/functions/_shared/video-production.ts supabase/functions/_shared/video-production-repository.ts supabase/functions/_shared/video-production-handler.ts supabase/functions/_shared/video-asset-repository.ts supabase/functions/_shared/video-asset-selection.ts supabase/functions/video-production-metadata/index.ts tests/video-production-contract.test.ts tests/video-production-handler.test.ts tests/video-production-entry-static.test.ts tests/video-asset-selection.test.ts
git commit -m "feat: add private video production metadata API"
```

---

### Task 3: Local Private Edge Client

**Files:**
- Create: `src/video-production-api.ts`
- Create: `tests/video-production-api.test.ts`

**Interfaces:**
- Consumes: Supabase URL, publishable key, personal token, existing
  `search-subtitles`, `match-video-assets`, and `select-video-asset` endpoints,
  the new metadata endpoint, injected `fetch`, and injected delay.
- Produces: `VideoProductionApi.matchScene`, `selectCandidate`, `start`, `recordDownload`, `beginRender`, `complete`, `fail`, and `retry` with runtime-validated responses.

- [ ] **Step 1: Write failing local client tests**

Assert exact URLs and headers:

```typescript
expect(fetchFn).toHaveBeenCalledWith(
  'https://project.supabase.co/functions/v1/match-video-assets',
  expect.objectContaining({
    method: 'POST',
    headers: {
      apikey: 'publishable-key',
      'x-subtitle-token': 'personal-token',
      'content-type': 'application/json',
    },
  }),
)
```

Cover all eight methods, candidate response validation, selection response validation, metadata status validation, malformed successful payloads, structured Edge errors, two retries for network/429/5xx only, and no retry for other 4xx responses.

- [ ] **Step 2: Run client tests and verify RED**

Run: `npm test -- tests/video-production-api.test.ts`

Expected: FAIL because `src/video-production-api.ts` does not exist.

- [ ] **Step 3: Implement the minimum authenticated client**

Use the existing `SubtitleApi` request behavior without refactoring it. Define three endpoint URLs in the constructor and keep response validators local:

```typescript
import type { VideoAssetMatchResponse as SceneMatchResponse } from '../supabase/functions/_shared/video-assets.js'
import type {
  DownloadMetadata,
  RenderOutputInput,
  RenderSegmentInput,
} from '../supabase/functions/_shared/video-production.js'

export interface RenderStatusResponse {
  renderId: string
  status: 'planned' | 'downloading' | 'rendering' | 'completed' | 'failed'
  isExisting?: boolean
}

export type RecordDownloadRequest = { renderId: string; selectionId: number } & DownloadMetadata
export interface CompleteRenderRequest { renderId: string; segments: RenderSegmentInput[]; output: RenderOutputInput }
export interface FailRenderRequest { renderId: string; failureCode: string; failureMessage: string }

matchScene(input: { theme: string; candidateCount: number }): Promise<SceneMatchResponse>
selectCandidate(input: { runId: string; providerResourceId: number; note: string }): Promise<{ selectionId: number }>
start(input: { requestDigest: string; theme: string }): Promise<RenderStatusResponse>
recordDownload(input: RecordDownloadRequest): Promise<{ renderId: string; downloadId: number }>
beginRender(renderId: string): Promise<RenderStatusResponse>
complete(input: CompleteRenderRequest): Promise<RenderStatusResponse>
fail(input: FailRenderRequest): Promise<RenderStatusResponse>
retry(renderId: string): Promise<RenderStatusResponse>
```

The candidate validator must retain fresh preview URLs only in memory; metadata request types must contain no URL field except `requiredAttributionUrl`.

- [ ] **Step 4: Verify and commit the client**

Run: `npm test -- tests/video-production-api.test.ts tests/supabase-api.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

```powershell
git add src/video-production-api.ts tests/video-production-api.test.ts
git commit -m "feat: add local video production API client"
```

---

### Task 4: Exact Quote Selection And Four-Scene Storyboard

**Files:**
- Create: `src/quote-selection.ts`
- Create: `src/storyboard.ts`
- Create: `tests/quote-selection.test.ts`
- Create: `tests/storyboard.test.ts`

**Interfaces:**
- Consumes: `SubtitleSearchResult[]` from `SubtitleApi.search`, the canonical English query, and one manually reviewed Chinese quote translation.
- Produces: `selectExactQuote(results): SelectedQuote` and `buildStoryboard(quote, captionZh): Storyboard` with exactly four scenes and one quote scene.

- [ ] **Step 1: Write failing preferred and relaxed quote tests**

Use synthetic subtitle results and prove the exact cue text is never trimmed or rewritten in the returned object:

```typescript
const result = searchResult({
  similarity: 0.83,
  movie: { id: 2, title: 'Synthetic Film', releaseYear: 1994 },
  trackId: 7,
  cues: [{ index: 31, startMs: 120_000, endMs: 125_000, text: '  Hope remains with us.  ' }],
})

expect(selectExactQuote([result])).toMatchObject({
  text: '  Hope remains with us.  ',
  trackId: 7,
  cueIndex: 31,
  startMs: 120_000,
  endMs: 125_000,
})
```

Add cases for 5-18 English words and at most eight seconds, rejection of sound-only brackets and label-only cues, preferred similarity ordering, shorter-duration tie break, movie/track/cue deterministic ties, duplicate cue removal, the one-time 3-24 word/10-second relaxation, and a controlled `QuoteSelectionError('no_usable_quote')` when both passes fail.

- [ ] **Step 2: Run quote tests and verify RED**

Run: `npm test -- tests/quote-selection.test.ts`

Expected: FAIL because the quote module does not exist.

- [ ] **Step 3: Implement deterministic cue selection**

Export this shape:

```typescript
export interface SelectedQuote {
  text: string
  similarity: number
  movieId: number
  movieTitle: string
  releaseYear: number | null
  trackId: number
  cueIndex: number
  startMs: number
  endMs: number
  timestamp: string
}
```

Count words with `/[A-Za-z]+(?:'[A-Za-z]+)?/g`, inspect `text.trim()` only for eligibility, but return the original exact `cue.text`. Deduplicate by `trackId:cueIndex`. Stable-sort candidates by similarity descending, duration ascending, movie ID, track ID, and cue index.

- [ ] **Step 4: Write failing storyboard tests**

Require exactly four scene indices, exactly one quote, bilingual nonblank captions, and generic English visual descriptions that contain neither quote text nor movie title:

```typescript
const storyboard = buildStoryboard(selectedQuote, '希望仍与我们同在。')
expect(storyboard.scenes).toHaveLength(4)
expect(storyboard.scenes.map(scene => scene.index)).toEqual([0, 1, 2, 3])
expect(storyboard.scenes.filter(scene => scene.captionKind === 'quote')).toHaveLength(1)
expect(storyboard.scenes[2].captionEn).toBe(selectedQuote.text)
expect(storyboard.scenes[2].visualTheme).not.toContain(selectedQuote.text.trim())
expect(storyboard.scenes[2].visualTheme).not.toContain(selectedQuote.movieTitle)
```

- [ ] **Step 5: Implement the fixed storyboard**

Use these original captions and visual concepts:

```typescript
const originalScenes = [
  {
    captionEn: 'Every night has a horizon.',
    captionZh: '每一个黑夜，都有它的地平线。',
    visualTheme: 'dark rain clouds moving over a remote landscape before dawn, cinematic wide shot',
  },
  {
    captionEn: 'Keep moving, even when the path disappears.',
    captionZh: '即使看不见路，也继续向前。',
    visualTheme: 'solitary traveler walking forward through wind on a dark open path, cinematic wide shot',
  },
  {
    captionEn: 'Morning begins with the next step.',
    captionZh: '黎明，始于下一步。',
    visualTheme: 'sunrise breaking over an open horizon with warm light, hopeful cinematic wide shot',
  },
]
```

Insert the quote at index 2 with the generic visual theme `a solitary traveler reaching a ridge as storm clouds break and first light appears, cinematic wide shot`. Store the exact source fields only on that scene. Reject blank or over-300-character Chinese translation input.

- [ ] **Step 6: Verify and commit quote/storyboard behavior**

Run: `npm test -- tests/quote-selection.test.ts tests/storyboard.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

```powershell
git add src/quote-selection.ts src/storyboard.ts tests/quote-selection.test.ts tests/storyboard.test.ts
git commit -m "feat: select exact quote and build video storyboard"
```

---

### Task 5: Formal Vecteezy Download Client And Hard Budget

**Files:**
- Create: `src/vecteezy-download.ts`
- Create: `tests/vecteezy-download.test.ts`

**Interfaces:**
- Consumes: selected positive resource IDs, account ID, API key, injected fetch/delay/file operations, a hard `FormalDownloadBudget`, and relative destination paths.
- Produces: `VecteezyDownloadClient.getDownloadInfo`, `requestDownload`, `waitForDownload`, `transferSignedUrl`, `FormalDownloadBudget`, provider quota metadata, and completed local source descriptors.

- [ ] **Step 1: Write failing provider and budget tests**

Test the exact read-only size call and formal call separately:

```typescript
expect(String(fetchFn.mock.calls[0][0])).toBe(
  'https://api.vecteezy.com/v2/161976/resources/42/download_info?file_type=mp4',
)
expect(String(fetchFn.mock.calls[1][0])).toBe(
  'https://api.vecteezy.com/v2/161976/resources/42/download?file_type=mp4',
)
expect(fetchFn.mock.calls[1][1].headers.authorization).toBe('Bearer secret')
```

Cover integer size normalization, malformed provider payloads, `401/402/403/404/422`, quota header parsing, 512 MiB per-file rejection before formal download, 2 GiB aggregate rejection, and no `file_size` query parameter.

Prove reservation occurs before fetch and never exceeds four:

```typescript
const budget = new FormalDownloadBudget(4)
await Promise.all([1, 2, 3, 4].map(id => client.requestDownload(id, budget)))
await expect(client.requestDownload(5, budget)).rejects.toMatchObject({ code: 'download_budget_exhausted' })
expect(budget.used).toBe(4)
```

- [ ] **Step 2: Add failing signed-transfer and status-poll tests**

Use synthetic signed/status URLs only in injected fetch fixtures. Assert immediate URL, inline URL fallback, status polling to 100%, terminal timeout, bounded delay, `.part` destination, atomic rename, same-URL transfer retry, SHA-256 after rename, and no URL in returned metadata or captured logs.

Add a recursive redaction assertion:

```typescript
const serialized = JSON.stringify(await transferResult)
expect(serialized).not.toContain('signed.test')
expect(serialized).not.toMatch(/download_status_url|inline_url|\"url\"/)
```

- [ ] **Step 3: Run download tests and verify RED**

Run: `npm test -- tests/vecteezy-download.test.ts`

Expected: FAIL because the local download client does not exist.

- [ ] **Step 4: Implement the client without new dependencies**

Use `fetch`, `node:stream/promises.pipeline`, `Readable.fromWeb`, `createWriteStream`, `rename`, and `rm`. Export:

```typescript
export class FormalDownloadBudget {
  readonly maximum: number
  get used(): number
  reserve(): number
}

export interface DownloadQuota {
  limit: number | null
  remaining: number | null
}

export interface CompletedVecteezyDownload {
  artifactKey: string
  sourceSizeBytes: number
  sourceSha256: string
  requiresAttribution: boolean
  requiredAttributionUrl: string | null
  quota: DownloadQuota
}
```

`requestDownload` must call `budget.reserve()` before `fetch`. Provider 4xx responses are never retried. Transfer retries use the same in-memory signed URL at most three times with 500/1000 ms delay and do not call `/download` again. The signed/status URLs exist only in private method scope and are absent from error messages.

- [ ] **Step 5: Verify no existing read-only client regresses**

Run: `npm test -- tests/vecteezy-download.test.ts tests/vecteezy.test.ts tests/video-assets-migration-static.test.ts`

Expected: PASS, including the existing guarantee that Edge candidate code contains no download route.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the provider client**

```powershell
git add src/vecteezy-download.ts tests/vecteezy-download.test.ts
git commit -m "feat: add quota-safe Vecteezy downloads"
```

---

### Task 6: Safe Local Artifacts And Resumable Manifest

**Files:**
- Create: `src/video-artifacts.ts`
- Create: `tests/video-artifacts.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: render UUID, stable run inputs, selections, completed source descriptors, probes, output metadata, and a configurable artifact root.
- Produces: safe run paths, SHA-256, atomic `manifest.json`, stage completion checks, and idempotent local reuse.

- [ ] **Step 1: Write failing path and manifest tests**

Assert that only forward-slash keys with a valid UUID path segment beneath
`video-runs/` are accepted, using
`video-runs/d62a53a1-08fb-4bee-a1ed-d8ba13de85f2/final.mp4` as the positive
fixture. Reject drive letters, leading slashes, `..`, backslashes, control
characters, `http:`, `https:`, `data:`, and any key containing `url`, `token`,
`secret`, or `authorization`.

Define a versioned manifest fixture:

```typescript
const manifest: VideoRunManifest = {
  version: 1,
  planId: 'd62a53a1-08fb-4bee-a1ed-d8ba13de85f2',
  renderId: null,
  requestDigest: 'a'.repeat(64),
  theme: 'Crossing darkness toward dawn',
  quote: { trackId: 7, cueIndex: 31, text: 'Hope remains with us.', captionZh: '希望仍与我们同在。' },
  scenes: [],
  stage: 'review',
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
}
```

Test strict parse, unknown-field rejection, temp-file then atomic rename, deterministic canonical digest input, SHA-256 streaming, matching-file reuse, mismatched-file rejection, and recursive absence of signed/status URLs.

- [ ] **Step 2: Run artifact tests and verify RED**

Run: `npm test -- tests/video-artifacts.test.ts`

Expected: FAIL because the artifact module does not exist.

- [ ] **Step 3: Implement artifact layout and manifest persistence**

Export:

```typescript
export type VideoRunStage = 'review' | 'downloading' | 'rendering' | 'completed' | 'failed'
export function artifactKey(renderId: string, relative: string): string
export function resolveArtifactPath(root: string, key: string): string
export async function sha256File(path: string): Promise<string>
export async function writeManifestAtomic(path: string, manifest: VideoRunManifest): Promise<void>
export async function readManifest(path: string): Promise<VideoRunManifest>
export function nextIncompleteStage(manifest: VideoRunManifest, localFiles: LocalFileState): VideoRunStage
```

Resolve every path and verify it remains beneath the resolved artifact root
before any write. JSON serialization uses a stable field order and a trailing
newline. Store relative artifact keys, hashes, IDs, captions, technical metadata,
and attribution only; do not store absolute paths, preview URLs, signed URLs,
status URLs, secrets, or raw provider objects.

The manifest never stores its own SHA-256. After media validation, write the
final manifest once with `stage='completed'`, hash those exact bytes, and send
that hash in the metadata `complete` request. Do not rewrite the manifest after
hashing. If the remote completion call fails, `resume` retries only that
idempotent metadata call with the same file and hash.

- [ ] **Step 4: Ignore the complete artifact tree**

Append exactly this root entry to `.gitignore`:

```gitignore
artifacts/
```

Test
`git check-ignore artifacts/video-runs/d62a53a1-08fb-4bee-a1ed-d8ba13de85f2/final.mp4`
through an injected command or a focused shell verification.

- [ ] **Step 5: Verify and commit artifact handling**

Run: `npm test -- tests/video-artifacts.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

```powershell
git add .gitignore src/video-artifacts.ts tests/video-artifacts.test.ts
git commit -m "feat: add resumable local video artifacts"
```

---

### Task 7: ffprobe, ASS, And FFmpeg Renderer

**Files:**
- Create: `src/media-probe.ts`
- Create: `src/ass-subtitles.ts`
- Create: `src/video-renderer.ts`
- Create: `tests/media-probe.test.ts`
- Create: `tests/ass-subtitles.test.ts`
- Create: `tests/video-renderer.test.ts`

**Interfaces:**
- Consumes: four verified MP4 paths, reviewed in-points, four storyboard scenes, local FFmpeg/ffprobe commands, and safe output paths.
- Produces: validated source probes, four normalized clips, `subtitles.ass`, `final.mp4`, black-frame findings, `contact-sheet.jpg`, and validated final output metadata.

- [ ] **Step 1: Write failing ffprobe parser tests**

Inject process output and validate a real ffprobe JSON shape:

```typescript
const probe = parseMediaProbe({
  format: { duration: '12.500000', size: '123456' },
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p', avg_frame_rate: '30000/1001' },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
  ],
})
expect(probe.durationMs).toBe(12_500)
expect(probe.frameRate).toBeCloseTo(29.97, 2)
```

Reject missing video, zero duration, zero dimensions, nonfinite fractions, implausibly small byte size, and final output outside 1920x1080, 29.5-30.5 fps, 29-31 seconds, H.264/AAC, and `yuv420p`.

- [ ] **Step 2: Write failing ASS tests**

Assert `PlayResX: 1920`, `PlayResY: 1080`, `Fontname=Microsoft YaHei`, margins at least 108 vertical and 192 horizontal, English/Chinese line break via `\N`, escaping of `{`, `}`, and backslashes, exact quote text, source line `Movie Title (Year) · 00:02:00.000`, and four non-overlapping caption windows within 0-30 seconds.

- [ ] **Step 3: Write failing FFmpeg argument tests**

Parameterize render dimensions/durations for tests, but assert production defaults exactly:

```typescript
expect(PRODUCTION_RENDER).toEqual({
  width: 1920,
  height: 1080,
  fps: 30,
  sceneDurationSeconds: 7.95,
  transitionSeconds: 0.60,
  totalDurationSeconds: 30,
})
expect(buildTransitionOffsets(PRODUCTION_RENDER)).toEqual([7.35, 14.7, 22.05])
```

Assert normalization uses scale-to-fill, center crop, square pixels, 30 fps, common time base, no source audio, and source looping only when probe duration is shorter than 7.95 seconds. Assert final options include `libx264`, `-crf 18`, `-preset medium`, `-pix_fmt yuv420p`, `aac`, `192k`, `48000`, `-movflags +faststart`, ASS burn-in with the Windows font directory, filtered pink noise, and exactly 30 seconds.

- [ ] **Step 4: Run focused media tests and verify RED**

Run: `npm test -- tests/media-probe.test.ts tests/ass-subtitles.test.ts tests/video-renderer.test.ts`

Expected: FAIL because media modules do not exist.

- [ ] **Step 5: Implement the process boundary and renderer**

Use `node:child_process.spawn` with argument arrays and no shell. Export an injectable runner:

```typescript
export interface ProcessResult { exitCode: number; stdout: string; stderr: string }
export type ProcessRunner = (command: string, args: string[]) => Promise<ProcessResult>
export async function probeMedia(path: string, run?: ProcessRunner): Promise<MediaProbe>
export async function renderVideo(input: RenderVideoInput, run?: ProcessRunner): Promise<RenderVideoResult>
```

Normalize sources before the final filter graph. Build xfade offsets from the formula `index * (sceneDuration - transition)`. Generate ambient audio from `anoisesrc=color=pink`, high-pass/low-pass it, reduce volume, and fade at both ends. Generate the contact sheet at 0, 7.5, 15, and 22.5 seconds as a 2x2 JPEG. Run `blackdetect=d=0.5:pix_th=0.10` and reject any black interval longer than one second.

- [ ] **Step 6: Add a real small FFmpeg integration test**

Skip only when `ffmpeg -version` or `ffprobe -version` is unavailable. Generate four 320x180 one-second `testsrc2` clips in a temporary directory, render a four-second target with 0.10-second transitions, burn synthetic bilingual captions with `C:\Windows\Fonts\msyh.ttc`, and assert ffprobe sees video plus AAC audio, the JPEG contact sheet is nonempty, and no black interval exceeds one second. Delete only the test temporary directory in test cleanup.

- [ ] **Step 7: Verify and commit media rendering**

Run: `npm test -- tests/media-probe.test.ts tests/ass-subtitles.test.ts tests/video-renderer.test.ts`

Expected: PASS, including the local real-FFmpeg integration test.

Run: `npm run typecheck`

Expected: PASS.

```powershell
git add src/media-probe.ts src/ass-subtitles.ts src/video-renderer.ts tests/media-probe.test.ts tests/ass-subtitles.test.ts tests/video-renderer.test.ts
git commit -m "feat: render verified bilingual videos locally"
```

---

### Task 8: Resumable Video Pipeline CLI And Operator Documentation

**Files:**
- Create: `src/video-pipeline-runner.ts`
- Create: `src/video-pipeline.ts`
- Create: `tests/video-pipeline.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `tests/deployment-docs.test.ts`

**Interfaces:**
- Consumes: `SubtitleApi`, `VideoProductionApi`, quote/storyboard functions, the download client, artifact manager, probe/renderer, environment values, and an ignored reviewed run-input JSON file.
- Produces: `video plan`, `video produce`, `video resume`, one review manifest, and one verified completed production record.

- [ ] **Step 1: Write failing orchestration tests with every boundary injected**

Define dependencies rather than mocking globals:

```typescript
export interface VideoPipelineDependencies {
  subtitleApi: Pick<SubtitleApi, 'search'>
  productionApi: Pick<VideoProductionApi,
    'matchScene' | 'selectCandidate' | 'start' | 'recordDownload' |
    'beginRender' | 'complete' | 'fail' | 'retry'>
  downloads: VecteezyDownloadClient
  probeMedia: typeof probeMedia
  renderVideo: typeof renderVideo
  readManifest: typeof readManifest
  writeManifest: typeof writeManifestAtomic
  output: (message: string) => void
  now: () => string
}
```

Cover these complete scenarios:

- `plan` searches the canonical query with limit 20, selects one exact cue, builds four scenes, calls `matchScene` four times with generic visual themes and candidate count 8, and stops at `review` without calling selection, `/download`, FFmpeg, or production metadata.
- `produce` requires a reviewed input whose quote source matches the manifest and whose four resource IDs belong to the corresponding candidate lists.
- `produce` calls four selections, starts one render job, downloads/probes/records exactly four files, begins rendering, writes ASS, renders, probes final output, completes metadata, and marks the manifest completed.
- a fifth formal call is impossible even when dependencies run concurrently.
- an existing matching source hash skips provider download and records no duplicate metadata.
- a transfer failure calls `fail`, preserves source state, and never calls render/complete.
- a render failure calls `fail`, preserves downloaded sources, and `resume` calls `retry` then continues without a formal download.
- a metadata-completion failure keeps the completed final manifest and video,
  does not call `fail`, and `resume` retries only `complete` with the same
  manifest hash.
- malformed reviewed input stops before selection and quota use.
- an oversized `download_info` result returns the scene to review before any
  formal call is reserved.
- output contains IDs/counts/file names but no full chunk, secret, preview URL, signed URL, raw provider payload, or model prompt.

- [ ] **Step 2: Run pipeline tests and verify RED**

Run: `npm test -- tests/video-pipeline.test.ts`

Expected: FAIL because pipeline modules do not exist.

- [ ] **Step 3: Implement the review input and orchestration stages**

Use this strict ignored review file shape:

```typescript
export interface ReviewedVideoRunInput {
  version: 1
  quote: { trackId: number; cueIndex: number; captionZh: string }
  scenes: [
    { index: 0; runId: string; providerResourceId: number; note: string; sourceInMs: number },
    { index: 1; runId: string; providerResourceId: number; note: string; sourceInMs: number },
    { index: 2; runId: string; providerResourceId: number; note: string; sourceInMs: number },
    { index: 3; runId: string; providerResourceId: number; note: string; sourceInMs: number },
  ]
}
```

`plan` creates a local `planId` UUID and writes candidate IDs, stable metadata,
and temporary preview references
to a local review file, but the durable manifest strips preview references
before any metadata write. The agent may use the temporary previews to create
contact sheets before filling the reviewed input. In `--json` mode, `plan` also
writes the same path-only response to ignored `artifacts/latest-plan.json` for
later PowerShell sessions.

Compute `requestDigest` only after quote and four selections are fixed. Hash a
canonical version-1 object containing theme, exact quote source/text, bilingual
storyboard, target render settings, and selected run/resource IDs. Exclude the
local `planId` from the digest.

`produce` calls metadata `start` before any formal download. After Supabase
returns the authoritative `renderId`, atomically rename the local directory whose
UUID path segment equals `planId` so its path segment equals `renderId`, write
`renderId` into the manifest, and update `artifacts/latest-plan.json`. If the
destination already exists, compare manifests and hashes rather than merging
directories. If `start` returns an existing completed job, stop without a
provider call; if it returns an existing active or failed job, attach only after
the manifest IDs and digest agree.

- [ ] **Step 4: Implement Commander commands and environment construction**

Expose:

```powershell
$plan = npm run --silent video -- plan --theme "Crossing darkness toward dawn" --candidate-count 8 --json | ConvertFrom-Json
npm run video -- produce --manifest $plan.manifestPath --review $plan.reviewPath --max-downloads 4
$active = Get-Content -Raw artifacts/latest-plan.json | ConvertFrom-Json
npm run video -- resume --manifest $active.manifestPath
```

The `plan --json` command writes progress to stderr, emits exactly one stdout
JSON object containing `planId`, `manifestPath`, and `reviewPath`, and writes
that object to `artifacts/latest-plan.json`, so the operator never guesses a
generated path. Require `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, and `SUBTITLE_PERSONAL_TOKEN` for all commands;
require `VECTEEZY_ACCOUNT` and `VECTEEZY_API_KEY` only for `produce/resume`.
Require `--max-downloads` to equal 4 for this production contract.

Add to `package.json`:

```json
"video": "tsx src/video-pipeline.ts"
```

Keep `.env.example` unchanged: no new environment variable is required beyond
the existing Supabase, OpenSubtitles, Vecteezy, and Ollama names.

- [ ] **Step 5: Write failing operator documentation assertions**

Extend `tests/deployment-docs.test.ts` to require a `## Local Video Production` section containing remote-only migration/testing, `video-production-metadata`, all three table names, plan/review/produce/resume commands, hard four-download budget, no Storage upload, local artifact ignore, exact-quote protection, no dialogue to Ollama, FFmpeg requirements, and rollback/deactivation steps.

- [ ] **Step 6: Document the complete operator workflow**

Document these commands without real secrets or real movie dialogue:

```powershell
npx supabase db push --dry-run --linked
npx supabase db push --linked
npx supabase test db --linked supabase/tests/database/video_production.sql
npx supabase functions deploy video-production-metadata --no-verify-jwt
$plan = npm run --silent video -- plan --theme "Crossing darkness toward dawn" --candidate-count 8 --json | ConvertFrom-Json
```

Explain that `plan` consumes no Vecteezy download quota, review must finish before `produce`, formal calls are capped at four, and all media stays under ignored `artifacts/`.

- [ ] **Step 7: Verify and commit the complete local workflow**

Run: `npm test -- tests/video-pipeline.test.ts tests/deployment-docs.test.ts`

Expected: PASS.

Run: `npm test`

Expected: all Vitest tests PASS.

Run: `npm run typecheck`

Expected: PASS.

```powershell
git add package.json README.md tests/deployment-docs.test.ts src/video-pipeline.ts src/video-pipeline-runner.ts tests/video-pipeline.test.ts
git commit -m "feat: orchestrate local movie quote videos"
```

---

### Task 9: Full Verification And Remote Supabase Deployment

**Files:**
- No planned source changes. Any reproducible defect begins with a failing regression test in the owning task's test file.

**Interfaces:**
- Consumes: completed Tasks 1-8, linked project `kwoppqigrtvgmmbnzbpx`, Supabase CLI access token, and existing remote secrets.
- Produces: remote production schema, passing linked pgTAP, deployed private metadata function, auth evidence, and clean advisors.

- [ ] **Step 1: Run all local checks without Docker**

Run serially:

```powershell
npm test
npm run typecheck
git diff --check
git status --short --branch
```

Expected: all tests and typecheck PASS, no whitespace errors, and only intentional committed changes.

- [ ] **Step 2: Inspect remote migration state and dry-run the push**

Run:

```powershell
npx supabase migration list
npx supabase db push --dry-run --linked
```

Expected: the video-production migration is pending and the dry run lists only intended unapplied migrations. Do not use `supabase start` or `supabase db reset`.

- [ ] **Step 3: Push the migration and run linked pgTAP**

Run:

```powershell
npx supabase db push --linked
npx supabase test db --linked supabase/tests/database/video_production.sql
npx supabase db lint --linked --schema public --level warning
```

Expected: migration applies, all 36 production pgTAP assertions PASS, and no
new schema error or warning is attributable to the new objects.

- [ ] **Step 4: Deploy the private metadata function**

Run:

```powershell
npx supabase functions deploy video-production-metadata --no-verify-jwt
```

Expected: deployment succeeds on project `kwoppqigrtvgmmbnzbpx` with the existing `SUBTITLE_PERSONAL_TOKEN`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` runtime configuration.

- [ ] **Step 5: Verify auth ordering and one synthetic state cycle**

Call the function without `x-subtitle-token` and with a wrong token.

Expected: exact `401` and no row creation.

Then use the correct token and a synthetic request digest to exercise `start`, `fail`, and `retry` only. Expected statuses: `planned`, `failed`, `planned`. Do not call `recordDownload` with invented selection IDs and do not include movie dialogue.

- [ ] **Step 6: Run Supabase advisors and inspect tables**

Use the Supabase connector `get_advisors` for both `security` and `performance`. Query `information_schema` and `pg_policies` to verify three force-RLS tables, no browser policies, six service-role RPCs, and all foreign-key indexes.

Expected: no new security/performance finding caused by this deployment. Record advisor remediation links only if a real finding exists.

---

### Task 10: Expand The Hosted Subtitle Corpus To Provider Stop

**Files:**
- No tracked files. The importer updates ignored `downloads/classics` and `.batch-state/classic-import-state.json`.

**Interfaces:**
- Consumes: configured OpenSubtitles account, current 11-success resume state, 230 ranked candidates, and hosted ingestion function.
- Produces: as many additional ready English tracks as the current provider allowance permits, then a measured corpus snapshot for full-corpus retrieval.

- [ ] **Step 1: Capture a hosted baseline**

Query the linked database for movie, ready-track, cue, chunk, and embedded-chunk counts plus the ordered movie list. Expected baseline at planning time is 17 movies, 17 tracks, 29,681 cues, and 1,160 chunks; treat live values as authoritative if they have changed.

- [ ] **Step 2: Verify ignored resume state and provider configuration names**

Read only counts/titles from `.batch-state/classic-import-state.json`; never print credential values or full subtitle text. Confirm required names are set:

Run a dotenv-aware name-only check:

```powershell
npx tsx -e "import 'dotenv/config'; const names=['OPENSUBTITLES_API_KEY','OPENSUBTITLES_TOKEN','OPENSUBTITLES_USER_AGENT','SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','SUBTITLE_PERSONAL_TOKEN']; const missing=names.filter(name=>!process.env[name]?.trim()); if(missing.length) throw new Error('missing environment variables: '+missing.join(',')); console.log(names.join('`n'))"
```

Expected: six variable names and no values.

- [ ] **Step 3: Run the resumable importer until its stop condition**

Run:

```powershell
npx tsx src/batch-classics.ts --target 230 --max-attempts 230
```

Expected: it begins with the next unprocessed classic candidate, continues across ordinary per-film failures, and stops only on OpenSubtitles quota/rate/daily limit, configuration/authentication stop, target success, or candidate exhaustion. Do not restart repeatedly after a quota stop.

- [ ] **Step 4: Verify every newly added track**

Query hosted counts and list tracks created after the baseline. Assert each new track has `status='ready'`, at least one cue, at least one chunk, and no null embedding. Confirm the next full-corpus search will include all ready tracks.

If the provider allowance permits no new film, record that outcome and continue to Task 11 using the existing corpus.

---

### Task 11: Real Quote Retrieval, Reviewed Vecteezy Downloads, Render, And Metadata Acceptance

**Files:**
- No tracked files unless acceptance exposes a reproducible bug; all run data remains under ignored `artifacts/video-runs`.

**Interfaces:**
- Consumes: expanded hosted corpus, deployed APIs, current Vecteezy credentials and quota, local FFmpeg, and the approved theme.
- Produces: one verified local `final.mp4`, `subtitles.ass`, `manifest.json`, `contact-sheet.jpg`, four source clips, and consistent completed Supabase metadata.

- [ ] **Step 1: Run the no-download planning phase**

Run:

```powershell
$plan = npm run --silent video -- plan --theme "Crossing darkness toward dawn" --candidate-count 8 --json | ConvertFrom-Json
```

Expected: one selected exact cue from a 20-result full-corpus search, four scene search runs, eight candidates per scene when available, and a local review manifest. No `/download` request, metadata job, or FFmpeg render occurs.

- [ ] **Step 2: Review the exact quote and Chinese translation**

Inspect only the selected cue, its movie/year, cue timestamp, similarity, and immediate cue duration. Verify it is a complete line appropriate to the theme and meets preferred or documented relaxed bounds. Write a faithful Chinese translation into the ignored reviewed-input file; do not alter the English cue.

- [ ] **Step 3: Review four candidate pools visually**

For each scene, prefer horizontal, commercial, non-AI resources when available. Use fresh preview URLs only to create temporary local thumbnails/contact sheets; inspect subject, action, lighting, framing, and absence of visible logos or text. Record one owned `providerResourceId`, note, and source in-point per scene in the ignored reviewed-input file.

Expected: four different selections that collectively progress from darkness/storm through movement to first light and an open horizon. Preview review consumes no formal download quota.

- [ ] **Step 4: Confirm quota budget once, then produce**

Before execution, verify `--max-downloads 4`, at least 5 GiB free local disk,
and the four reviewed resources. Run the exact `produce` command printed by the
`plan` output.

Expected: at most four formal Vecteezy `/download` calls; every call is preceded by `download_info`; signed URLs are transferred immediately and never printed or persisted; four files pass ffprobe and SHA-256 before rendering.

- [ ] **Step 5: Verify the final media and contact sheet**

Run ffprobe through the implemented validator and independently inspect:

```powershell
$plan = Get-Content -Raw artifacts/latest-plan.json | ConvertFrom-Json
$manifest = Get-Content -Raw $plan.manifestPath | ConvertFrom-Json
$finalPath = Join-Path 'artifacts' ($manifest.output.artifactKey -replace '/', [IO.Path]::DirectorySeparatorChar)
ffprobe -v error -show_entries format=duration,size -show_entries stream=index,codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,sample_rate,channels -of json $finalPath
```

Expected: 1920x1080, approximately 30 fps, 29-31 seconds, H.264 `yuv420p`, AAC stereo 48 kHz, and nonzero size. Inspect `contact-sheet.jpg` for four non-black, correctly framed visual sections and bilingual text within title-safe bounds. Verify the movie source line is legible on the quote scene.

- [ ] **Step 6: Verify local and hosted metadata integrity**

Hash all four source files, `manifest.json`, and `final.mp4`. Query Supabase by render UUID and assert:

- one `video_render_jobs` row with `status='completed'` and matching output/manifest hashes;
- four `video_asset_downloads` rows with matching source hashes, selected resource IDs, probes, attribution, and quota snapshots;
- four `video_render_segments` rows with indices 0-3, owned downloads, exactly one quote source, and exact English cue equality;
- no signed/status/preview URL column or value in any production table.

- [ ] **Step 7: Run final regression and repository checks**

Run:

```powershell
npm test
npm run typecheck
npx supabase test db --linked supabase/tests/database/video_production.sql
git diff --check
git status --short --branch
```

Expected: every check PASS; only ignored runtime artifacts and provider files exist outside Git. Do not push until the user explicitly requests publication of these implementation commits.

## Completion Report

Report the following without revealing secrets, signed URLs, full subtitle chunks, or raw provider payloads:

- baseline and final movie/track/cue/chunk counts;
- imported movie titles and the OpenSubtitles stop reason;
- selected quote movie, year, timestamp, and a short single-cue excerpt;
- four Vecteezy stable resource IDs, titles, attribution requirements, and formal download count;
- render UUID, local final-video path, duration, codecs, dimensions, size, and SHA-256;
- Supabase row counts and advisor result;
- all test/typecheck/linked-pgTAP results;
- any residual rights, plaintext Ollama, or local-artifact portability limitations.
