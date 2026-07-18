# Subtitle-to-Vecteezy Candidate Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build private Supabase Edge Functions that turn a stored subtitle chunk, raw line, or theme into three Gemma-planned Vecteezy video searches, retain 5-10 fused candidates, and record one manual selection without downloading media.

**Architecture:** Pure TypeScript modules own contracts, planner validation, provider sanitization, and weighted RRF. Private service-role-only PostgreSQL tables and RPCs own idempotent run state, fallback visual concepts, candidate metadata, and manual selection. Edge entries authenticate with the existing personal token before invoking Gemma, `gte-small`, Postgres, or Vecteezy.

**Tech Stack:** Supabase Edge Runtime/Deno, TypeScript 7, Vitest 4, PostgreSQL 17, pgvector, pgTAP, `Supabase.ai.Session`, Ollama `gemma4:12b`, Vecteezy API V2.

## Global Constraints

- Authenticate every endpoint with `SUBTITLE_PERSONAL_TOKEN` / `x-subtitle-token` before parsing source text, inference, database access, or external HTTP.
- Use `gemma4:12b` as the primary planner and built-in normalized 384-dimensional `gte-small` only for the English fallback concept library.
- Emit exactly one `literal`, one `action`, and one `metaphor` query, each in English and at most 180 characters.
- Search `GET https://api.vecteezy.com/v2/{account_id}/resources` with `content_type=video`, `sort_by=relevance`, `license_type=commercial`, `family_friendly=true`, `duration=3_15`, and `per_page=10`.
- Fuse lanes with weighted RRF using `k=60` and weights `literal=0.40`, `action=0.40`, `metaphor=0.20`; retain 5-10 candidates.
- Enrich only retained candidates with read-only resource-detail calls at concurrency four.
- Never call `/download`, persist preview/thumbnail URLs, persist raw provider payloads, send Vecteezy metadata to a model, or add media rendering.
- Keep all five new tables force-RLS and service-role only, with no `anon` or `authenticated` policies or grants.
- Keep `@supabase/supabase-js` pinned to `2.110.2` in Edge imports and add no new npm dependency.
- The hosted Ollama endpoint must reject unauthenticated requests before `AI_INFERENCE_API_HOST` is configured for production.
- Follow strict red-green-refactor: every production behavior starts with a failing test and each task ends in a focused commit.

## File Map

- `supabase/functions/_shared/video-assets.ts`: request, planner-output, candidate, response, and selection contracts.
- `supabase/functions/_shared/video-planner.ts`: prompt creation, one repair attempt, Supabase AI and authenticated Ollama transports, and English fallback selection.
- `supabase/functions/_shared/visual-concept-seeds.ts`: the 24 curated fallback concepts.
- `supabase/functions/_shared/vecteezy.ts`: V2 search/detail HTTP client and response allowlisting.
- `supabase/functions/_shared/weighted-rrf.ts`: deterministic three-lane fusion.
- `supabase/functions/_shared/video-asset-repository.ts`: typed service-role table/RPC operations.
- `supabase/functions/_shared/video-asset-matching.ts`: idempotent orchestration without HTTP concerns.
- `supabase/functions/match-video-assets/index.ts`: authenticated matching entry.
- `supabase/functions/select-video-asset/index.ts`: authenticated manual-selection entry.
- `supabase/functions/seed-visual-concepts/index.ts`: authenticated operator endpoint that embeds and upserts the 24 fallback concepts.
- `supabase/migrations/*_video_asset_matching.sql`: CLI-generated private schema and RPC migration; do not invent the timestamp manually.
- `supabase/tests/database/video_asset_matching.sql`: pgTAP security and behavior coverage.
- `tests/video-assets-contract.test.ts`: request and planner schema coverage.
- `tests/video-planner.test.ts`: prompt, repair, transport, and fallback coverage.
- `tests/vecteezy.test.ts`: provider URL, timeout, allowlist, and detail enrichment coverage.
- `tests/weighted-rrf.test.ts`: fusion and deterministic ordering coverage.
- `tests/video-asset-matching.test.ts`: orchestration and failure-state coverage.
- `tests/video-assets-entry-static.test.ts`: Edge entry dependency and auth-order checks.
- `tests/video-assets-migration-static.test.ts`: migration privilege and download-absence checks.
- `tests/deployment-docs.test.ts`: deployment order, secrets, and smoke-test documentation checks.
- `README.md`: operator setup, endpoint examples, security gate, and rollback notes.

---

### Task 1: Request And Planner Contracts

**Files:**
- Create: `supabase/functions/_shared/video-assets.ts`
- Create: `tests/video-assets-contract.test.ts`

**Interfaces:**
- Consumes: untrusted JSON request and untrusted planner JSON.
- Produces: `parseVideoAssetRequest(value): VideoAssetRequest`, `parseVisualPlan(value, context): VisualPlan`, `parseSelectionRequest(value): VideoAssetSelectionRequest`, `VideoAssetError`, and shared response/provider types.

- [ ] **Step 1: Write the failing contract tests**

Create tests that prove the exact request union and planner constraints:

```typescript
import { describe, expect, it } from 'vitest'
import {
  parseSelectionRequest,
  parseVideoAssetRequest,
  parseVisualPlan,
} from '../supabase/functions/_shared/video-assets.js'

const validPlan = {
  visualIntent: {
    subject: 'a solitary adult', action: 'opening curtains', setting: 'a quiet room',
    mood: 'renewed hope', lighting: 'soft sunrise', shot: 'medium cinematic shot',
  },
  queries: [
    { kind: 'literal', term: 'solitary person opening curtains sunrise quiet room video' },
    { kind: 'action', term: 'person stepping into morning light hopeful fresh start video' },
    { kind: 'metaphor', term: 'green sprout emerging after rain sunrise renewal macro video' },
  ],
}

describe('video asset request', () => {
  it('accepts a chunk plus a refining theme and supplies eight candidates', () => {
    expect(parseVideoAssetRequest({ subtitleChunkId: 12, theme: 'hope' })).toEqual({
      subtitleChunkId: 12, theme: 'hope', candidateCount: 8,
    })
  })

  it.each([
    {},
    { subtitleChunkId: 1, text: 'duplicate source' },
    { text: '' },
    { text: 'x'.repeat(1001) },
    { theme: 'x'.repeat(301) },
    { theme: 'hope', candidateCount: 4 },
    { theme: 'hope', candidateCount: 11 },
  ])('rejects invalid request %#', value => {
    expect(() => parseVideoAssetRequest(value)).toThrow('invalid request')
  })
})

describe('visual plan', () => {
  it('accepts exactly one query of each kind', () => {
    expect(parseVisualPlan(validPlan, { sourceText: 'hope', forbiddenTerms: [] })).toEqual(validPlan)
  })

  it('rejects duplicate kinds, quoted dialogue, source movie titles, and invented traits', () => {
    expect(() => parseVisualPlan({ ...validPlan, queries: [validPlan.queries[1], validPlan.queries[1], validPlan.queries[2]] }, { sourceText: 'hope', forbiddenTerms: [] })).toThrow()
    expect(() => parseVisualPlan({ ...validPlan, queries: [{ kind: 'literal', term: '"We begin again" film clip' }, validPlan.queries[1], validPlan.queries[2]] }, { sourceText: 'hope', forbiddenTerms: [] })).toThrow()
    expect(() => parseVisualPlan({ ...validPlan, queries: [{ kind: 'literal', term: 'The Synthetic Movie sunrise scene' }, validPlan.queries[1], validPlan.queries[2]] }, { sourceText: 'hope', forbiddenTerms: ['The Synthetic Movie'] })).toThrow()
    expect(() => parseVisualPlan({ ...validPlan, queries: [{ kind: 'literal', term: 'young woman opening curtains' }, validPlan.queries[1], validPlan.queries[2]] }, { sourceText: 'a person finds hope', forbiddenTerms: [] })).toThrow()
  })
})

describe('manual selection request', () => {
  it('accepts a UUID, positive resource ID, and a short note', () => {
    expect(parseSelectionRequest({ runId: 'd62a53a1-08fb-4bee-a1ed-d8ba13de85f2', providerResourceId: 42, note: 'Best opening image' })).toEqual({
      runId: 'd62a53a1-08fb-4bee-a1ed-d8ba13de85f2', providerResourceId: 42, note: 'Best opening image',
    })
  })
})
```

- [ ] **Step 2: Run the contract tests and verify RED**

Run: `npm test -- tests/video-assets-contract.test.ts`

Expected: FAIL because `supabase/functions/_shared/video-assets.ts` does not exist.

- [ ] **Step 3: Implement the minimal contracts**

Define these exact public types and validation entry points:

```typescript
export type QueryKind = 'literal' | 'action' | 'metaphor'

export interface VideoAssetRequest {
  subtitleChunkId?: number
  text?: string
  theme?: string
  candidateCount: number
}

export interface VisualIntent {
  subject: string
  action: string
  setting: string
  mood: string
  lighting: string
  shot: string
}

export interface VisualQuery { kind: QueryKind; term: string }
export interface VisualPlan { visualIntent: VisualIntent; queries: VisualQuery[] }
export interface PlanValidationContext { sourceText: string; forbiddenTerms: string[] }

export class VideoAssetError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'VideoAssetError'
  }
}
```

Implement object/UUID/safe-integer/string helpers locally, trim accepted strings,
reject unknown request combinations, require query kinds to equal the set
`literal,action,metaphor`, reject quotes and terms over 180 characters, reject
case-insensitive forbidden phrases, and reject protected descriptors absent from
the normalized source lexicon. Use this fixed protected set:

```typescript
const protectedDescriptors = new Set([
  'boy', 'girl', 'man', 'woman', 'male', 'female', 'young', 'old',
  'asian', 'black', 'white', 'latino', 'disabled', 'blind', 'deaf',
])
```

- [ ] **Step 4: Run the focused and full tests**

Run: `npm test -- tests/video-assets-contract.test.ts`

Expected: PASS.

Run: `npm test`

Expected: all existing and new tests PASS.

- [ ] **Step 5: Commit the contract boundary**

```bash
git add supabase/functions/_shared/video-assets.ts tests/video-assets-contract.test.ts
git commit -m "feat: define video asset matching contracts"
```

---

### Task 2: Vecteezy Client And Weighted RRF

**Files:**
- Create: `supabase/functions/_shared/vecteezy.ts`
- Create: `supabase/functions/_shared/weighted-rrf.ts`
- Create: `tests/vecteezy.test.ts`
- Create: `tests/weighted-rrf.test.ts`

**Interfaces:**
- Consumes: validated English query terms, `VECTEEZY_ACCOUNT`, `VECTEEZY_API_KEY`, injected `fetch`, and sanitized search resources.
- Produces: `searchVecteezy`, `getVecteezyResource`, `enrichVecteezyResources`, `fuseVecteezyLanes`, `VecteezySearchResource`, and `FusedCandidate`.

- [ ] **Step 1: Write failing provider tests**

Test an injected fetch implementation and assert the exact URL contract:

```typescript
it('uses only the read-only V2 search endpoint and bearer authorization', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({
    page: 1, last_page: 1, per_page: 10, total_resources: 1,
    resources: [{ id: 7, title: null, content_type: 'video', preview_url: 'https://preview.test/7.mp4', file_metadata: { available_file_types: [{ extension: 'mp4', size_in_bytes: 123 }], available_download_sizes: [{ id: 'hd', width: 1920, height: 1080 }] } }],
  }))

  const page = await searchVecteezy('person walking sunrise', {
    accountId: '123', apiKey: 'secret', fetcher,
  })

  const [url, init] = fetcher.mock.calls[0]
  expect(String(url)).toContain('https://api.vecteezy.com/v2/123/resources?')
  expect(String(url)).toContain('content_type=video')
  expect(String(url)).toContain('license_type=commercial')
  expect(String(url)).toContain('duration=3_15')
  expect(String(url)).not.toContain('/download')
  expect(init.headers.authorization).toBe('Bearer secret')
  expect(page.resources[0].stable.title).toBeNull()
  expect(page.resources[0].ephemeral.previewUrl).toBe('https://preview.test/7.mp4')
})
```

Add cases for malformed resource IDs, nullable titles, unknown raw fields,
`size_in_bytes` to `sizeInBytes`, string download-size IDs, provider non-2xx
responses, ten-second aborts, detail enrichment concurrency of four, and detail
failure leaving optional fields null.

- [ ] **Step 2: Write failing RRF tests**

```typescript
it('rewards resources returned by more than one lane and breaks ties deterministically', () => {
  const fused = fuseVecteezyLanes([
    { kind: 'literal', weight: 0.4, resources: [resource(10), resource(20)] },
    { kind: 'action', weight: 0.4, resources: [resource(20), resource(30)] },
    { kind: 'metaphor', weight: 0.2, resources: [resource(30), resource(10)] },
  ], 5)

  expect(fused.map(item => item.providerResourceId)).toEqual([20, 10, 30])
  expect(fused[0].matchedBy).toEqual(['literal', 'action'])
  expect(fused[0].score).toBeCloseTo(0.4 / 62 + 0.4 / 61)
})
```

- [ ] **Step 3: Run focused tests and verify RED**

Run: `npm test -- tests/vecteezy.test.ts tests/weighted-rrf.test.ts`

Expected: FAIL because both shared modules are missing.

- [ ] **Step 4: Implement provider sanitization and read-only calls**

Use these exact stable/ephemeral boundaries:

```typescript
export interface StableVecteezyResource {
  providerResourceId: number
  title: string | null
  contentType: 'video'
  licenseType: string | null
  aiGenerated: boolean | null
  orientation: string | null
  tags: string[]
  fileTypes: Array<{ extension: string; sizeInBytes: number }>
  downloadSizes: Array<{ id: string; width: number; height: number }>
}

export interface VecteezySearchResource {
  stable: StableVecteezyResource
  ephemeral: { previewUrl: string | null; thumbnailUrl: string | null }
}
```

Build URLs only from the constant base `https://api.vecteezy.com`, the validated
numeric account ID, and `URLSearchParams`. Pass `Authorization: Bearer <key>`,
`Accept: application/json`, and `AbortSignal.timeout(10_000)`. The source file
must not contain any `/download`, `/download_info`, or `/download_status` string.

After fusion, implement a four-worker index queue for detail calls. Merge only
`license_type`, `orientation`, tags, and file metadata from detail; keep preview
URLs exclusively in the ephemeral object.

- [ ] **Step 5: Implement weighted RRF**

For each lane resource at zero-based index `i`, add
`lane.weight / (60 + i + 1)`. Track the minimum one-based rank and a unique list
of matched kinds. Sort by score descending, best rank ascending, then resource
ID ascending, and slice to the validated candidate count.

- [ ] **Step 6: Verify provider and fusion behavior**

Run: `npm test -- tests/vecteezy.test.ts tests/weighted-rrf.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit provider retrieval and fusion**

```bash
git add supabase/functions/_shared/vecteezy.ts supabase/functions/_shared/weighted-rrf.ts tests/vecteezy.test.ts tests/weighted-rrf.test.ts
git commit -m "feat: add Vecteezy search rank fusion"
```

---

### Task 3: Private Database Schema And Atomic RPCs

**Files:**
- Create with CLI: `supabase/migrations/*_video_asset_matching.sql`
- Create: `supabase/tests/database/video_asset_matching.sql`
- Create: `tests/video-assets-migration-static.test.ts`

**Interfaces:**
- Consumes: ready `subtitle_chunks`, normalized concept embeddings, run/query/candidate JSON, and selection IDs.
- Produces: five private tables plus `begin_video_search_run`, `finish_video_search_run`, `match_visual_concept`, `upsert_visual_concepts`, and `select_video_asset` RPCs.

- [ ] **Step 1: Write static migration tests before creating the migration**

Resolve exactly one filename ending `_video_asset_matching.sql` from
`supabase/migrations`, then assert the SQL contains all five tables, force RLS,
service-role grants, `security invoker`, `set search_path = ''`, the RRF data
constraints, the composite selection foreign key, and no `security definer`.

- [ ] **Step 2: Write the failing pgTAP contract**

Start with `select plan(60);` and cover:

```sql
select has_table('public', 'visual_concepts', 'visual concepts table exists');
select has_table('public', 'video_search_runs', 'video search runs table exists');
select has_table('public', 'video_search_queries', 'video search queries table exists');
select has_table('public', 'video_search_candidates', 'video candidates table exists');
select has_table('public', 'video_asset_selections', 'video selections table exists');
select ok(
  not has_function_privilege('anon', 'public.begin_video_search_run(bigint,text,text,text,integer,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.begin_video_search_run(bigint,text,text,text,integer,text,text)', 'execute')
  and has_function_privilege('service_role', 'public.begin_video_search_run(bigint,text,text,text,integer,text,text)', 'execute'),
  'only service role executes begin run'
);
```

Also test forced RLS and absent policies on every table, no table/sequence access
for `anon` or `authenticated`, exact query kinds, candidate count 5-10, one
query kind per run, one provider resource per run, failed runs excluded from
idempotency, stale planning recovery, atomic finish, concept cosine ordering,
and selection ownership.

- [ ] **Step 3: Run the static test and verify RED**

Run: `npm test -- tests/video-assets-migration-static.test.ts`

Expected: FAIL because no matching migration exists.

- [ ] **Step 4: Generate the migration with the installed CLI**

Run: `npx supabase migration new video_asset_matching`

Expected: the CLI prints the exact new timestamped path. Use that generated path
for every remaining step; never rename it to a hand-written timestamp.

- [ ] **Step 5: Implement the five-table schema**

Use the columns and constraints from the approved design. Add these database
integrity details:

```sql
create unique index video_search_runs_active_digest_idx
on public.video_search_runs (input_digest, prompt_version)
where status in ('planning', 'completed', 'degraded');

alter table public.video_search_candidates
  add constraint video_search_candidates_run_id_id_key unique (run_id, id);

alter table public.video_asset_selections
  add constraint video_asset_selections_candidate_owner_fkey
  foreign key (run_id, candidate_id)
  references public.video_search_candidates(run_id, id)
  on delete cascade;
```

Require 64 lowercase hexadecimal characters for `input_digest`, finite positive
scores, positive ranks, the exact provider value `vecteezy`, and three allowed
query kinds. Store file types/download sizes as allowlisted JSON arrays and title
as nullable text.

- [ ] **Step 6: Implement atomic service-role RPCs**

`begin_video_search_run` must mark `planning` rows older than five minutes as
`failed` with `failure_code='stale_planning'`, insert with the partial unique
index, and return `(run_id uuid, status text, is_existing boolean)`.

`finish_video_search_run` accepts terminal status, planner fields, timing fields,
three query records, and zero to ten candidates. Validate JSON array lengths and
candidate ownership, insert associated rows, and update the run in one PL/pgSQL
transaction.

`match_visual_concept` returns the nearest enabled concept ordered by
`embedding <=> query_embedding`, with similarity `1 - distance`, limited to one.

`upsert_visual_concepts` casts each JSON embedding with
`(concept.embedding::text)::extensions.vector` and upserts by `concept_key`.

`select_video_asset` resolves the candidate by run and provider resource ID and
upserts one selection by `run_id`; raise SQLSTATE `P0002` when it is not owned by
the run.

Every function is `security invoker set search_path = ''`. Revoke from `public`,
`anon`, and `authenticated`; grant execute only to `service_role` and `postgres`.

- [ ] **Step 7: Verify schema and database behavior**

Run: `npx supabase db reset`

Expected: all migrations and synthetic seed apply successfully.

Run: `npx supabase test db`

Expected: every pgTAP test passes.

Run: `npm test -- tests/video-assets-migration-static.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the private schema**

```bash
git add supabase/migrations supabase/tests/database/video_asset_matching.sql tests/video-assets-migration-static.test.ts
git commit -m "feat: add private video asset matching schema"
```

---

### Task 4: Visual Planner, Repair, And Fallback Concepts

**Files:**
- Create: `supabase/functions/_shared/visual-concept-seeds.ts`
- Create: `supabase/functions/_shared/video-planner.ts`
- Create: `supabase/functions/seed-visual-concepts/index.ts`
- Create: `tests/video-planner.test.ts`
- Create: `tests/video-assets-entry-static.test.ts`

**Interfaces:**
- Consumes: source/context text, optional theme/movie title, an injected text-generation transport, built-in `gte-small`, and concept RPC rows.
- Produces: `planVisualSearch`, `buildPlannerPrompt`, `createPlannerTransport`, `fallbackVisualPlan`, and exactly 24 `VISUAL_CONCEPT_SEEDS`.

- [ ] **Step 1: Write failing planner tests**

Cover a valid first response, malformed JSON repaired once, duplicate query kinds
repaired once, two invalid responses falling back for English input, non-English
fallback rejection, a 20-second timeout, missing security confirmation for the
Supabase AI transport, missing bearer token for direct Ollama transport, and no
prompt/provider data in thrown errors.

Use a transport function rather than mocking global state:

```typescript
const outputs = [JSON.stringify(invalidPlan), JSON.stringify(validPlan)]
const generate = vi.fn().mockImplementation(async () => outputs.shift())
const plan = await planVisualSearch(
  { sourceText: 'A person finds hope after isolation.', theme: 'renewal', forbiddenTerms: [] },
  { generate, fallback: vi.fn() },
)
expect(plan.plan).toEqual(validPlan)
expect(generate).toHaveBeenCalledTimes(2)
expect(generate.mock.calls[1][0]).toContain('duplicate query kind')
```

- [ ] **Step 2: Run the planner test and verify RED**

Run: `npm test -- tests/video-planner.test.ts`

Expected: FAIL because planner modules do not exist.

- [ ] **Step 3: Add all 24 concept seeds**

Define unique entries for: isolation, reunion, escape, loss, hope, conflict,
discovery, time, memory, transformation, love, courage, fear, freedom, regret,
resilience, betrayal, friendship, ambition, sacrifice, justice, grief, wonder,
and homecoming. Each entry has `conceptKey`, a one-sentence English description,
and concrete `literalQuery`, `actionQuery`, and `metaphorQuery` values. Tests must
assert exactly 24 unique keys and three nonblank terms under 180 characters.

- [ ] **Step 4: Implement planner prompting and one repair**

`buildPlannerPrompt` must include the six visual-intent keys, exact three query
kinds, JSON-only output, English-only search terms, no dialogue/movie/brand
references, no invented protected traits, and the supplied source/context.

`planVisualSearch` calls `generate` once, parses with `JSON.parse`, validates via
`parseVisualPlan`, and on validation failure calls `generate` exactly once more
with the validation messages and malformed structured object. It then calls the
fallback dependency once or throws a controlled `VideoAssetError(502,
'planner_unavailable', 'visual planner unavailable')`.

- [ ] **Step 5: Implement both planner transports behind a security gate**

For `VIDEO_PLANNER_TRANSPORT=supabase-ai`, require
`OLLAMA_GATEWAY_SECURITY_CONFIRMED=true`, instantiate
`new Supabase.ai.Session('gemma4:12b')`, and call:

```typescript
await session.run(prompt, { stream: false, timeout: 20 })
```

For `VIDEO_PLANNER_TRANSPORT=ollama-http`, require `AI_INFERENCE_API_HOST`,
`OLLAMA_AUTH_TOKEN`, and `OLLAMA_MODEL=gemma4:12b`; call `/api/chat` with bearer
authorization, `stream:false`, `format:'json'`, temperature `0.2`, and a maximum
of 600 output tokens. Never include environment values in errors.

- [ ] **Step 6: Implement fallback and the concept seeder**

`fallbackVisualPlan` rejects input that is not printable ASCII with at least one
letter, embeds source plus theme with `gte-small` using `{ mean_pool: true,
normalize: true }`, validates 384 finite numbers, calls `match_visual_concept`,
and maps the returned curated queries to a `VisualPlan`.

The seed function authenticates first, embeds all 24 descriptions with a bounded
four-worker queue, calls `upsert_visual_concepts`, and returns only
`{ seeded: 24, model: 'gte-small' }`. It never accepts seed content from the
request.

- [ ] **Step 7: Verify planner and seed entry**

Run: `npm test -- tests/video-planner.test.ts tests/video-assets-entry-static.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit the visual planner**

```bash
git add supabase/functions/_shared/visual-concept-seeds.ts supabase/functions/_shared/video-planner.ts supabase/functions/seed-visual-concepts/index.ts tests/video-planner.test.ts tests/video-assets-entry-static.test.ts
git commit -m "feat: add visual planning and fallback concepts"
```

---

### Task 5: Matching Orchestration And Repository

**Files:**
- Create: `supabase/functions/_shared/video-asset-repository.ts`
- Create: `supabase/functions/_shared/video-asset-matching.ts`
- Create: `tests/video-asset-matching.test.ts`

**Interfaces:**
- Consumes: `VideoAssetRequest`, planner, provider client, RRF, service-role repository, and SHA-256.
- Produces: `matchVideoAssets(request, dependencies): Promise<VideoAssetMatchResponse>` and repository methods for chunk context, run lifecycle, candidates, and selections.

- [ ] **Step 1: Write failing orchestration tests**

Inject every boundary and cover:

- a fresh three-lane completed run;
- planner fallback producing `degraded` with `fallbackUsed=true`;
- one failed lane producing `degraded` and persisted query failure;
- two failed lanes finishing `failed` and throwing `502`;
- completed idempotent run skipping planner/search and refreshing detail only;
- active run throwing `409` with retry metadata;
- preview URLs present in response candidates but absent from `finishRun` input;
- raw text represented only by its digest in repository calls;
- ready chunk source using one cue before and after plus movie title as forbidden
  context; and
- planner/provider errors mapped to controlled codes without source text.

- [ ] **Step 2: Run orchestration tests and verify RED**

Run: `npm test -- tests/video-asset-matching.test.ts`

Expected: FAIL because matching/repository modules do not exist.

- [ ] **Step 3: Implement the repository boundary**

Define a `VideoAssetRepository` interface with exact methods:

```typescript
export interface VideoAssetRepository {
  loadChunkContext(chunkId: number): Promise<ChunkPlanningContext | null>
  beginRun(input: BeginRunInput): Promise<BeginRunResult>
  loadRun(runId: string): Promise<PersistedVideoAssetRun>
  finishRun(input: FinishRunInput): Promise<void>
  matchVisualConcept(embedding: number[]): Promise<VisualConceptMatch | null>
  selectCandidate(input: VideoAssetSelectionRequest): Promise<{ selectionId: number }>
}
```

The Supabase implementation uses `.from()` only for read hydration and the five
RPCs for state transitions. Map database snake_case to public camelCase in this
module and replace every PostgREST error with `new Error('database operation
failed')`.

- [ ] **Step 4: Implement orchestration**

Canonicalize the request as JSON with version `1`, prompt version
`visual-plan-v1`, source kind, source ID or raw text, theme, and candidate count;
hash it with SHA-256 and persist only the lowercase digest.

Run three Vecteezy searches with `Promise.allSettled`. Require at least two
fulfilled lanes, fuse successful lanes, enrich retained resources with detail,
strip ephemeral fields before `finishRun`, and return fresh preview URLs only in
the response. Mark status degraded when fallback is used or one lane fails.

For an existing completed/degraded run, load stable rows, make detail calls only
for persisted IDs, and skip planning/search. For existing planning, throw
`VideoAssetError(409, 'run_in_progress', 'video asset search is in progress')`.

- [ ] **Step 5: Verify orchestration**

Run: `npm test -- tests/video-asset-matching.test.ts`

Expected: PASS.

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 6: Commit orchestration**

```bash
git add supabase/functions/_shared/video-asset-repository.ts supabase/functions/_shared/video-asset-matching.ts tests/video-asset-matching.test.ts
git commit -m "feat: orchestrate video candidate matching"
```

---

### Task 6: Match Edge Function

**Files:**
- Create: `supabase/functions/match-video-assets/index.ts`
- Modify: `tests/video-assets-entry-static.test.ts`

**Interfaces:**
- Consumes: shared auth/HTTP helpers, validated request, planner transports, repository, Vecteezy secrets, and matching orchestrator.
- Produces: private `POST /functions/v1/match-video-assets`.

- [ ] **Step 1: Add failing static entry tests**

Assert the entry pins runtime types and `supabase-js@2.110.2`, rejects non-POST,
calls `handleAuthenticatedRequest(request, Deno.env` before `request.json()`,
reads only named server secrets, creates no download URL, and maps
`VideoAssetError` to stable responses.

- [ ] **Step 2: Run entry tests and verify RED**

Run: `npm test -- tests/video-assets-entry-static.test.ts`

Expected: FAIL because the matching entry does not exist.

- [ ] **Step 3: Implement the authenticated entry**

Use this control flow:

```typescript
Deno.serve(async request => {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'only POST is supported')
  }
  return await handleAuthenticatedRequest(request, Deno.env, async () => {
    try {
      const input = parseVideoAssetRequest(await request.json())
      const response = await matchVideoAssets(input, createDependencies(Deno.env))
      return jsonResponse(response)
    } catch (error) {
      if (error instanceof VideoAssetError) {
        return errorResponse(error.status, error.code, error.message)
      }
      if (error instanceof SyntaxError) {
        return errorResponse(400, 'invalid_request', 'invalid request')
      }
      return errorResponse(500, 'video_asset_match_failed', 'video asset matching failed')
    }
  })
})
```

Create the service-role client and model/provider dependencies only inside the
authenticated callback. Do not log request bodies, prompts, provider bodies, or
preview URLs.

- [ ] **Step 4: Verify matching entry and all TypeScript**

Run: `npm test -- tests/video-assets-entry-static.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the matching endpoint**

```bash
git add supabase/functions/match-video-assets/index.ts tests/video-assets-entry-static.test.ts
git commit -m "feat: expose private video asset matcher"
```

---

### Task 7: Manual Selection Edge Function

**Files:**
- Create: `supabase/functions/select-video-asset/index.ts`
- Modify: `tests/video-assets-entry-static.test.ts`
- Modify: `tests/video-asset-matching.test.ts`

**Interfaces:**
- Consumes: `parseSelectionRequest` and `VideoAssetRepository.selectCandidate`.
- Produces: private `POST /functions/v1/select-video-asset` returning run/resource/selection IDs.

- [ ] **Step 1: Add failing selection tests**

Test missing/wrong token before JSON parsing, invalid UUID/resource/note bounds,
successful selection, replacement returning the current selection ID, candidate
ownership SQLSTATE mapped to `404 candidate_not_found`, and no provider/model
calls from this endpoint.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/video-assets-entry-static.test.ts tests/video-asset-matching.test.ts`

Expected: FAIL because the selection entry is missing.

- [ ] **Step 3: Implement the selection entry**

Reuse `handleAuthenticatedRequest`, parse only after authentication, create the
service-role repository, call `selectCandidate`, and return:

```json
{
  "runId": "d62a53a1-08fb-4bee-a1ed-d8ba13de85f2",
  "providerResourceId": 42,
  "selectionId": 9
}
```

Map invalid JSON/contracts to `400`, missing owned candidate to `404`, non-POST
to `405`, and unexpected database failure to a stable `500 selection_failed`.

- [ ] **Step 4: Verify and commit selection**

Run: `npm test -- tests/video-assets-entry-static.test.ts tests/video-asset-matching.test.ts`

Expected: PASS.

```bash
git add supabase/functions/select-video-asset/index.ts tests/video-assets-entry-static.test.ts tests/video-asset-matching.test.ts
git commit -m "feat: record manual video asset selections"
```

---

### Task 8: Operator Documentation And Local Verification

**Files:**
- Modify: `README.md`
- Modify: `tests/deployment-docs.test.ts`

**Interfaces:**
- Consumes: all migration/function/secret names from earlier tasks.
- Produces: reproducible local verification, seeding, deployment, request, selection, and rollback instructions.

- [ ] **Step 1: Add failing documentation assertions**

Require README text for all five secrets/config values, the security confirmation
gate, migration-before-function order, `seed-visual-concepts`, both product
functions, `--no-verify-jwt`, `x-subtitle-token`, 5-10 candidate bounds, three
query kinds, no downloads, and examples that contain no real subtitle dialogue.

- [ ] **Step 2: Run documentation test and verify RED**

Run: `npm test -- tests/deployment-docs.test.ts`

Expected: FAIL because the new workflow is not documented.

- [ ] **Step 3: Document setup and requests**

Document these server-only values without real secrets:

```dotenv
VECTEEZY_ACCOUNT=<account-id>
VECTEEZY_API_KEY=<api-key>
AI_INFERENCE_API_HOST=https://<authenticated-ollama-gateway>
OLLAMA_MODEL=gemma4:12b
VIDEO_PLANNER_TRANSPORT=supabase-ai
OLLAMA_GATEWAY_SECURITY_CONFIRMED=true
```

For direct authenticated fallback, document
`VIDEO_PLANNER_TRANSPORT=ollama-http` and `OLLAMA_AUTH_TOKEN=<bearer-token>`.
Include generic theme requests for matching and selection, table names for
Dashboard inspection, and state explicitly that no download endpoint is called.

- [ ] **Step 4: Run the complete local verification suite**

Run serially on Windows:

```powershell
npm test
npm run typecheck
npx supabase db reset
npx supabase test db
git diff --check
```

Expected: all Vitest, TypeScript, migration, and pgTAP checks PASS with no diff
whitespace errors.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md tests/deployment-docs.test.ts
git commit -m "docs: add video candidate matching workflow"
```

---

### Task 9: Hosted Security Gate, Deployment, And Smoke Evaluation

**Files:**
- No source files unless hosted compilation reveals a reproducible defect; any defect starts with a failing local regression test.

**Interfaces:**
- Consumes: linked project `kwoppqigrtvgmmbnzbpx`, protected Ollama gateway, remote secrets, generated migration, and three Edge Functions.
- Produces: hosted private endpoints, 24 embedded fallback concepts, and evidence that search uses zero Vecteezy downloads.

- [ ] **Step 1: Verify the Ollama security gate before setting secrets**

Call the public `/api/tags` route without credentials.

Expected: HTTP `401` or `403`. If it returns `200`, stop hosted deployment and
report the gate as blocked; local implementation remains complete.

With the configured gateway credential, call `/api/tags` and verify the response
contains `gemma4:12b` without printing the credential or full model response.

- [ ] **Step 2: Inspect CLI commands rather than guessing flags**

Run:

```powershell
npx supabase --version
npx supabase db push --help
npx supabase secrets set --help
npx supabase functions deploy --help
```

Expected: installed CLI `2.109.1` and help output for every command.

- [ ] **Step 3: Push the migration and run advisors**

Run serially:

```powershell
npx supabase migration list
npx supabase db push
npx supabase db lint --linked --level warning
```

Expected: the generated video asset migration is present remotely and no new
security warning is attributable to the five private tables or RPCs.

- [ ] **Step 4: Set remote secrets without printing values**

Set `VECTEEZY_ACCOUNT`, `VECTEEZY_API_KEY`, `AI_INFERENCE_API_HOST`,
`OLLAMA_MODEL`, `VIDEO_PLANNER_TRANSPORT`, and
`OLLAMA_GATEWAY_SECURITY_CONFIRMED`. Set `OLLAMA_AUTH_TOKEN` only for the direct
transport. Confirm names with `npx supabase secrets list`; never print hashes or
values in logs or reports.

- [ ] **Step 5: Deploy and seed serially**

```powershell
npx supabase functions deploy seed-visual-concepts --no-verify-jwt
npx supabase functions deploy match-video-assets --no-verify-jwt
npx supabase functions deploy select-video-asset --no-verify-jwt
```

Invoke `seed-visual-concepts` with the personal token and an empty JSON object.
Expected: `{ "seeded": 24, "model": "gte-small" }`.

- [ ] **Step 6: Verify authentication before valid smoke tests**

Call all three functions once without a token and once with a wrong token.

Expected: every call returns `401`; model, provider, and database side effects are
absent.

- [ ] **Step 7: Run a generic matching and selection smoke test**

Use theme `hope after a long period of isolation` with `candidateCount: 8`.
Expected: status `completed` or `degraded`, exactly three query records, 5-8
unique video candidates, fresh preview URLs in the response, stable metadata in
`video_search_candidates`, and no persisted URL fields.

Select one returned resource ID. Expected: one row in
`video_asset_selections`; selecting another candidate for the same run replaces
that row rather than adding a second.

- [ ] **Step 8: Verify zero downloads and evaluate 20 themes**

Compare Vecteezy account download usage before and after smoke/evaluation.
Expected: unchanged. Evaluate 20 generic themes and record only run ID, latency,
status, fallback flag, and a manual strong-match yes/no. Acceptance requires at
least 16 of 20 runs to have one strongly related top-10 candidate and healthy
planner p95 below 25 seconds.

- [ ] **Step 9: Final verification and publish**

Run `npm test`, `npm run typecheck`, `npx supabase test db`, and
`git status --short --branch`. Push the completed branch only after every local
check passes and hosted smoke evidence is recorded.
