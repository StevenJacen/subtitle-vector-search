# Local Video Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a localhost React workbench that selects a continuous 5-10 cue movie passage, translates it with Ollama, supports incremental eight-at-a-time Vecteezy review, and renders a resumable silent bilingual video whose local and Supabase metadata agree.

**Architecture:** Keep Supabase as the private subtitle and production-audit source of truth, while a localhost Node control service owns credentials, task serialization, review state, provider previews, formal downloads, FFmpeg, and SSE. Add version-2 contracts beside the immutable version-1 pipeline. A Vite React application consumes only the narrow local API and never receives provider credentials, service-role credentials, signed URLs, absolute paths, or raw model payloads.

**Tech Stack:** TypeScript 7, Node.js 22+, React 19, Vite 7, Lucide React, Vitest 4, Testing Library, Playwright, Supabase Edge Runtime/Deno, PostgreSQL 17, Supabase AI `gte-small`, Ollama `gemma4:12b`, Vecteezy API V2, FFmpeg/ffprobe.

## Global Constraints

- Work in `D:\Project\subtitle\.worktrees\subtitle-vector-search` on the existing `agent/subtitle-vector-search` branch. Do not create another worktree and do not push unless the user asks.
- Use strict red-green-refactor: add a focused failing test, run it and observe the expected failure, implement the minimum behavior, then run focused and full verification.
- Preserve every version-1 manifest, RPC, Edge action, test, and resume path. Version 2 must be additive and selected only by an explicit versioned API.
- Keep the browser untrusted. It must never receive `.env` values, Supabase service-role credentials, Vecteezy credentials, signed/status/download URLs, arbitrary proxy URLs, absolute filesystem paths, raw Ollama payloads, or full model prompts.
- Bind only to `127.0.0.1`, require a random per-process session token on every state-changing or streaming route, enforce same-origin requests, and accept only UUID route parameters.
- Send the exact ordered English cue array only to the explicitly approved unauthenticated test Ollama endpoint `http://54.67.73.171`; display that privacy warning in health and creation UI. Never accept English dialogue back from the model.
- Require 5-10 consecutive cues from one ready track and movie, each at least 1,200 ms, with summed cue duration from 15,000 through 60,000 ms.
- Start each scene with exactly eight Vecteezy candidates. Each load-more appends at most eight, deduplicates by `(provider, resourceId)`, preserves previous pools and selections, and records each candidate's owning run ID.
- Require one current explicit confirmation per scene before production. Formal Vecteezy calls equal the scene count and may never exceed ten for one task. Durable reservation precedes each provider request.
- Render only H.264 `yuv420p` at 30 fps, either 1920x1080 (`16:9`) or 1080x1920 (`9:16`). Strip all source audio and require no output audio stream.
- Set every scene and ASS event to the exact cue duration. Dynamic transitions are at most 400 ms and must not shorten the cumulative output timeline.
- Keep source files, previews, review state, manifests, and outputs under ignored `artifacts/`. Continue atomic writes, path containment, URL redaction, hashes, and completed-manifest immutability.
- Add no background music, ambient sound, narration, TTS, Storage upload, hosting, batch creation, or automatic asset confirmation.
- Use remote Supabase project `kwoppqigrtvgmmbnzbpx` with the linked CLI and no Docker. Push migrations before deploying changed functions.
- Force RLS on all production tables, add no `anon` or `authenticated` policies or grants, and grant version-2 RPC execution only to `service_role` and `postgres`.
- Use `apply_patch` for manual edits. Keep `.env`, `artifacts/`, `downloads/`, provider payloads, and generated media out of Git. Commit after each completed task.

## File Map

- `src/workbench/passage-selection.ts`: deterministic continuous-cue window validation, scoring, and selection.
- `supabase/functions/_shared/passage-selection.ts`: Edge-compatible re-export of the pure selector.
- `supabase/functions/subtitle-passages/index.ts`: authenticated hybrid-search anchor expansion and exact passage endpoint.
- `src/workbench/ollama.ts`: strict Ollama transport, prompt construction, translation/concept parsing, and redacted errors.
- `src/workbench/candidate-pool.ts`: eight-at-a-time page append, dedupe, recommendation, selection ownership, and confirmation rules.
- `src/workbench/artifacts-v2.ts`: version-2 task manifest, review state, atomic persistence, history, and resume-stage validation.
- `src/workbench/render-plan.ts`: dynamic cumulative timeline, transition handles, ASS scene metadata, and v2 completion payloads.
- `src/workbench/task-service.ts`: one-active-task orchestration and injected provider/render dependencies.
- `src/workbench/http-server.ts`: localhost API, session/origin protection, UUID routing, SSE, preview registry, and static/Vite serving.
- `src/workbench/server.ts`: environment loading and executable server entry.
- `src/workbench/health.ts`: Supabase, Ollama, Vecteezy, FFmpeg, ffprobe, font, and disk probes with controlled output.
- `src/workbench/vecteezy-candidates.ts`: paged candidate client and preview registry adapter.
- `src/video-artifacts.ts`: keep v1 parser immutable; expose shared containment helpers only when needed.
- `src/vecteezy-download.ts`: parameterize the existing hard budget for 5-10 without weakening the process-wide accounting.
- `src/ass-subtitles.ts`: add dynamic bilingual cue events and portrait/landscape layouts while retaining v1 builders.
- `src/media-probe.ts`: validate chosen dimensions and a null audio codec for v2.
- `src/video-renderer.ts`: add dynamic silent 5-10-scene rendering beside the existing v1 renderer.
- `src/video-production-api.ts`: add explicit v2 metadata methods without changing v1 wire bodies.
- `supabase/migrations/20260721055220_local_video_workbench_v2.sql`: additive v2 columns/checks and six versioned service-role RPCs.
- `supabase/tests/database/video_production_v2.sql`: linked pgTAP for v1 compatibility and v2 invariants.
- `supabase/functions/_shared/video-production-v2.ts`: strict v2 action and payload contracts.
- `supabase/functions/_shared/video-production-repository.ts`: additive v2 RPC methods.
- `supabase/functions/_shared/video-production-handler.ts`: additive version-2 dispatch after existing authentication.
- `workbench/index.html`, `workbench/src/*`: Vite SPA, operational workbench components, API client, and restrained responsive styling.
- `vite.config.ts`, `playwright.config.ts`, `tests/workbench-*.test.ts`, `e2e/workbench.spec.ts`: build, unit, contract, integration, and browser tests.
- `package.json`, `tsconfig.json`, `.env.example`, `README.md`: dependencies, scripts, TSX types, configuration, and operator instructions.

---

### Task 1: Continuous Passage Domain And Hosted Retrieval

**Files:**
- Create: `src/workbench/passage-selection.ts`
- Create: `supabase/functions/_shared/passage-selection.ts`
- Create: `supabase/functions/subtitle-passages/index.ts`
- Create: `tests/passage-selection.test.ts`
- Create: `tests/subtitle-passages-contract.test.ts`
- Create: `tests/subtitle-passages-entry-static.test.ts`

**Interfaces:**

```typescript
export interface PassageCue {
  trackId: number; cueIndex: number; startMs: number; endMs: number; text: string
}
export interface PassageAnchor {
  similarity: number; movieId: number; movieTitle: string; releaseYear: number | null
  trackId: number; firstCueIndex: number; lastCueIndex: number
}
export interface SelectedPassage {
  movie: { id: number; title: string; releaseYear: number | null }
  trackId: number; startCueIndex: number; endCueIndex: number
  totalDurationMs: number; cues: PassageCue[]
}
export function selectContinuousPassage(input: {
  theme: string; sceneCount: number; anchors: PassageAnchor[]; cues: PassageCue[]
}): SelectedPassage
```

- [ ] Write `tests/passage-selection.test.ts` first. Cover scene counts 5 and 10, out-of-range counts, 1,199/1,200 ms boundaries, 14,999/15,000/60,000/60,001 ms totals, same-track consecutive indices, exact text preservation, speaker-label/sound-effect rejection, deterministic tie breaks, and anchor expansion on both sides.
- [ ] Run `npm test -- tests/passage-selection.test.ts` and confirm RED because the module does not exist.
- [ ] Implement pure validation and deterministic scoring: parent similarity, normalized theme-token coverage, incomplete-dialogue penalty, then movie/track/start/end IDs. Do not mutate or normalize accepted cue text.
- [ ] Write strict request/response tests for `{ theme, sceneCount }` and static entry tests proving custom auth wraps JSON parsing, `gte-small` embeds the theme, only ready tracks are considered, and service-role queries return exact cue fields.
- [ ] Implement `subtitle-passages`: hybrid-match at least 20 anchors, fetch bounded adjacent cue ranges per unique track, pass them to the pure selector, and return one canonical passage. Map no eligible passage to a controlled 422.
- [ ] Run `npm test -- tests/passage-selection.test.ts tests/subtitle-passages-contract.test.ts tests/subtitle-passages-entry-static.test.ts`, `npm run typecheck`, and `git diff --check`.
- [ ] Commit: `feat: select continuous subtitle passages`.

### Task 2: Strict Ollama Translation And Visual Concepts

**Files:**
- Create: `src/workbench/ollama.ts`
- Create: `tests/workbench-ollama.test.ts`

**Interfaces:**

```typescript
export interface PlannedCue {
  captionZh: string
  visualConcept: string
  mood?: string; action?: string; setting?: string; lighting?: string
}
export function buildPassagePrompt(cues: readonly PassageCue[]): string
export function parsePassagePlan(value: unknown, cues: readonly PassageCue[], context: {
  movieTitle: string; characterNames?: readonly string[]
}): PlannedCue[]
export async function planPassageWithOllama(input: {
  endpoint: URL; model: string; cues: readonly PassageCue[]; fetchFn?: typeof fetch
}): Promise<PlannedCue[]>
```

- [ ] Test first: exact count/order, trimmed nonempty Chinese and concepts, optional generic facets, JSON-fence handling, timeout, non-JSON, model error, extra/missing keys, leaked movie title, exact English/Chinese reuse in concepts, provider URL, control characters, and errors that never echo dialogue or raw payloads.
- [ ] Run `npm test -- tests/workbench-ollama.test.ts` and confirm RED.
- [ ] Implement a 60-second abortable `/api/generate` call with `{ stream:false, format:'json' }`; the prompt contains indexed English cues and requests only indexed translation/concept fields. Re-associate by index and never read English from model output.
- [ ] Validate endpoint origin from configuration, cap response bytes, reject redirects to another origin, and produce controlled `OllamaPlanError` codes.
- [ ] Run focused tests, `npm run typecheck`, and `git diff --check`.
- [ ] Commit: `feat: plan bilingual workbench scenes`.

### Task 3: Incremental Candidate Pools And Confirmation State

**Files:**
- Create: `src/workbench/candidate-pool.ts`
- Create: `src/workbench/vecteezy-candidates.ts`
- Create: `tests/workbench-candidate-pool.test.ts`
- Create: `tests/workbench-vecteezy-candidates.test.ts`

**Interfaces:**

```typescript
export interface CandidateReference {
  provider: 'vecteezy'; resourceId: number; runId: string; page: number
  title: string | null; previewId: string | null; orientation: string | null
  licenseType: string | null; aiGenerated: boolean | null; score: number
}
export interface SceneCandidateState {
  pages: CandidateReference[][]; selected?: { runId: string; resourceId: number }
  confirmed?: { runId: string; resourceId: number }; hasNextPage: boolean
}
export function appendCandidatePage(state: SceneCandidateState, page: CandidateReference[]): SceneCandidateState
export function selectSceneCandidate(state: SceneCandidateState, input: { runId: string; resourceId: number }): SceneCandidateState
export function confirmSceneCandidate(state: SceneCandidateState): SceneCandidateState
```

- [ ] Test first: initial exactly eight, second/third page append, cross-page dedupe, stable ordering, recommendation movement without selection movement, origin run ownership, selecting unknown candidates, replacement clearing confirmation, and all-scenes-confirmed gating.
- [ ] Run both focused files and observe RED.
- [ ] Add a paged local Vecteezy adapter that uses the existing authenticated Edge workflow, keeps preview URLs only in an in-memory UUID registry, and exposes stable candidate fields. Add `page` and `pageSize=8` to the hosted matching contract without changing existing requests or v1 response validation.
- [ ] Ensure each later-page selection calls `select-video-asset` using that candidate's owning run ID.
- [ ] Run focused tests plus existing `tests/video-asset-*.test.ts tests/vecteezy.test.ts tests/video-production-api.test.ts`.
- [ ] Commit: `feat: support incremental scene candidates`.

### Task 4: Version-2 Local Artifacts And Task History

**Files:**
- Create: `src/workbench/artifacts-v2.ts`
- Create: `tests/workbench-artifacts-v2.test.ts`
- Modify: `src/video-artifacts.ts` only for reusable exported containment helpers if required
- Modify: `.gitignore` only if a new generated path is introduced

**Interfaces:**

```typescript
export type WorkbenchStage = 'planning' | 'review' | 'starting' | 'preflight' |
  'downloading' | 'probing' | 'rendering' | 'validating' | 'completing' |
  'completed' | 'failed'
export interface WorkbenchManifest {
  version: 2; taskId: string; renderId: string | null; requestDigest: string
  theme: string; aspectRatio: '9:16' | '16:9'; width: number; height: number
  sceneCount: number; passage: SelectedPassage; scenes: WorkbenchScene[]
  sources: WorkbenchSource[]; output?: WorkbenchOutput; stage: WorkbenchStage
  failure?: { code: string; message: string; retryable: boolean }
  createdAt: string; updatedAt: string
}
export interface WorkbenchReviewState { version: 1; taskId: string; scenes: SceneCandidateState[] }
export async function createWorkbenchTask(root: string, manifest: WorkbenchManifest): Promise<void>
export async function readWorkbenchTask(root: string, taskId: string): Promise<WorkbenchManifest>
export async function listWorkbenchTasks(root: string): Promise<WorkbenchManifest[]>
export function nextWorkbenchStage(manifest: WorkbenchManifest, files: LocalFileState): WorkbenchStage
```

- [ ] Test first: v1 manifests still parse unchanged; v2 validates UUID ownership, aspect/dimensions, 5-10 scenes, one track, consecutive cues, exact durations, translations/concepts, relative artifact keys, hashes, selection/run ownership, formal reservations, nullable audio codec, and stage-specific requirements.
- [ ] Cover atomic manifest/review writes, concurrent update serialization, path containment/symlink rejection, preview/signed URL redaction, completed immutability, deterministic history ordering, corrupt history isolation, verified-file reuse, uncertain reservation behavior, and completion-only retry.
- [ ] Run focused tests and confirm RED.
- [ ] Implement v2 in a separate parser and writer; do not widen the v1 discriminant. Use `video-runs/<taskId>/manifest-v2.json` and `review-state.json` beneath registered paths.
- [ ] Run `tests/video-artifacts.test.ts` together with the new suite, typecheck, and diff check.
- [ ] Commit: `feat: persist resumable workbench tasks`.

### Task 5: Additive Supabase Version-2 Production Contract

**Files:**
- Create: `supabase/migrations/20260721055220_local_video_workbench_v2.sql`
- Create: `supabase/tests/database/video_production_v2.sql`
- Create: `supabase/functions/_shared/video-production-v2.ts`
- Modify: `supabase/functions/_shared/video-production-repository.ts`
- Modify: `supabase/functions/_shared/video-production-handler.ts`
- Modify: `src/video-production-api.ts`
- Create: `tests/video-production-v2-migration-static.test.ts`
- Create: `tests/video-production-v2-contract.test.ts`
- Modify: `tests/video-production-handler.test.ts`
- Modify: `tests/video-production-api.test.ts`

**Interfaces:**

```typescript
export type VideoProductionV2Request =
  | { action: 'startV2'; requestDigest: string; theme: string; aspectRatio: '9:16' | '16:9'; width: number; height: number; sceneCount: number; sourceTrackId: number; sourceStartCueIndex: number; sourceEndCueIndex: number; expectedDurationMs: number }
  | ({ action: 'recordDownloadV2'; renderId: string; selectionId: number; reservationId: string } & DownloadMetadata)
  | { action: 'beginRenderV2'; renderId: string }
  | { action: 'completeV2'; renderId: string; segments: RenderSegmentInputV2[]; output: RenderOutputInputV2 }
  | { action: 'failV2'; renderId: string; failureCode: string; failureMessage: string }
  | { action: 'retryV2'; renderId: string }
```

- [ ] Write static and contract tests first. Assert exactly six `_v2` RPCs, `security invoker`, empty search paths, revocations, forced RLS compatibility, 5-10 checks, chosen dimensions, consecutive source range, expected duration, reservation IDs, nullable audio codec, and unchanged v1 RPC source.
- [ ] Run focused tests and confirm RED.
- [ ] Add explicit version metadata to jobs/downloads/segments through additive nullable columns or dedicated v2 companion columns with checks scoped by workflow version. Do not rewrite existing completed rows.
- [ ] Implement `start_video_render_v2`, `record_video_asset_download_v2`, `begin_video_render_v2`, `complete_video_render_v2`, `fail_video_render_v2`, and `retry_video_render_v2`. Completion must enforce N downloads and indices `0..N-1`, same track, consecutive cues, exact cue text, cue-equal segment durations, contiguous timeline from zero, output duration tolerance, H.264/yuv420p dimensions, and null audio.
- [ ] Add pgTAP for 5-scene landscape and 10-scene portrait success plus each rejection. Include explicit v1 start/complete compatibility assertions and transaction rollback.
- [ ] Extend the Edge parser/repository/handler and local client with v2 methods. Existing action bodies and response validators remain byte-for-byte compatible.
- [ ] Run all video-production tests, all static migration tests, `npm run typecheck`, and `git diff --check`.
- [ ] Commit: `feat: add video production v2 contract`.

### Task 6: Dynamic Formal Download Budget And Preflight

**Files:**
- Modify: `src/vecteezy-download.ts`
- Create: `src/workbench/download-manager.ts`
- Modify: `tests/vecteezy-download.test.ts`
- Create: `tests/workbench-download-manager.test.ts`

**Interfaces:**

```typescript
export class FormalDownloadBudget {
  constructor(limit?: number)
  reserve(requestId: string): void
  get used(): number
  get remaining(): number
}
export async function preflightSelections(input: {
  taskId: string; scenes: readonly ConfirmedScene[]; inspect: ResourceInspector
}): Promise<PreflightResult[]>
export async function downloadConfirmedScenes(input: {
  taskId: string; scenes: readonly ConfirmedScene[]; budget: FormalDownloadBudget
  artifacts: WorkbenchArtifactStore; client: VecteezyDownloadClient
}): Promise<VerifiedSceneSource[]>
```

- [ ] Test first: limits 5 and 10, reject 4/11, concurrent reserve atomicity, idempotent same reservation, conflict on changed resource, durable reservation before network call, preflight with no formal calls, exactly N formal calls, uncertain calls never silently retried, verified files reused, and aggregate/file limits retained.
- [ ] Run focused tests and observe RED.
- [ ] Parameterize the existing default budget while retaining v1 default four. Build a manager that validates all confirmed candidate ownership before preflight and persists each reservation through the v2 manifest before invoking `/download`.
- [ ] Run existing and new download suites, typecheck, and diff check.
- [ ] Commit: `feat: manage dynamic workbench downloads`.

### Task 7: Dynamic Silent Timeline, ASS, Probe, And Renderer

**Files:**
- Create: `src/workbench/render-plan.ts`
- Modify: `src/ass-subtitles.ts`
- Modify: `src/media-probe.ts`
- Modify: `src/video-renderer.ts`
- Create: `tests/workbench-render-plan.test.ts`
- Modify: `tests/ass-subtitles.test.ts`
- Modify: `tests/media-probe.test.ts`
- Modify: `tests/video-renderer.test.ts`

**Interfaces:**

```typescript
export interface DynamicScene { index: number; durationMs: number; captionEn: string; captionZh: string; sourceInMs: number }
export interface DynamicRenderConfiguration { width: 1080 | 1920; height: 1080 | 1920; frameRate: 30; transitionMs: number }
export function buildDynamicTimeline(scenes: readonly DynamicScene[], config: DynamicRenderConfiguration): TimelineScene[]
export function buildSilentRenderArgs(input: {
  sourcePaths: readonly string[]; assPath: string; finalPath: string
  timeline: readonly TimelineScene[]; config: DynamicRenderConfiguration
}): string[]
export async function renderSilentWorkbenchVideo(input: {
  sourcePaths: readonly string[]; assPath: string; finalPath: string
  timeline: readonly TimelineScene[]; config: DynamicRenderConfiguration
  commands?: RenderCommands
}): Promise<RenderVideoResult>
```

- [ ] Test first: cumulative boundaries for 5 and 10 unequal cue durations; transition cap `min(400, adjacentDuration/4)`; nonfinal handle lengths; no duration loss; one ASS event per cue; exact English; Chinese/source line; 10% safe margins; separate portrait/landscape styles; all audio mapping/filter options absent; and final probe requiring `audioCodec === null`.
- [ ] Run focused tests and observe RED.
- [ ] Add dynamic functions beside v1 fixed render functions. Normalize each source with center-safe cover crop, discard audio, add transition handles, place xfade at cumulative boundaries, encode H.264/yuv420p 30 fps, and map video only.
- [ ] Add real FFmpeg integration fixtures generated with lavfi: five unequal landscape scenes and ten compact portrait scenes. Probe exact cumulative duration within tolerance, dimensions, frame rate, codec/pixel format, null audio, and sampled nonblack frames.
- [ ] Skip real integration only when executables are genuinely absent; the target machine is expected to run it.
- [ ] Run all ASS/probe/renderer tests, typecheck, and diff check.
- [ ] Commit: `feat: render dynamic silent workbench videos`.

### Task 8: Workbench Task Orchestration And Recovery

**Files:**
- Create: `src/workbench/task-service.ts`
- Create: `src/workbench/events.ts`
- Create: `tests/workbench-task-service.test.ts`

**Interfaces:**

```typescript
export interface CreateTaskInput { theme: string; aspectRatio: '9:16' | '16:9'; sceneCount: number }
export interface WorkbenchEvent { sequence: number; taskId: string; stage: WorkbenchStage; message: string; sceneIndex?: number }
export class WorkbenchTaskService {
  create(input: CreateTaskInput): Promise<WorkbenchTaskView>
  loadMore(taskId: string, sceneIndex: number): Promise<WorkbenchTaskView>
  select(taskId: string, sceneIndex: number, candidate: CandidateIdentity, confirmed: boolean): Promise<WorkbenchTaskView>
  produce(taskId: string): Promise<void>
  resume(taskId: string): Promise<void>
}
```

- [ ] Test first with injected fakes: one active task; create order passage -> Ollama -> eight candidates per scene; per-scene partial failure; confirmation gate; replacement invalidation; start/preflight/reserve/download/probe/render/validate/complete order; controlled events; formal count N; failure persistence; resume from each stage; no repeated translation, selection, verified download, render, or completion work.
- [ ] Run focused test and confirm RED.
- [ ] Implement a per-task mutex plus one process-level production mutex. Planning may fail without a render ID or formal reservation. Production errors are sanitized and classified as retryable or selection-required.
- [ ] Keep final path internal; the task view exposes only a final endpoint and basename/integrity metadata.
- [ ] Run focused test, full local pipeline regression, typecheck, and diff check.
- [ ] Commit: `feat: orchestrate workbench video tasks`.

### Task 9: Localhost Control Service And Security Boundary

**Files:**
- Create: `src/workbench/health.ts`
- Create: `src/workbench/http-server.ts`
- Create: `src/workbench/server.ts`
- Create: `tests/workbench-health.test.ts`
- Create: `tests/workbench-http.test.ts`
- Modify: `.env.example`
- Modify: `package.json`

**Interfaces:**

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

- [ ] Test first using an ephemeral port: localhost binding, boot token injection, same-origin enforcement, session token enforcement, exact JSON keys/content types/body limits, UUID/task/scene bounds, unsupported methods, no arbitrary path or URL proxying, preview allowlist and MIME/size limits, ranged final video responses, SSE replay/heartbeat/disconnect, and redacted errors/logs.
- [ ] Test health probes for Supabase, Ollama model/tags, Vecteezy account/quota, FFmpeg, ffprobe, Microsoft YaHei font, disk space, timeout/degraded states, and the plaintext-dialogue warning.
- [ ] Run focused tests and confirm RED.
- [ ] Implement with Node `http`; use Vite middleware in `--dev` and static `workbench/dist` files otherwise. Listen on `127.0.0.1`, choose the requested or next available port, and print only the local URL and nonsecret readiness summary.
- [ ] Add scripts: `workbench:dev`, `workbench:build`, `workbench:start`, and `test:e2e`.
- [ ] Run HTTP/health tests, typecheck, and diff check.
- [ ] Commit: `feat: serve the local video workbench`.

### Task 10: React Operational Workbench

**Files:**
- Create: `workbench/index.html`
- Create: `workbench/src/main.tsx`
- Create: `workbench/src/App.tsx`
- Create: `workbench/src/api.ts`
- Create: `workbench/src/types.ts`
- Create: `workbench/src/components/StatusBar.tsx`
- Create: `workbench/src/components/TaskRail.tsx`
- Create: `workbench/src/components/CreateToolbar.tsx`
- Create: `workbench/src/components/PassagePanel.tsx`
- Create: `workbench/src/components/SceneReview.tsx`
- Create: `workbench/src/components/ProductionProgress.tsx`
- Create: `workbench/src/components/FinalOutput.tsx`
- Create: `workbench/src/styles.css`
- Create: `workbench/src/App.test.tsx`
- Create: `workbench/src/components/SceneReview.test.tsx`
- Create: `vite.config.ts`
- Modify: `tsconfig.json`
- Modify: `package.json`

- [ ] Install pinned React/Vite/Lucide/Testing Library dependencies and commit the lockfile only with this task.
- [ ] Test first in jsdom: default create values, 5-10 stepper bounds, aspect segmented control, health warning, history reopen, passage metadata and exact bilingual cue order, eight candidate tiles, preview fallback, recommendation marker, cross-page append, dedupe, selection/confirmation replacement, produce disabled/enabled states, stable progress geometry, controlled retry, final player, and no secret/absolute-path fields rendered.
- [ ] Run focused UI tests and confirm RED before components exist.
- [ ] Implement the actual workbench as the first screen: compact status bar, 240 px task rail on desktop, dense unframed main workspace, candidate cards with 8 px or smaller radii, Lucide icon buttons/tooltips, semantic controls, and accessible labels/focus states.
- [ ] Use a neutral white/ink/green/red palette with candidate media carrying most color. Avoid hero layouts, decorative gradients/orbs, nested cards, oversized panel headings, and visible instructional copy.
- [ ] Add responsive rules for 1440x900, 1024x768, and 390x844. Candidate grids use stable aspect-ratio tracks; long titles and captions wrap without overlapping controls.
- [ ] Run UI tests, `npm run workbench:build`, `npm run typecheck`, and `git diff --check`.
- [ ] Review changed TSX files using `vercel:react-best-practices` before commit.
- [ ] Commit: `feat: build the video workbench interface`.

### Task 11: Browser And Full-Stack Verification

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/workbench.spec.ts`
- Create: `tests/fixtures/workbench/*` only for synthetic JSON/media fixtures
- Modify: `README.md`

- [ ] Create deterministic fake provider mode enabled only by `WORKBENCH_FIXTURE_MODE=1`; production startup must reject that mode unless `NODE_ENV=test`.
- [ ] Write Playwright tests for health, task creation, both aspects, 5/10 scene bounds, continuous passage display, initial eight candidates, repeated load-more and dedupe, owning-run selection, all-confirmed gate, progress SSE, controlled failure/resume, history reopen, final video range playback, and no audio indicator.
- [ ] Run the service and tests at desktop `1440x900`, tablet `1024x768`, and narrow `390x844`; assert no horizontal overflow, overlap, clipped controls, blank media grid, or layout shift during progress.
- [ ] Capture screenshots to ignored `test-results/` and visually inspect them. Use browser tools to inspect console/network errors and confirm no secrets, provider URLs, or absolute paths appear.
- [ ] Add operator documentation for `.env`, the explicit plaintext Ollama warning, dev/build/start commands, one-active-task behavior, formal-download accounting, local artifact paths, resume semantics, silent output, remote deployment order, and v1 compatibility.
- [ ] Run `npm test`, `npm run typecheck`, `npm run workbench:build`, and `npm run test:e2e`.
- [ ] Commit: `test: verify the local video workbench`.

### Task 12: Remote Deployment And Live Acceptance

**Files:**
- Modify only deployment documentation or tests if live verification finds a reproducible contract gap.

- [ ] Read the current Supabase CLI/Edge/Postgres changelog before deploying; verify linked project ref is `kwoppqigrtvgmmbnzbpx` and inspect migration status.
- [ ] Run all local tests and a clean production frontend build.
- [ ] Push `20260721055220_local_video_workbench_v2.sql`, deploy `subtitle-passages`, deploy the changed matching function only if pagination changed it, and deploy `video-production-metadata`.
- [ ] Run linked pgTAP `supabase/tests/database/video_production_v2.sql`, `npx supabase db lint --linked --level warning`, and inspect function logs for controlled failures only.
- [ ] Start the real localhost service against configured Supabase/Ollama/Vecteezy and run health. Do not issue formal downloads during a health or planning smoke test.
- [ ] Create one real five-scene task, verify exact passage/translation and eight candidates per scene, but stop before formal production unless all candidate licenses/previews are acceptable. Formal production requires the normal explicit UI confirmations.
- [ ] Re-run all tests after any live fix; commit each fix separately. Do not rewrite migration history after it is pushed.
- [ ] Update the progress ledger with deployed migration/function versions, test totals, local URL, remaining provider quota, and any acceptance step intentionally not spent.
- [ ] Commit: `docs: finish video workbench acceptance` only when documentation changed.

## Final Verification Gate

- [ ] `npm test` passes with all legacy and v2 suites.
- [ ] `npm run typecheck` passes.
- [ ] `npm run workbench:build` passes.
- [ ] `npm run test:e2e` passes at desktop and narrow viewports.
- [ ] Real five-scene landscape and ten-scene portrait FFmpeg tests pass with exact cumulative duration, H.264, `yuv420p`, and no audio stream.
- [ ] Linked v2 pgTAP and Supabase lint pass; v1 rows and RPCs remain valid.
- [ ] Browser screenshots show no overflow, overlap, blank media, secret, raw URL, or absolute path.
- [ ] Local server remains running on `127.0.0.1` and the final response includes its URL.
- [ ] `git status --short`, `git diff --check`, and the commit log show only intentional source/documentation changes; no `.env` or media is tracked.
