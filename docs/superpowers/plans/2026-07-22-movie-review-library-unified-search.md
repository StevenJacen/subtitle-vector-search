# Movie Review Library and Unified Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a private TMDB movie-review corpus in Supabase, retrieve it together with timestamped dialogue, and let a review viewpoint create a video from real matched subtitle cues.

**Architecture:** Review rows and review chunks live in dedicated force-RLS tables and are populated one TMDB page per authenticated Edge invocation. A new unified search Edge Function generates one `gte-small` embedding, searches the selected corpora, and merges typed results with reciprocal-rank fusion. The loopback workbench owns resumable review synchronization and review-to-video orchestration, while the browser receives only bounded, sanitized contracts.

**Tech Stack:** PostgreSQL 17, pgvector 0.8.0, pgTAP, Supabase Edge Runtime/Deno, Supabase built-in `gte-small`, TypeScript 7, Node.js 26, React 19, Vitest 4, Testing Library, Playwright 1.61, Ollama, Vite 8.

## Global Constraints

- Use linked remote Supabase project `kwoppqigrtvgmmbnzbpx` directly; do not require Docker or a local Supabase stack.
- Keep the existing `hybrid-subtitle-search` endpoint and timestamped subtitle schema backward compatible.
- Store reviews, review chunks, and review synchronization state separately from subtitle tables.
- Use `Supabase.ai.Session('gte-small')` with `mean_pool: true` and `normalize: true`; embeddings are exactly 384 dimensions and review inputs remain below the model's 512-token truncation boundary.
- Fetch English TMDB reviews in v1; normalize Han search input to English with the existing Ollama path.
- Process at most one TMDB review page per Edge invocation and make every retry idempotent.
- Authenticate Edge Functions with the existing constant-time `x-subtitle-token` check before provider calls or inference; deploy with `verify_jwt=false` only because this custom authentication remains mandatory.
- Keep tables force-RLS and browser-inaccessible. Public RPC wrappers grant execute only to `service_role`; implementation helpers live in the `private` schema with fixed `search_path`.
- Allow outbound provider requests only to `https://api.themoviedb.org`; validate stored source links against `https://www.themoviedb.org`.
- Keep `TMDB_ACCESS_TOKEN`, service-role credentials, personal tokens, provider URLs containing credentials, local paths, and raw provider errors out of browser responses and committed files.
- A review can inspire a video only after the server finds real timestamped subtitle cues. Review prose is never emitted as movie dialogue or placed in the bilingual subtitle track.
- Preserve search query, scope, results, warnings, and scroll position when the user switches workbench views.
- Include TMDB's required attribution notice and source links. Keep the feature for personal, non-commercial research and do not add bulk review export.
- Local DNS currently resolves TMDB incorrectly. Verify TMDB connectivity from the deployed Edge Function and do not change workstation DNS as part of this feature.

## File Map

- `supabase/migrations/20260722090000_movie_review_library.sql`: review tables, force-RLS, service-role grants, URL/content constraints, sync state, and atomic page ingestion.
- `supabase/migrations/20260722093000_movie_review_search.sql`: private hybrid review retrieval and service-role-only RPC wrapper.
- `supabase/tests/database/movie_reviews.sql`: linked pgTAP for privacy, ingestion idempotency, vector/FTS retrieval, and rank behavior.
- `supabase/functions/_shared/tmdb-reviews.ts`: strict TMDB URL construction, response parsing, review normalization, hashing, and bounded chunking.
- `supabase/functions/_shared/movie-review-sync.ts`: sync request/response contracts and RPC payload mapping.
- `supabase/functions/movie-review-sync/index.ts`: authenticated one-page TMDB synchronization, summary, status, and video-seed reads.
- `supabase/functions/_shared/library-search.ts`: typed unified-search contracts and deterministic cross-corpus RRF merge.
- `supabase/functions/hybrid-library-search/index.ts`: one-embedding dialogue/review retrieval and result hydration.
- `src/workbench/content-library.ts`: strict local client for unified search and Han normalization.
- `src/workbench/movie-reviews.ts`: strict local client for review sync, summaries, and review video seeds.
- `src/workbench/review-sync.ts`: persisted, cooperative, single-owner review synchronization controller and event bus.
- `src/workbench/review-video-seed.ts`: server-side review-theme extraction and same-movie dialogue anchoring with global fallback.
- `src/workbench/http-server.ts`: unified search, review sync/SSE, and create-from-review HTTP routes.
- `src/workbench/server.ts`: production dependency wiring and remote Edge URLs.
- `src/workbench/fixture-runtime.ts`: deterministic unified search, review sync, and review-seeded task fixtures.
- `src/workbench/task-service.ts`: trusted optional review inspiration passed into task creation.
- `src/workbench/artifacts-v2.ts`: persisted review inspiration provenance and validation.
- `workbench/src/types.ts`: browser-visible discriminated result, sync, and task contracts.
- `workbench/src/api.ts`: same-origin API calls and SSE parsing.
- `workbench/src/components/SubtitleLibrary.tsx`: unified scope control, typed rows, independent synchronization actions, and retained state.
- `workbench/src/components/MovieReviewSyncPanel.tsx`: accessible review synchronization dialog.
- `workbench/src/App.tsx`: create-from-review action and content-library navigation copy.
- `workbench/src/styles.css`: compact scope controls, typed result rows, attribution, and responsive behavior.
- `README.md` and `.env.example`: remote secret, deployment, sync, attribution, and usage documentation without secret values.

---

### Task 1: Private Review Storage and Atomic Page Ingestion

**Files:**
- Create: `supabase/migrations/20260722090000_movie_review_library.sql`
- Create: `supabase/tests/database/movie_reviews.sql`
- Create: `tests/movie-review-migration-contract.test.ts`

**Interfaces:**
- Consumes: existing `public.movies(id, imdb_id)` and `extensions.vector(384)`.
- Produces: `movies.tmdb_id`, `movie_reviews`, `movie_review_chunks`, `movie_review_sync_state`, private ingestion helper, and `public.service_ingest_movie_review_page(...) returns jsonb` for Task 3.

- [ ] **Step 1: Write the failing static migration contract**

```ts
const source = readFileSync(resolve('supabase/migrations/20260722090000_movie_review_library.sql'), 'utf8')
expect(source).toContain('alter table public.movies add column tmdb_id bigint')
expect(source).toContain('create table public.movie_reviews')
expect(source).toContain('create table public.movie_review_chunks')
expect(source).toContain('create table public.movie_review_sync_state')
expect(source.match(/enable row level security/g)).toHaveLength(3)
expect(source.match(/force row level security/g)).toHaveLength(3)
expect(source).toContain('create or replace function private.ingest_movie_review_page')
expect(source).toContain('create or replace function public.service_ingest_movie_review_page')
expect(source).toContain('grant execute on function public.service_ingest_movie_review_page')
expect(source).not.toMatch(/grant .* to (anon|authenticated)/)
```

- [ ] **Step 2: Run the contract test and verify the migration is absent**

Run: `npx vitest run tests/movie-review-migration-contract.test.ts`

Expected: FAIL because `20260722090000_movie_review_library.sql` does not exist.

- [ ] **Step 3: Create the schema and privacy boundary**

Implement constrained tables and indexes with this shape:

```sql
alter table public.movies add column tmdb_id bigint;
create unique index movies_tmdb_id_key on public.movies (tmdb_id) where tmdb_id is not null;

create table public.movie_reviews (
  id bigint generated by default as identity primary key,
  movie_id bigint not null references public.movies(id) on delete cascade,
  source text not null default 'tmdb' check (source = 'tmdb'),
  source_review_id text not null check (source_review_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  author text not null check (char_length(author) between 1 and 200),
  author_username text check (author_username is null or char_length(author_username) between 1 and 200),
  rating numeric(3,1) check (rating is null or rating between 0 and 10),
  language_code text not null default 'en' check (language_code = 'en'),
  content text not null check (char_length(content) between 1 and 50000),
  source_url text not null check (source_url ~ '^https://www\.themoviedb\.org/review/[A-Za-z0-9_-]{1,100}$'),
  published_at timestamptz,
  source_updated_at timestamptz,
  fetched_at timestamptz not null default statement_timestamp(),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  rights_status text not null default 'personal_research' check (rights_status = 'personal_research'),
  unique (source, source_review_id)
);

create table public.movie_review_chunks (
  id bigint generated by default as identity primary key,
  review_id bigint not null references public.movie_reviews(id) on delete cascade,
  chunk_index integer not null check (chunk_index between 0 and 199),
  content text not null check (char_length(content) between 1 and 2400),
  fts tsvector generated always as (to_tsvector('english', content)) stored,
  embedding extensions.vector(384) not null,
  unique (review_id, chunk_index)
);
```

Add GIN and HNSW indexes, a foreign-key index for every child relation, bounded sync-state columns, force-RLS, revoked default privileges, and explicit table/sequence privileges for `service_role` only.

- [ ] **Step 4: Implement one-transaction idempotent page ingestion**

The service wrapper accepts a payload built in this exact shape and calls the private helper with a fixed `search_path`:

```ts
const pagePayload = {
  movieId: 4,
  tmdbId: 278,
  runId: '00000000-0000-4000-8000-000000000001',
  page: 1,
  totalPages: 2,
  requestDigest: 'a'.repeat(64),
  reviews: [{
    sourceReviewId: '5be8640e0e0a2633f5009653',
    author: 'Researcher',
    authorUsername: 'researcher',
    rating: 9,
    languageCode: 'en',
    content: 'A patient argument about hope.',
    sourceUrl: 'https://www.themoviedb.org/review/5be8640e0e0a2633f5009653',
    publishedAt: '2018-11-11T00:00:00.000Z',
    sourceUpdatedAt: null,
    contentSha256: 'b'.repeat(64),
    chunks: [{
      chunkIndex: 0,
      content: 'A patient argument about hope.',
      embedding: Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0),
    }],
  }],
}
```

Validate that each embedding JSON array has 384 finite numbers before casting to `extensions.vector`. Lock the sync-state row, reject a page other than its current cursor, return the prior result for the same request digest, replace chunks only for changed hashes, and advance `next_page` only after all accepted rows and chunks are durable.

- [ ] **Step 5: Add linked pgTAP coverage**

Cover table and index existence, `tmdb_id` uniqueness, check constraints, force-RLS, no `anon`/`authenticated` privileges, service-role wrappers, one-page ingestion, changed-content replacement, same-digest retry, wrong-page rejection, cascade deletion, 384-dimension enforcement, and cursor preservation after rejected input. Use synthetic movies and roll back the test transaction.

- [ ] **Step 6: Run static tests**

Run: `npx vitest run tests/movie-review-migration-contract.test.ts tests/private-subtitles-contract.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the storage boundary**

```bash
git add supabase/migrations/20260722090000_movie_review_library.sql supabase/tests/database/movie_reviews.sql tests/movie-review-migration-contract.test.ts
git commit -m "feat: add private movie review storage"
```

### Task 2: Strict TMDB Provider and Review Chunking Contracts

**Files:**
- Create: `supabase/functions/_shared/tmdb-reviews.ts`
- Create: `tests/tmdb-reviews.test.ts`

**Interfaces:**
- Consumes: `fetch`, a bearer access token, IMDb IDs matching `^tt\d+$`, and TMDB v3 JSON.
- Produces: `findTmdbMovie(imdbId, dependencies)`, `fetchTmdbReviewPage(tmdbId, page, dependencies)`, `chunkReview(content)`, and `sha256Hex(content)` for Task 3.

- [ ] **Step 1: Define failing provider tests with fixture responses**

```ts
const provider = tmdbDependencies('token', vi.fn()
  .mockResolvedValueOnce(jsonResponse({ movie_results: [{ id: 278, title: 'The Shawshank Redemption', release_date: '1994-09-23' }] }))
  .mockResolvedValueOnce(jsonResponse({ id: 278, page: 1, total_pages: 1, total_results: 1, results: [{
    id: '5be8640e0e0a2633f5009653', author: 'John', author_details: { username: 'john', rating: 9 },
    content: 'Hope is the central argument.', created_at: '2018-11-11T00:00:00.000Z', updated_at: null,
    url: 'https://www.themoviedb.org/review/5be8640e0e0a2633f5009653',
  }] })))

await expect(findTmdbMovie('tt0111161', provider)).resolves.toMatchObject({ tmdbId: 278 })
await expect(fetchTmdbReviewPage(278, 1, provider)).resolves.toMatchObject({ page: 1, totalPages: 1 })
```

Also test non-TMDB redirects, malformed IDs, malformed top-level responses, per-review malformed-entry warning counts, response-size limits, timeouts, 401, 404, 429 with `Retry-After`, 5xx, invalid source links, blank content, overlong content, paragraph-aware chunk boundaries, and deterministic SHA-256.

- [ ] **Step 2: Run tests and verify missing exports**

Run: `npx vitest run tests/tmdb-reviews.test.ts`

Expected: FAIL because `_shared/tmdb-reviews.ts` does not exist.

- [ ] **Step 3: Implement fixed-origin requests and strict parsing**

```ts
const API_ORIGIN = 'https://api.themoviedb.org'
const SITE_ORIGIN = 'https://www.themoviedb.org'

export async function findTmdbMovie(imdbId: string, deps: TmdbDependencies): Promise<TmdbMovie> {
  if (!/^tt\d+$/.test(imdbId)) throw new TmdbError('invalid_imdb_id')
  const url = new URL(`/3/find/${imdbId}`, API_ORIGIN)
  url.searchParams.set('external_source', 'imdb_id')
  url.searchParams.set('language', 'en-US')
  return parseUniqueMovie(await requestJson(url, deps))
}

export async function fetchTmdbReviewPage(tmdbId: number, page: number, deps: TmdbDependencies) {
  const url = new URL(`/3/movie/${tmdbId}/reviews`, API_ORIGIN)
  url.searchParams.set('language', 'en-US')
  url.searchParams.set('page', String(page))
  return parseReviewPage(await requestJson(url, deps), tmdbId, page)
}
```

Use `Authorization: Bearer`, `redirect: 'error'`, `AbortSignal.timeout(15_000)`, a 1 MiB body cap, stable provider error codes, and no token-bearing error text.
Reject a malformed top-level page. Within a valid page, skip only malformed review entries, return their bounded count as `warningCount`, and continue with valid reviews so one bad provider record cannot discard the rest of the page.

- [ ] **Step 4: Implement bounded sentence-aware chunking**

Normalize CRLF, trim outer whitespace, preserve paragraph order, and emit chunks of 200-1,800 characters when possible with a hard 2,400-character limit. Split overlong sentences at Unicode whitespace, cap at 200 chunks, and reject content that cannot fit those bounds.

- [ ] **Step 5: Run provider tests**

Run: `npx vitest run tests/tmdb-reviews.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit provider contracts**

```bash
git add supabase/functions/_shared/tmdb-reviews.ts tests/tmdb-reviews.test.ts
git commit -m "feat: add strict TMDB review client"
```

### Task 3: One-Page Review Sync Edge Function

**Files:**
- Create: `supabase/functions/_shared/movie-review-sync.ts`
- Create: `supabase/functions/movie-review-sync/index.ts`
- Create: `tests/movie-review-sync-contract.test.ts`
- Create: `tests/movie-review-sync-entry-static.test.ts`

**Interfaces:**
- Consumes: Task 1 RPC, Task 2 provider functions, `TMDB_ACCESS_TOKEN`, and existing Edge auth/http helpers.
- Produces: actions `sync_next`, `summary`, `status`, and `video_seed` with sanitized JSON for Tasks 5 and 7.

- [ ] **Step 1: Write failing request/response contract tests**

```ts
expect(parseReviewSyncRequest({ action: 'sync_next', runId, movieId: 4 }))
  .toEqual({ action: 'sync_next', runId, movieId: 4 })
expect(parseReviewSyncRequest({ action: 'summary' })).toEqual({ action: 'summary' })
expect(parseReviewSyncRequest({ action: 'video_seed', reviewId: 9 }))
  .toEqual({ action: 'video_seed', reviewId: 9 })
expect(() => parseReviewSyncRequest({ action: 'sync_next', runId: 'bad' })).toThrow('invalid_request')
```

Add mapping tests that ensure author, rating, provider ID, source URL, timestamps, hashes, chunks, and 384-number embeddings are the only RPC payload fields.

- [ ] **Step 2: Write the failing static Edge entry test**

Assert pinned Supabase imports, `handleAuthenticatedRequest` preceding token access/provider fetch/inference, `new Supabase.ai.Session('gte-small')`, fixed inference options, one provider page, the exact service RPC name, controlled errors, and no logging of tokens or review bodies.

- [ ] **Step 3: Run tests and verify missing implementation**

Run: `npx vitest run tests/movie-review-sync-contract.test.ts tests/movie-review-sync-entry-static.test.ts`

Expected: FAIL because the shared contract and entry files do not exist.

- [ ] **Step 4: Implement strict actions and one-page synchronization**

```ts
export type ReviewSyncRequest =
  | { action: 'sync_next'; runId: string; movieId?: number }
  | { action: 'summary' }
  | { action: 'status'; movieId: number }
  | { action: 'video_seed'; reviewId: number }

export interface ReviewSyncPageResult {
  runId: string
  allDone: boolean
  movie: { id: number; title: string; releaseYear: number | null; tmdbId: number } | null
  page: number | null
  nextPage: number | null
  totalPages: number | null
  reviewsFetched: number
  warningCount: number
  status: 'running' | 'completed'
}

export interface ReviewLibrarySummary {
  reviewedMovies: number
  totalReviews: number
  embeddedChunks: number
}

export interface ReviewMovieSyncStatus {
  movieId: number
  status: 'pending' | 'running' | 'completed' | 'failed'
  nextPage: number
  totalPages: number | null
  reviewsFetched: number
}

export interface ReviewVideoSeedSource {
  reviewId: number
  sourceReviewId: string
  excerpt: string
  sourceUrl: string
  movie: { id: number; title: string; releaseYear: number | null }
}

const embeddingSession = new Supabase.ai.Session('gte-small')

async function embedChunks(chunks: string[]): Promise<number[][]> {
  return await mapWithConcurrency(chunks, 4, async content => assertEmbedding(
    await embeddingSession.run(content, { mean_pool: true, normalize: true }),
  ))
}
```

For `sync_next`, select a movie with an IMDb ID and an incomplete/mismatched run state, resolve or reuse `tmdb_id`, fetch exactly the current page, embed changed review chunks only, call `service_ingest_movie_review_page`, and return `{runId, allDone, movie, page, nextPage, totalPages, reviewsFetched, warningCount, status}`. Empty review lists still advance the page. `video_seed` returns a bounded excerpt and immutable source metadata, never an embedding or entire oversized review.

- [ ] **Step 5: Map provider failures to stable responses**

Return 400 for invalid input, 401 through the shared auth helper, 404 for unknown movie/review, 409 for cursor conflicts, 422 for missing IMDb/TMDB mappings, 429 with bounded `retryAfterSeconds`, 502 for provider contracts, and 500 for controlled database/inference failures. Do not return raw exceptions.

- [ ] **Step 6: Run focused and existing Edge tests**

Run: `npx vitest run tests/movie-review-sync-contract.test.ts tests/movie-review-sync-entry-static.test.ts tests/edge-entry-static.test.ts tests/hybrid-search-entry-static.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit review synchronization**

```bash
git add supabase/functions/_shared/movie-review-sync.ts supabase/functions/movie-review-sync/index.ts tests/movie-review-sync-contract.test.ts tests/movie-review-sync-entry-static.test.ts
git commit -m "feat: synchronize TMDB reviews by page"
```

### Task 4: Hybrid Review Search and Unified Result Ranking

**Files:**
- Create: `supabase/migrations/20260722093000_movie_review_search.sql`
- Modify: `supabase/tests/database/movie_reviews.sql`
- Create: `supabase/functions/_shared/library-search.ts`
- Create: `supabase/functions/hybrid-library-search/index.ts`
- Create: `tests/library-search-contract.test.ts`
- Create: `tests/hybrid-library-search-entry-static.test.ts`

**Interfaces:**
- Consumes: Task 1 review chunks, existing `hybrid_match_subtitle_chunks`, existing cue mapper, and one 384-dimension query embedding.
- Produces: `LibrarySearchRequest`, discriminated `LibrarySearchResult`, `mergeLibraryResults`, and the `hybrid-library-search` Edge endpoint.

- [ ] **Step 1: Write failing SQL and TypeScript contracts**

```ts
const request = parseLibrarySearchRequest({ query: 'patient hope', scope: 'all', limit: 20 })
expect(request).toEqual({ query: 'patient hope', scope: 'all', limit: 20 })

const merged = mergeLibraryResults([dialogueResult(2)], [reviewResult(1)], 20)
expect(merged.map(result => result.type)).toEqual(['review', 'dialogue'])
expect(merged.every(result => Number.isFinite(result.rrfScore))).toBe(true)
```

Test all scopes, optional positive `movieId`, 500-character queries, 1-50 limits, stable tie breaks, per-review deduplication, absence of embeddings, safe TMDB URLs, and preservation of subtitle cue ranges.

- [ ] **Step 2: Run tests and verify missing search components**

Run: `npx vitest run tests/library-search-contract.test.ts tests/hybrid-library-search-entry-static.test.ts`

Expected: FAIL because the unified search files do not exist.

- [ ] **Step 3: Add the private review hybrid search function**

Implement `private.hybrid_movie_review_search(query_text, query_embedding, match_count, filter_movie_id, full_text_weight, semantic_weight, rrf_k)` with full-text candidates, semantic candidates, weighted RRF, one winning chunk per review, and deterministic ordering. Expose only this wrapper:

```sql
create function public.service_hybrid_movie_review_search(
  query_text text,
  query_embedding extensions.vector(384),
  match_count integer default 20,
  filter_movie_id bigint default null
) returns table (
  review_id bigint, movie_id bigint, movie_title text, release_year integer,
  author text, rating numeric, published_at timestamptz, source_url text,
  excerpt text, similarity double precision, rrf_score double precision,
  semantic_rank bigint, full_text_rank bigint
)
language sql security invoker set search_path = '';
```

Revoke public/anon/authenticated execute and grant only `service_role`.

- [ ] **Step 4: Expand linked pgTAP**

Insert synthetic reviews and deterministic vectors, then assert movie filtering, count clamping, semantic order, full-text order, RRF order, review deduplication, service-role execution, and browser-role denial.

- [ ] **Step 5: Implement typed cross-corpus merge**

```ts
export type LibrarySearchResult = DialogueLibraryResult | ReviewLibraryResult

export interface LibraryMovie {
  id: number
  title: string
  releaseYear: number | null
}

export interface DialogueLibraryResult {
  type: 'dialogue'
  similarity: number
  rrfScore: number
  semanticRank: number | null
  fullTextRank: number | null
  movie: LibraryMovie
  trackId: number
  chunkIndex: number
  startMs: number
  endMs: number
  timestamp: string
  text: string
  cues: Array<{ index: number; startMs: number; endMs: number; text: string }>
}

export interface ReviewLibraryResult {
  type: 'review'
  similarity: number
  rrfScore: number
  semanticRank: number | null
  fullTextRank: number | null
  reviewId: number
  movie: LibraryMovie
  author: string
  rating: number | null
  publishedAt: string | null
  excerpt: string
  sourceUrl: string
}

export interface EdgeLibrarySearchResponse {
  results: LibrarySearchResult[]
}

export function mergeLibraryResults(
  dialogue: DialogueLibraryResult[],
  reviews: ReviewLibraryResult[],
  limit: number,
): LibrarySearchResult[] {
  return [...rankCorpus(dialogue), ...rankCorpus(reviews)]
    .sort((left, right) => right.crossCorpusScore - left.crossCorpusScore
      || left.type.localeCompare(right.type)
      || left.stableId.localeCompare(right.stableId))
    .slice(0, limit)
    .map(({ crossCorpusScore: _score, stableId: _id, ...result }) => result)
}
```

Use equal corpus weights and `k=50`. Preserve each result's native semantic/full-text rank labels.

- [ ] **Step 6: Implement one-embedding unified Edge search**

Authenticate first, parse `{query, scope, limit, movieId?}`, generate one embedding, request up to `min(limit * 3, 50)` candidates from selected corpora, hydrate only subtitle cue ranges, merge for `all`, and return `{results}`. A review-only library with no ready subtitles remains searchable; dialogue scope preserves the existing `empty_ready_track` behavior.

- [ ] **Step 7: Run search tests**

Run: `npx vitest run tests/library-search-contract.test.ts tests/hybrid-library-search-entry-static.test.ts tests/hybrid-search-contract.test.ts tests/search-contract.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit unified retrieval**

```bash
git add supabase/migrations/20260722093000_movie_review_search.sql supabase/tests/database/movie_reviews.sql supabase/functions/_shared/library-search.ts supabase/functions/hybrid-library-search/index.ts tests/library-search-contract.test.ts tests/hybrid-library-search-entry-static.test.ts
git commit -m "feat: add unified dialogue and review search"
```

### Task 5: Resumable Workbench Review Synchronization

**Files:**
- Create: `src/workbench/movie-reviews.ts`
- Create: `src/workbench/review-sync.ts`
- Create: `tests/workbench-movie-reviews.test.ts`
- Create: `tests/workbench-review-sync.test.ts`

**Interfaces:**
- Consumes: Task 3 Edge actions and existing Supabase publishable/personal credentials.
- Produces: `MovieReviewClient`, `ReviewSyncController`, `ReviewSyncSnapshot`, and `ReviewSyncEventBus` for Task 6.

- [ ] **Step 1: Write failing strict-client tests**

```ts
await client.syncNext({ runId, movieId: 4 })
expect(fetchFn).toHaveBeenCalledWith(
  'https://supabase.test/functions/v1/movie-review-sync',
  expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'sync_next', runId, movieId: 4 }) }),
)
await expect(client.summary()).resolves.toEqual({ reviewedMovies: 1, totalReviews: 12, embeddedChunks: 18 })
```

Reject extra fields, invalid counts, provider URLs outside TMDB, oversized bodies, redirects, timeouts, and error envelopes containing unknown raw fields.

- [ ] **Step 2: Write failing controller tests**

Cover single global owner, generated run ID, repeated one-page calls until `allDone`, movie/page counters, rate-limited terminal state, configuration error, cooperative stop after the current page, snapshot recovery, corrupt snapshot fallback, sanitized safe messages, and listener exceptions.

- [ ] **Step 3: Run focused tests and verify missing classes**

Run: `npx vitest run tests/workbench-movie-reviews.test.ts tests/workbench-review-sync.test.ts`

Expected: FAIL because the client and controller do not exist.

- [ ] **Step 4: Implement the strict remote client**

```ts
export class MovieReviewClient {
  async syncNext(input: { runId: string; movieId?: number }): Promise<ReviewSyncPageResult>
  async summary(): Promise<ReviewLibrarySummary>
  async status(movieId: number): Promise<ReviewMovieSyncStatus>
  async videoSeed(reviewId: number): Promise<ReviewVideoSeedSource>
}
```

Use the same headers, response limit, redirect policy, timeout, and private error normalization as `SubtitleLibraryClient`.

- [ ] **Step 5: Implement the persisted controller**

```ts
export type ReviewSyncStatus = 'idle' | 'running' | 'completed' | 'rate_limited'
  | 'stopped' | 'configuration_error' | 'failed'

export interface ReviewSyncSnapshot {
  jobId: string | null
  status: ReviewSyncStatus
  currentMovie: { id: number; title: string; releaseYear: number | null } | null
  pagesFetched: number
  reviewsFetched: number
  moviesCompleted: number
  failed: number
  message: string
  startedAt: string | null
  updatedAt: string
}
```

Persist to `.batch-state/review-sync-snapshot.json`, publish copied snapshots, and finish the current remote page before honoring stop.

- [ ] **Step 6: Run focused and regression tests**

Run: `npx vitest run tests/workbench-movie-reviews.test.ts tests/workbench-review-sync.test.ts tests/workbench-subtitle-sync.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the controller**

```bash
git add src/workbench/movie-reviews.ts src/workbench/review-sync.ts tests/workbench-movie-reviews.test.ts tests/workbench-review-sync.test.ts
git commit -m "feat: add resumable review synchronization"
```

### Task 6: Unified Workbench Search and HTTP Surface

**Files:**
- Create: `src/workbench/content-library.ts`
- Create: `tests/workbench-content-library.test.ts`
- Modify: `src/workbench/http-server.ts`
- Modify: `src/workbench/server.ts`
- Modify: `tests/workbench-http.test.ts`
- Modify: `tests/workbench-server.test.ts`
- Modify: `workbench/src/types.ts`
- Modify: `workbench/src/api.ts`
- Modify: `workbench/src/api.test.ts`

**Interfaces:**
- Consumes: Task 4 unified Edge endpoint and Task 5 review controller.
- Produces: same-origin unified search and review-sync endpoints plus typed browser API methods for Task 8.

- [ ] **Step 1: Write failing unified client tests**

```ts
const response = await client.search({ query: '面对漫长困境的希望', scope: 'all', limit: 20 })
expect(response).toMatchObject({
  originalQuery: '面对漫长困境的希望',
  normalizedQuery: 'hope through a long ordeal',
  results: [{ type: 'review' }, { type: 'dialogue' }],
})
```

Validate discriminated fields exactly, require cues only for dialogue, require HTTPS TMDB source URLs only for reviews, keep Han fallback warnings, and reject more results than requested.

- [ ] **Step 2: Add failing HTTP and browser API tests**

Cover:

```text
POST /api/library/search
GET  /api/reviews/library
GET  /api/reviews/sync
POST /api/reviews/sync
POST /api/reviews/sync/stop
GET  /api/reviews/sync/events
```

Assert mutation session authorization, exact JSON shapes, 32 KiB request limits, 409 duplicate starts, SSE replay/cursors/heartbeats, controlled 404 when dependencies are disabled, and absence of `token`, `secret`, local paths, and raw upstream errors.

- [ ] **Step 3: Run focused tests and verify routes are absent**

Run: `npx vitest run tests/workbench-content-library.test.ts tests/workbench-http.test.ts workbench/src/api.test.ts`

Expected: FAIL on missing unified client methods and routes.

- [ ] **Step 4: Implement the strict unified local client**

```ts
export type LibrarySearchScope = 'all' | 'dialogue' | 'reviews'
export type LibrarySearchResult = DialogueLibraryResult | ReviewLibraryResult

export interface ContentLibrarySearchResponse {
  originalQuery: string
  normalizedQuery: string
  warning: 'query_normalization_failed' | null
  results: LibrarySearchResult[]
}

export class ContentLibraryClient {
  async search(input: { query: string; scope: LibrarySearchScope; limit: number; movieId?: number })
    : Promise<ContentLibrarySearchResponse>
}
```

Factor `normalizeSearchQuery` into a shared exported helper without changing existing subtitle-client behavior.

- [ ] **Step 5: Add server routes and production wiring**

Add optional `contentLibrary` and `reviewSync` dependencies to `WorkbenchHttpServerOptions`, route exact-object parsers, review SSE using the existing event format, and production construction from the existing Supabase URL/publishable/personal settings. The TMDB token remains remote and is not read by the loopback server.

- [ ] **Step 6: Extend browser types and API**

Add `searchLibrary`, `reviewLibrary`, `reviewSync`, `startReviewSync`, `stopReviewSync`, and `subscribeReviewSync` to `WorkbenchApi`. Parse SSE snapshots before invoking listeners and keep the old subtitle methods for regression compatibility.

- [ ] **Step 7: Run service and browser API tests**

Run: `npx vitest run tests/workbench-content-library.test.ts tests/workbench-http.test.ts tests/workbench-server.test.ts workbench/src/api.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the workbench API surface**

```bash
git add src/workbench/content-library.ts tests/workbench-content-library.test.ts src/workbench/http-server.ts src/workbench/server.ts tests/workbench-http.test.ts tests/workbench-server.test.ts workbench/src/types.ts workbench/src/api.ts workbench/src/api.test.ts
git commit -m "feat: expose unified library search in workbench"
```

### Task 7: Trusted Review-to-Video Seed and Provenance

**Files:**
- Create: `src/workbench/review-video-seed.ts`
- Create: `tests/workbench-review-video-seed.test.ts`
- Modify: `src/workbench/task-service.ts`
- Modify: `src/workbench/artifacts-v2.ts`
- Modify: `src/workbench/http-server.ts`
- Modify: `src/workbench/server.ts`
- Modify: `src/workbench/fixture-runtime.ts`
- Modify: `tests/workbench-task-service.test.ts`
- Modify: `tests/workbench-artifacts-v2.test.ts`
- Modify: `tests/workbench-http.test.ts`

**Interfaces:**
- Consumes: `MovieReviewClient.videoSeed`, Ollama JSON generation, `ContentLibraryClient.search`, and existing task creation.
- Produces: `POST /api/tasks/from-review` and optional immutable review inspiration in request digest, manifest, and task view.

- [ ] **Step 1: Write failing seed-selection tests**

```ts
const seed = await service.resolve(9)
expect(seed).toEqual({
  theme: 'hope sustained through institutional confinement',
  sourceAnchor: { trackId: 7, firstCueIndex: 40, lastCueIndex: 42 },
  inspiration: {
    provider: 'tmdb', reviewId: 9, sourceReviewId: '5be8640e0e0a2633f5009653',
    sourceUrl: 'https://www.themoviedb.org/review/5be8640e0e0a2633f5009653',
    movieId: 4, dialogueScope: 'movie',
  },
})
```

Test same-movie search first, global fallback only on no valid cue result, controlled Ollama failure, no-dialogue failure before Vecteezy calls, bounded prompt/excerpt, strict JSON output, and source URL validation.

- [ ] **Step 2: Write failing artifact and HTTP tests**

Add a valid optional manifest field:

```ts
export interface ReviewInspiration {
  provider: 'tmdb'
  reviewId: number
  sourceReviewId: string
  sourceUrl: string
  movieId: number
  dialogueScope: 'movie' | 'all'
}

inspiration?: ReviewInspiration
```

Assert it participates in `requestDigest`, survives create/read/list, is absent for normal and exact-quote tasks, rejects unknown keys/hosts, and never contains review prose. Test `POST /api/tasks/from-review` body `{reviewId, aspectRatio, sceneCount}` with normal mutation authorization.

- [ ] **Step 3: Run focused tests and verify missing seed service**

Run: `npx vitest run tests/workbench-review-video-seed.test.ts tests/workbench-artifacts-v2.test.ts tests/workbench-task-service.test.ts tests/workbench-http.test.ts`

Expected: FAIL on missing seed service, route, and provenance parser.

- [ ] **Step 4: Implement server-side theme extraction and dialogue anchoring**

```ts
const prompt = [
  'Extract one concise English thematic idea from this movie review excerpt.',
  'Return JSON with exactly one theme string of 1-300 characters.',
  JSON.stringify(source.excerpt),
].join('\n')

const sameMovie = await library.search({ query: theme, scope: 'dialogue', limit: 1, movieId: source.movie.id })
const selected = firstDialogue(sameMovie.results)
  ?? firstDialogue((await library.search({ query: theme, scope: 'dialogue', limit: 1 })).results)
```

Reject the action if neither search returns cues. Convert the selected cues to the existing exact `PassageSourceAnchor` so passage duration continues to come from subtitle timestamps.

- [ ] **Step 5: Persist trusted provenance**

Extend internal `CreateTaskInput`, request digest, `WorkbenchManifest`, parser, clone behavior, fixture runtime, and public task mapping with the immutable inspiration object. Keep the complete review body out of every artifact.

- [ ] **Step 6: Add the create-from-review route**

Resolve the trusted seed server-side, call `taskService.create({...seed, aspectRatio, sceneCount})`, and return `{task}` with status 201. Map normalization failure to `review_theme_failed` and missing dialogue to `review_dialogue_not_found`; neither starts candidate matching.

- [ ] **Step 7: Run task pipeline regressions**

Run: `npx vitest run tests/workbench-review-video-seed.test.ts tests/workbench-artifacts-v2.test.ts tests/workbench-task-service.test.ts tests/workbench-http.test.ts tests/video-pipeline.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit review-driven task creation**

```bash
git add src/workbench/review-video-seed.ts tests/workbench-review-video-seed.test.ts src/workbench/task-service.ts src/workbench/artifacts-v2.ts src/workbench/http-server.ts src/workbench/server.ts src/workbench/fixture-runtime.ts tests/workbench-task-service.test.ts tests/workbench-artifacts-v2.test.ts tests/workbench-http.test.ts
git commit -m "feat: create videos from review viewpoints"
```

### Task 8: Unified Library Interface and Review Sync Dialog

**Files:**
- Create: `workbench/src/components/MovieReviewSyncPanel.tsx`
- Create: `workbench/src/components/MovieReviewSyncPanel.test.tsx`
- Modify: `workbench/src/components/SubtitleLibrary.tsx`
- Modify: `workbench/src/components/SubtitleLibrary.test.tsx`
- Modify: `workbench/src/App.tsx`
- Modify: `workbench/src/App.test.tsx`
- Modify: `workbench/src/types.ts`
- Modify: `workbench/src/api.ts`
- Modify: `workbench/src/styles.css`

**Interfaces:**
- Consumes: Tasks 6-7 browser API methods and discriminated results.
- Produces: one preserved library search state, typed result actions, review sync controls, and TMDB attribution.

- [ ] **Step 1: Write failing component tests**

Test the `全部 / 台词 / 影评` segmented control, default `全部`, scope in search requests, dialogue timestamps, review author/rating/date/excerpt/source link, native rank labels, empty/error/loading states, independent subtitle/review sync buttons, and disabled create actions while busy.

```tsx
await user.click(screen.getByRole('radio', { name: '影评' }))
await user.type(screen.getByRole('searchbox'), 'hope')
await user.click(screen.getByRole('button', { name: '搜索内容' }))
expect(api.searchLibrary).toHaveBeenCalledWith({ query: 'hope', scope: 'reviews', limit: 10 })
expect(screen.getByRole('link', { name: '查看 TMDB 来源' })).toHaveAttribute('href', tmdbReviewUrl)
```

- [ ] **Step 2: Write failing App tests for persistence and review creation**

Search, switch to video production, switch back, and assert the query, scope, results, and result action remain present. Click `以此观点制作`, assert `createTaskFromReview({reviewId, aspectRatio, sceneCount})`, then assert the app switches to video production with the returned task.

- [ ] **Step 3: Run UI tests and verify missing controls**

Run: `npx vitest run workbench/src/components/SubtitleLibrary.test.tsx workbench/src/components/MovieReviewSyncPanel.test.tsx workbench/src/App.test.tsx`

Expected: FAIL on missing scope, review row, sync panel, and API action.

- [ ] **Step 4: Implement typed unified rows**

Keep `SubtitleLibrary` mounted under the existing hidden tab panel. Add a real radio-based segmented control, use `result.type` to render `DialogueResultRow` or `ReviewResultRow`, open source links with `target="_blank" rel="noreferrer"`, and use stable keys `dialogue:${trackId}:${chunkIndex}` and `review:${reviewId}`.

- [ ] **Step 5: Implement the review synchronization dialog**

Reuse the focus trap, Escape close, focus restoration, snapshot version guard, SSE subscription, confirmation step, progress counts, cooperative stop, and safe status labels from `SubtitleSyncPanel`. Review synchronization has one automatic mode because it operates only on movies already present in the subtitle library.

- [ ] **Step 6: Add review creation and attribution**

Wire `createTaskFromReview` in `App`, preserve the current aspect ratio and 5-10 scene count, and render this notice in a compact credits row:

```text
This product uses the TMDB API but is not endorsed or certified by TMDB.
```

Link `TMDB` to `https://www.themoviedb.org`.

- [ ] **Step 7: Style and verify responsive layout**

Use existing colors, radii, spacing, button/icon patterns, and table-like result density. Keep fixed toolbar controls stable, allow long review words/URLs to wrap, avoid nested cards, and preserve mobile ordering without overlap at 390x844 and desktop at 1440x900.

- [ ] **Step 8: Run UI and build checks**

Run: `npx vitest run workbench/src/components/SubtitleLibrary.test.tsx workbench/src/components/MovieReviewSyncPanel.test.tsx workbench/src/App.test.tsx workbench/src/api.test.ts`

Run: `npm run typecheck && npm run workbench:build`

Expected: all tests PASS and Vite build completes without warnings introduced by this task.

- [ ] **Step 9: Commit the interface**

```bash
git add workbench/src/components/MovieReviewSyncPanel.tsx workbench/src/components/MovieReviewSyncPanel.test.tsx workbench/src/components/SubtitleLibrary.tsx workbench/src/components/SubtitleLibrary.test.tsx workbench/src/App.tsx workbench/src/App.test.tsx workbench/src/types.ts workbench/src/api.ts workbench/src/styles.css
git commit -m "feat: add unified dialogue and review library UI"
```

### Task 9: Fixture E2E, Documentation, and Full Local Verification

**Files:**
- Modify: `src/workbench/fixture-runtime.ts`
- Modify: `e2e/workbench.spec.ts`
- Modify: `README.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: completed local feature and fixture-only provider behavior.
- Produces: reproducible browser verification and operator documentation without consuming TMDB/Vecteezy quota.

- [ ] **Step 1: Add failing fixture E2E scenarios**

Add deterministic fixture review results and review sync progress. Cover:

1. search `hope`, see dialogue and review rows, filter each scope;
2. switch views twice and retain query/scope/results;
3. create from a review and verify the task passage contains real timestamped cues;
4. open review sync, complete fixture synchronization, and see updated review counts;
5. verify the TMDB attribution and source link.

- [ ] **Step 2: Run E2E and verify fixture gaps**

Run: `npm run test:e2e -- e2e/workbench.spec.ts`

Expected: FAIL on missing fixture review contracts or new UI assertions.

- [ ] **Step 3: Complete fixture runtime behavior**

Return the same strict discriminated shapes as production, implement in-memory review sync snapshots/events, and produce a review-seeded task whose `inspiration.dialogueScope` is `movie`. Never call TMDB, Ollama, Supabase, Vecteezy, or FFmpeg in fixture mode.

- [ ] **Step 4: Document configuration and operation**

Add `TMDB_ACCESS_TOKEN=` to `.env.example` with no value. In README, document official TMDB API use, remote secret setup, migrations, both Edge deployments, unified search scopes, review sync, review-driven video behavior, attribution, personal-research boundary, and the local DNS limitation. Commands must use environment variables rather than literal credentials.

- [ ] **Step 5: Run the full local suite**

Run:

```bash
npm test
npm run typecheck
npm run workbench:build
npm run test:e2e
git diff --check
```

Expected: all tests PASS, typecheck and build succeed, Playwright passes at configured desktop/mobile projects, and `git diff --check` prints nothing.

- [ ] **Step 6: Start or reuse the local development server and verify visually**

Run: `npm run workbench:dev`

Open the emitted loopback URL. Verify desktop and mobile screenshots, no blank areas, no toolbar/result overlap, preserved search state, functioning scope control, accessible review sync dialog, safe external links, and a review-seeded task showing real passage timestamps. Keep the server running for user inspection.

- [ ] **Step 7: Commit fixtures and documentation**

```bash
git add src/workbench/fixture-runtime.ts e2e/workbench.spec.ts README.md .env.example
git commit -m "test: cover movie review workflow"
```

### Task 10: Remote Supabase Deployment, Smoke Test, and Backfill

**Files:**
- Modify if needed after verified findings: `README.md`

**Interfaces:**
- Consumes: completed Tasks 1-9, authenticated Supabase CLI/connector, project `kwoppqigrtvgmmbnzbpx`, and remote `TMDB_ACCESS_TOKEN`/existing secrets.
- Produces: migrated hosted schema, deployed Edge Functions, passing hosted pgTAP, clean advisors, a bounded real review sync, and searchable review data.

- [ ] **Step 1: Review current Supabase changes and linked state**

Read <https://supabase.com/changelog.md> and current docs for Edge Functions, built-in AI models, Postgres/pgvector, RLS, and CLI deployment. Run:

```bash
npx supabase --version
npx supabase migration list --linked
npx supabase db push --dry-run --linked
```

Expected: CLI `2.109.1`, linked project `kwoppqigrtvgmmbnzbpx`, and only the two new migrations pending. Stop and reconcile unexpected remote/local migration differences before applying anything.

- [ ] **Step 2: Verify remote secrets without printing values**

Run `npx supabase secrets list --project-ref kwoppqigrtvgmmbnzbpx` and confirm the user-managed names `TMDB_ACCESS_TOKEN` and `SUBTITLE_PERSONAL_TOKEN` are present. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are platform-provided Edge variables and need not appear in the user-managed secret list. Do not echo or log values. If `TMDB_ACCESS_TOKEN` is missing, set it through the Supabase dashboard or a temporary one-key env file outside the repository, then delete that temporary file.

- [ ] **Step 3: Push migrations and run linked database verification**

```bash
npx supabase db push --linked
npx supabase db query --linked --file supabase/tests/database/movie_reviews.sql
npx supabase db lint --linked --schema public --level warning
```

Expected: migration succeeds, pgTAP finishes with no failed assertions, and lint has no new warning/error attributable to review objects.

- [ ] **Step 4: Deploy both custom-auth Edge Functions**

```bash
npx supabase functions deploy movie-review-sync --no-verify-jwt --project-ref kwoppqigrtvgmmbnzbpx
npx supabase functions deploy hybrid-library-search --no-verify-jwt --project-ref kwoppqigrtvgmmbnzbpx
```

Expected: both deployments succeed. Invalid or absent `x-subtitle-token` calls return 401 before provider access or inference.

- [ ] **Step 5: Run one bounded real TMDB synchronization probe**

Select one existing movie with an IMDb ID and no review sync state, generate a fresh run UUID, invoke `movie-review-sync` once with `sync_next`, and verify exactly one page was attempted. Expected: controlled success with sanitized movie/page counts, or a stable `tmdb_movie_not_found`/`rate_limited` result. Because local TMDB DNS is invalid, provider success must be established from Edge logs and response, not a local direct call.

- [ ] **Step 6: Run review and unified search smoke tests**

If the probe imported at least one review, call `hybrid-library-search` with scopes `reviews`, `dialogue`, and `all`. Verify typed results, valid TMDB source links, timestamped dialogue cues, bounded result counts, no embeddings, and deterministic ordering. Confirm the old `hybrid-subtitle-search` endpoint still returns its original shape.

- [ ] **Step 7: Inspect hosted security and performance**

Use Supabase advisors for both `security` and `performance`. Inspect `pg_policies`, grants, function privileges, foreign-key indexes, vector/GIN indexes, and recent logs. Expected: no browser access to review tables/RPCs, no mutable `search_path`, no secret leakage, and no unexpected 5xx. Investigate every new warning/error before continuing.

- [ ] **Step 8: Start the resumable backfill from the workbench**

Use the review synchronization button to process existing movies. Confirm page/movie counters advance, stop/resume works, and provider rate limiting preserves the current cursor. Do not bypass TMDB rate-limit instructions. After the run, compare reviewed movie/review/chunk counts with the workbench summary and database aggregates.

- [ ] **Step 9: Run a real review-driven task without formal Vecteezy download**

Select one imported review, create a task, and verify the derived theme, same-movie subtitle anchor or recorded global fallback, 5-10 timed scenes, review provenance, and Vecteezy candidate metadata. Stop before formal asset download/render if it would consume provider quota; existing fixture/full local coverage remains the render proof.

- [ ] **Step 10: Record final evidence and commit verified documentation changes**

Record test counts, migration IDs, deployed function versions, bounded sync result, review/search counts, advisor outcomes, and any accepted provider limitation in README only when it changes operator behavior. Then run `git status --short`, stage only intentional files, and commit with:

```bash
git commit -m "docs: record movie review deployment"
```

Expected: working tree contains no uncommitted implementation files, the local server remains available, and no credential value appears in `git diff`, artifacts, logs, screenshots, or task manifests.
