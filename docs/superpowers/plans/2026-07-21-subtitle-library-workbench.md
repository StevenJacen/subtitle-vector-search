# Subtitle Library Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add hybrid quote search, exact-result video creation, and automatic/manual OpenSubtitles synchronization to the local video workbench.

**Architecture:** Keep the browser behind the existing loopback control service. Add authenticated Supabase Edge contracts for sanitized library data and anchored passages, a local search gateway and single-job synchronization controller, then expose them through strict same-origin HTTP/SSE routes consumed by a new React subtitle-library view.

**Tech Stack:** TypeScript, Node.js 22, React 19, Vite 8, Vitest 4, Playwright 1.61, Supabase Edge Functions, Postgres/pgvector, Ollama HTTP, OpenSubtitles REST, FFmpeg.

## Global Constraints

- The server continues to bind only to `127.0.0.1`.
- Provider credentials, provider URLs, local paths, and raw upstream errors never enter browser JSON.
- Existing theme-only video creation and v1/v2 production contracts remain compatible.
- Search accepts 1-500 characters and returns 1-50 results.
- Video tasks contain 5-10 consecutive cues and preserve the selected track/cue anchor.
- Only one subtitle synchronization job runs in the process.
- Automatic synchronization stops on quota, candidate exhaustion, configuration failure, or cooperative operator stop.
- Imported tracks retain `rights_status = 'personal_research'`.
- Verification never calls the formal Vecteezy download endpoint.

---

### Task 1: Authenticated Subtitle Library Search

**Files:**
- Create: `supabase/functions/subtitle-library/index.ts`
- Create: `tests/subtitle-library-entry-static.test.ts`
- Create: `src/workbench/subtitle-library.ts`
- Create: `tests/workbench-subtitle-library.test.ts`
- Modify: `src/workbench/server.ts`

**Interfaces:**
- Produces: `SubtitleLibraryClient.search(input)`, `SubtitleLibraryClient.summary()`, `normalizeSearchQuery(input)`, `SubtitleSearchResponse`, and `SubtitleLibrarySummary`.
- Consumes: existing `hybrid-subtitle-search`, `x-subtitle-token` authentication, Supabase publishable key, and Ollama `/api/generate`.

- [ ] **Step 1: Write failing Edge and local-client contract tests**

```ts
it('returns sanitized ready-library counts behind personal-token auth', () => {
  expect(source).toContain("Deno.serve(async request =>")
  expect(source).toContain(".eq('status', 'ready')")
  expect(source).toContain("required('SUPABASE_SERVICE_ROLE_KEY')")
  expect(source).not.toContain('serviceRoleKey:')
})

it('normalizes Han input and validates ranked hybrid results', async () => {
  const result = await client.search({ query: '面对恐惧', limit: 20 })
  expect(result.normalizedQuery).toBe('facing fear')
  expect(result.results[0]).toMatchObject({ trackId: 7, semanticRank: 1 })
})
```

- [ ] **Step 2: Run the focused tests and observe missing modules**

Run: `npx vitest run tests/subtitle-library-entry-static.test.ts tests/workbench-subtitle-library.test.ts`

Expected: FAIL because the Edge Function and local search gateway do not exist.

- [ ] **Step 3: Implement the protected summary Edge Function**

```ts
return await handleAuthenticatedRequest(request, Deno.env, async () => {
  const client = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'))
  const tracks = await client.from('subtitle_tracks').select('movie_id', { count: 'exact' }).eq('status', 'ready')
  const movies = new Set((tracks.data ?? []).map(row => row.movie_id))
  return jsonResponse({ readyTracks: tracks.count ?? 0, readyMovies: movies.size })
})
```

Keep the service-role value internal. Static tests must verify the common authenticated handler, POST-only method, bounded response fields, and absence of user-row output.

- [ ] **Step 4: Implement the local search gateway**

```ts
export interface SubtitleSearchRequest { query: string; limit: number }
export interface SubtitleSearchResponse {
  originalQuery: string
  normalizedQuery: string
  warning: 'query_normalization_failed' | null
  results: HybridSubtitleSearchResult[]
}

export async function normalizeSearchQuery(input: NormalizeSearchInput): Promise<NormalizedSearchQuery> {
  if (!/\p{Script=Han}/u.test(input.query)) return { query: input.query, warning: null }
  try {
    return { query: await input.translate(input.query), warning: null }
  } catch {
    return { query: input.query, warning: 'query_normalization_failed' }
  }
}
```

Use Ollama `stream: false`, `format: 'json'`, and `think: false`. Validate every movie, cue, timestamp, RRF score, semantic rank, and full-text rank before returning it.

- [ ] **Step 5: Run tests, typecheck, and commit**

Run: `npx vitest run tests/subtitle-library-entry-static.test.ts tests/workbench-subtitle-library.test.ts tests/hybrid-search-contract.test.ts tests/workbench-ollama.test.ts`

Run: `npm run typecheck`

Expected: all focused tests and typecheck pass.

```powershell
git add supabase/functions/subtitle-library/index.ts src/workbench/subtitle-library.ts src/workbench/server.ts tests/subtitle-library-entry-static.test.ts tests/workbench-subtitle-library.test.ts
git commit -m "feat: add subtitle library search gateway"
```

### Task 2: Exact Search-Result Passage Anchors

**Files:**
- Modify: `supabase/functions/_shared/passage-selection.ts`
- Modify: `supabase/functions/subtitle-passages/index.ts`
- Modify: `tests/subtitle-passages-contract.test.ts`
- Modify: `tests/subtitle-passages-entry-static.test.ts`
- Modify: `src/workbench/passage-selection.ts`
- Modify: `src/workbench/task-service.ts`
- Modify: `src/workbench/server.ts`
- Modify: `tests/workbench-task-service.test.ts`
- Modify: `tests/workbench-server.test.ts`
- Modify: `workbench/src/types.ts`

**Interfaces:**
- Produces: optional `sourceAnchor: { trackId; firstCueIndex; lastCueIndex }` on `CreateTaskInput` and `PassageRequest`.
- Consumes: Task 1 result fields `trackId` and ordered `cues[].index`.

- [ ] **Step 1: Add failing anchored-passage tests**

```ts
expect(parsePassageRequest({
  theme: 'hope', sceneCount: 5,
  sourceAnchor: { trackId: 12, firstCueIndex: 40, lastCueIndex: 43 },
})).toEqual({
  theme: 'hope', sceneCount: 5,
  sourceAnchor: { trackId: 12, firstCueIndex: 40, lastCueIndex: 43 },
})
```

Test positive safe integers, ordered indexes, unknown-key rejection, ready-track enforcement, exact movie provenance, midpoint-anchor containment, left/right boundary expansion, ranges wider than the requested scene count, and unchanged theme-only behavior.

- [ ] **Step 2: Run focused tests and observe source-anchor rejection**

Run: `npx vitest run tests/subtitle-passages-contract.test.ts tests/subtitle-passages-entry-static.test.ts tests/workbench-task-service.test.ts`

Expected: FAIL because `sourceAnchor` is not accepted.

- [ ] **Step 3: Implement additive anchored selection**

```ts
export interface PassageSourceAnchor {
  trackId: number
  firstCueIndex: number
  lastCueIndex: number
}

export interface PassageRequest {
  theme: string
  sceneCount: number
  sourceAnchor?: PassageSourceAnchor
}
```

When an anchor is present, query only its ready track, load a bounded neighboring cue window, choose exactly `sceneCount` consecutive cues containing the midpoint cue of the selected range, and build the existing response. A result range wider than `sceneCount` is valid because the midpoint remains deterministic. Do not call hybrid matching in this branch.

- [ ] **Step 4: Propagate the anchor through task creation and digesting**

```ts
export interface CreateTaskInput {
  theme: string
  aspectRatio: '9:16' | '16:9'
  sceneCount: number
  sourceAnchor?: PassageSourceAnchor
}
```

Validate the anchor in both HTTP parsing and task service. Include it in the canonical request digest and send it only to `subtitle-passages`; the stored selected passage remains the source of manifest provenance.

- [ ] **Step 5: Run compatibility tests and commit**

Run: `npx vitest run tests/subtitle-passages-contract.test.ts tests/subtitle-passages-entry-static.test.ts tests/workbench-task-service.test.ts tests/workbench-server.test.ts tests/workbench-http.test.ts`

Run: `npm run typecheck`

Expected: anchored and existing theme-only tests pass.

```powershell
git add supabase/functions/_shared/passage-selection.ts supabase/functions/subtitle-passages/index.ts src/workbench/passage-selection.ts src/workbench/task-service.ts src/workbench/server.ts workbench/src/types.ts tests/subtitle-passages-contract.test.ts tests/subtitle-passages-entry-static.test.ts tests/workbench-task-service.test.ts tests/workbench-server.test.ts
git commit -m "feat: create videos from exact subtitle anchors"
```

### Task 3: Reusable Subtitle Synchronization Controller

**Files:**
- Modify: `src/batch-classics.ts`
- Modify: `tests/batch-classics.test.ts`
- Create: `src/workbench/subtitle-sync.ts`
- Create: `tests/workbench-subtitle-sync.test.ts`

**Interfaces:**
- Produces: `SubtitleSyncController.start(input)`, `.stop()`, `.snapshot()`, `.events`; `SubtitleSyncInput`; `SubtitleSyncSnapshot`.
- Consumes: existing candidate JSON, OpenSubtitles client, subtitle parser/chunker, `SubtitleApi`, and local batch state.

- [ ] **Step 1: Write failing batch callback and controller tests**

```ts
await expect(controller.start({ mode: 'manual', movie: {
  title: 'Arrival', releaseYear: 2016, imdbId: 'tt2543164',
} })).resolves.toMatchObject({ status: 'running', mode: 'manual' })

expect(() => controller.start({ mode: 'automatic' }))
  .toThrowError('subtitle_sync_already_running')
```

Cover progress events, one active job, manual validation, automatic continuation, quota as `quota_reached`, auth as `configuration_error`, per-movie continuation, cooperative stop, sanitized messages, and snapshot reload.

- [ ] **Step 2: Run focused tests and observe missing controller**

Run: `npx vitest run tests/batch-classics.test.ts tests/workbench-subtitle-sync.test.ts`

Expected: FAIL because structured progress and the controller do not exist.

- [ ] **Step 3: Add reusable batch hooks without changing CLI defaults**

```ts
export interface BatchImportHooks {
  shouldStop?: () => boolean
  onProgress?: (event: BatchImportProgress) => void | Promise<void>
}

export interface SubtitleMovieInput {
  imdbId: string
  title: string
  year: number
}
```

Export a one-movie operation backed by the existing download/import functions. Keep current CLI output, state format, retry rules, and default target/max-attempt behavior unchanged when hooks are absent.

- [ ] **Step 4: Implement the single-job controller and persisted snapshot**

```ts
export type SubtitleSyncStatus = 'idle' | 'running' | 'completed' | 'quota_reached'
  | 'candidate_exhausted' | 'stopped' | 'configuration_error' | 'failed'

export interface SubtitleSyncSnapshot {
  jobId: string | null
  mode: 'automatic' | 'manual' | null
  status: SubtitleSyncStatus
  currentMovie: { imdbId: string; title: string; releaseYear: number } | null
  attempted: number
  succeeded: number
  failed: number
  message: string
  startedAt: string | null
  updatedAt: string
}
```

Persist only this sanitized snapshot. Never persist credentials or upstream response bodies. Complete the current atomic operation before honoring stop.

- [ ] **Step 5: Run tests, typecheck, and commit**

Run: `npx vitest run tests/batch-classics.test.ts tests/workbench-subtitle-sync.test.ts tests/opensubtitles.test.ts tests/supabase-api.test.ts`

Run: `npm run typecheck`

Expected: all synchronization and regressions pass.

```powershell
git add src/batch-classics.ts src/workbench/subtitle-sync.ts tests/batch-classics.test.ts tests/workbench-subtitle-sync.test.ts
git commit -m "feat: add resumable subtitle synchronization"
```

### Task 4: Local Subtitle HTTP and SSE API

**Files:**
- Modify: `src/workbench/http-server.ts`
- Modify: `src/workbench/server.ts`
- Modify: `tests/workbench-http.test.ts`
- Modify: `tests/workbench-server.test.ts`
- Modify: `workbench/src/api.ts`
- Modify: `workbench/src/api.test.ts`
- Modify: `workbench/src/types.ts`

**Interfaces:**
- Produces: browser `WorkbenchApi.searchSubtitles`, `.subtitleLibrary`, `.subtitleSync`, `.startSubtitleSync`, `.stopSubtitleSync`, `.subscribeSubtitleSync`.
- Consumes: Tasks 1-3 clients/controllers.

- [ ] **Step 1: Write failing HTTP authorization and contract tests**

```ts
await expectJson(request('/api/subtitles/search', 'POST', { query: 'hope', limit: 20 }), 200)
await expectJson(unauthorized('/api/subtitles/sync', 'POST', { mode: 'automatic' }), 403)
await expectJson(request('/api/subtitles/sync', 'POST', { mode: 'automatic' }), 202)
```

Cover all six endpoints, exact method handling, no URL query strings, bounded bodies, 409 conflict, 400 manual metadata, SSE heartbeat/cleanup, and redaction.

- [ ] **Step 2: Run HTTP tests and observe 404 responses**

Run: `npx vitest run tests/workbench-http.test.ts workbench/src/api.test.ts`

Expected: FAIL because subtitle routes and API methods are absent.

- [ ] **Step 3: Add strict routes and browser client methods**

```ts
if (path === '/api/subtitles/search') {
  requireMethod(method, 'POST')
  authorizeMutation(request, origin, sessionToken)
  sendJson(response, 200, await options.subtitleLibrary.search(searchInput(await readJson(request))))
  return
}
```

Use the existing mutation token for search because it can send dialogue to Ollama. Summary and snapshot reads are GET. Start/stop are protected POSTs. SSE exposes sanitized controller snapshots only.

- [ ] **Step 4: Wire real runtime dependencies**

Construct the library client from existing Supabase/Ollama configuration and the sync controller from fixed workspace paths. The health probe remains free of OpenSubtitles downloads.

- [ ] **Step 5: Run tests, typecheck, and commit**

Run: `npx vitest run tests/workbench-http.test.ts tests/workbench-server.test.ts workbench/src/api.test.ts`

Run: `npm run typecheck`

Expected: all HTTP/client tests pass.

```powershell
git add src/workbench/http-server.ts src/workbench/server.ts workbench/src/api.ts workbench/src/types.ts tests/workbench-http.test.ts tests/workbench-server.test.ts workbench/src/api.test.ts
git commit -m "feat: expose subtitle library workbench API"
```

### Task 5: React Subtitle Library Experience

**Files:**
- Create: `workbench/src/components/SubtitleLibrary.tsx`
- Create: `workbench/src/components/SubtitleLibrary.test.tsx`
- Create: `workbench/src/components/SubtitleSyncPanel.tsx`
- Create: `workbench/src/components/SubtitleSyncPanel.test.tsx`
- Modify: `workbench/src/App.tsx`
- Modify: `workbench/src/App.test.tsx`
- Modify: `workbench/src/components/CreateToolbar.tsx`
- Modify: `workbench/src/styles.css`

**Interfaces:**
- Produces: two-view navigation, ranked result rows, exact-result creation, automatic/manual sync panel, and live progress.
- Consumes: Task 4 browser API and existing aspect/scene controls.

- [ ] **Step 1: Write failing React interaction tests**

```tsx
await user.click(screen.getByRole('tab', { name: '台词库' }))
await user.type(screen.getByRole('searchbox'), '面对恐惧')
await user.click(screen.getByRole('button', { name: '检索台词' }))
expect(await screen.findByText('The Shawshank Redemption')).toBeVisible()
await user.click(screen.getByRole('button', { name: '用此台词制作' }))
expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({
  sourceAnchor: { trackId: 7, firstCueIndex: 40, lastCueIndex: 43 },
}))
```

Also test rank labels, warning notice, empty/error/loading states, auto sync confirmation, manual IMDb validation, running conflict, progress counts, Stop, keyboard access, and mobile layout.

- [ ] **Step 2: Run component tests and observe missing views**

Run: `npx vitest run workbench/src/App.test.tsx workbench/src/components/SubtitleLibrary.test.tsx workbench/src/components/SubtitleSyncPanel.test.tsx`

Expected: FAIL because the library components do not exist.

- [ ] **Step 3: Implement compact operational views**

Use Lucide `Clapperboard`, `Search`, `RefreshCw`, `Square`, and `Film` icons. Keep cards limited to repeated search results and the sync modal. Preserve fixed control dimensions, visible focus states, and no nested cards.

```tsx
<nav className="view-tabs" role="tablist" aria-label="工作台视图">
  <button role="tab" aria-selected={view === 'production'}>视频制作</button>
  <button role="tab" aria-selected={view === 'library'}>台词库</button>
</nav>
```

Move aspect/scene state to `App` so result creation uses the currently visible defaults. Use the result's first/last cue indexes and track ID in `sourceAnchor`.

- [ ] **Step 4: Add responsive CSS and preserve existing workflows**

At desktop width, show result metadata in aligned columns and dialogue in the flexible center column. Below 720px, stack metadata above dialogue and keep commands on their own row. Ensure no text clipping or horizontal overflow at 390px.

- [ ] **Step 5: Run React tests, typecheck, build, and commit**

Run: `npx vitest run workbench/src/App.test.tsx workbench/src/components/SubtitleLibrary.test.tsx workbench/src/components/SubtitleSyncPanel.test.tsx workbench/src/components/SceneReview.test.tsx`

Run: `npm run typecheck`

Run: `npm run workbench:build`

Expected: component tests, typecheck, and production build pass.

```powershell
git add workbench/src/App.tsx workbench/src/App.test.tsx workbench/src/components/CreateToolbar.tsx workbench/src/components/SubtitleLibrary.tsx workbench/src/components/SubtitleLibrary.test.tsx workbench/src/components/SubtitleSyncPanel.tsx workbench/src/components/SubtitleSyncPanel.test.tsx workbench/src/styles.css
git commit -m "feat: add subtitle library interface"
```

### Task 6: Fixture Runtime and Browser Verification

**Files:**
- Modify: `src/workbench/fixture-runtime.ts`
- Modify: `tests/workbench-fixture-runtime.test.ts`
- Modify: `e2e/workbench.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: deterministic search/sync fixture behavior and documented operator flow.
- Consumes: Tasks 1-5 complete feature surface.

- [ ] **Step 1: Add failing fixture and Playwright scenarios**

Add deterministic fixture results for English and Chinese searches, anchored task creation, auto quota completion, manual success, progress SSE, and Stop. Assert the source movie/track displayed in the created task matches the clicked result.

- [ ] **Step 2: Run focused fixture tests and observe missing behavior**

Run: `npx vitest run tests/workbench-fixture-runtime.test.ts`

Expected: FAIL because subtitle fixtures are absent.

- [ ] **Step 3: Implement fixture-only subtitle services**

Keep the existing guard:

```ts
if (environment.WORKBENCH_FIXTURE_MODE === '1' && environment.NODE_ENV !== 'test') {
  throw new Error('fixture mode is test-only')
}
```

Do not make Supabase, Ollama, OpenSubtitles, or Vecteezy requests in fixture mode.

- [ ] **Step 4: Document startup and subtitle-library operations**

Add concise README instructions for both search modes, exact-result creation, automatic quota stop, manual IMDb input, cooperative stop, local state, and the fact that synchronization consumes OpenSubtitles downloads but no Vecteezy formal calls.

- [ ] **Step 5: Run Playwright and commit**

Run: `npx playwright test`

Expected: production workflows and subtitle library pass at desktop, tablet, and mobile viewports without console errors, Vite overlays, overlap, or horizontal overflow.

```powershell
git add src/workbench/fixture-runtime.ts tests/workbench-fixture-runtime.test.ts e2e/workbench.spec.ts README.md
git commit -m "test: verify subtitle library end to end"
```

### Task 7: Supabase Deployment and Live Read-Only Acceptance

**Files:**
- Modify: `.superpowers/sdd/progress.md` (ignored local ledger)

**Interfaces:**
- Consumes: completed Edge Functions and local workbench.
- Produces: deployed `subtitle-library`, updated `subtitle-passages`, and verified live UI.

- [ ] **Step 1: Review current Supabase changelog and linked project**

Fetch `https://supabase.com/changelog.md`, scan relevant Edge/Postgres changes, confirm project `kwoppqigrtvgmmbnzbpx`, list migrations, and list active functions.

- [ ] **Step 2: Run the complete local verification gate**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run workbench:build`

Run: `npx playwright test`

Run: `git diff --check`

Expected: zero failures; only the pre-existing Windows symlink test may be skipped.

- [ ] **Step 3: Deploy Edge Functions with existing custom authentication**

Deploy `subtitle-library` and `subtitle-passages` with `verify_jwt=false` because both validate the existing `x-subtitle-token` using constant-time comparison. Do not deploy unrelated functions.

- [ ] **Step 4: Run live controlled smoke tests**

Verify unauthenticated calls return 401, library summary returns positive ready counts, English hybrid search returns timestamped results, and an anchored passage returns the selected track with exactly five cues. Search and passage calls must not trigger OpenSubtitles or Vecteezy downloads.

- [ ] **Step 5: Run Supabase advisors and inspect Edge logs**

Run security and performance advisors. Accept INFO-only intentional private-table RLS and unused-index notices; investigate any warning/error. Inspect Edge logs for controlled 200/400/401 responses and no unexpected 5xx.

- [ ] **Step 6: Start the real workbench and perform safe browser acceptance**

Start `npm run workbench:dev`, verify the real page, English search, Chinese normalization/fallback status, summary counts, manual form validation, and no browser errors. Do not start automatic or manual synchronization during acceptance because either action can consume OpenSubtitles download quota.

- [ ] **Step 7: Record results and commit final hardening if needed**

Update the ignored progress ledger with test counts, deployed versions, live statuses, and external limitations. If verification required code fixes, repeat the full gate and commit only those intentional changes.
