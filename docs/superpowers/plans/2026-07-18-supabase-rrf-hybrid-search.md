# Supabase RRF Hybrid Subtitle Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy an isolated all-Supabase hybrid subtitle search that fuses English full-text and `gte-small` cosine-vector rankings with RRF, then compare it with the existing vector endpoint for `love and time`.

**Architecture:** A generated English `tsvector` and GIN index support keyword retrieval on `subtitle_chunks`; a private PostgreSQL RPC performs two bounded candidate searches and weighted RRF; a separate authenticated Edge Function generates the query embedding and hydrates exact cues. The existing `search-subtitles` endpoint and RPC remain unchanged as the A/B baseline.

**Tech Stack:** PostgreSQL 17, Supabase CLI 2.109.1, pgvector, pgTAP, Supabase Edge Runtime/Deno, TypeScript 7, Vitest 4, built-in `gte-small` embeddings.

## Global Constraints

- English-only queries and subtitle tracks.
- Use normalized 384-dimensional `gte-small` embeddings with `mean_pool: true` and `normalize: true`.
- Use the existing cosine HNSW index and `extensions.<=>` operator; do not re-embed stored chunks.
- Keep `search-subtitles` and `match_subtitle_chunks` unchanged.
- Create an isolated `hybrid-subtitle-search` Edge Function and `hybrid_match_subtitle_chunks` RPC.
- Default to `full_text_weight = 1`, `semantic_weight = 2`, and `rrf_k = 50`.
- Retrieve no more than 40 candidates from either retrieval path.
- Preserve forced RLS; grant the new RPC only to `service_role` and `postgres`.
- Reuse `x-subtitle-token` authentication and never expose service keys, embeddings, or raw database errors.
- Preserve the user's unstaged `.env.example` deletion; never stage it.

---

## File Structure

- Create through `npx supabase migration new add_rrf_hybrid_search`: the CLI-generated `supabase/migrations/*_add_rrf_hybrid_search.sql`, containing the generated FTS column, GIN index, RPC, and grants.
- Create: `supabase/tests/database/hybrid_subtitle_search.sql`, containing pgTAP schema, privilege, filtering, ranking, weighting, and bound tests.
- Create: `supabase/functions/_shared/hybrid-search.ts`, containing hybrid RPC/result types and diagnostic response mapping.
- Create: `tests/hybrid-search-contract.test.ts`, containing unit tests for diagnostic validation and cue-preserving mapping.
- Create: `supabase/functions/hybrid-subtitle-search/index.ts`, containing the private HTTP entry point, built-in embedding call, RPC call, and cue hydration.
- Create: `tests/hybrid-search-entry-static.test.ts`, containing static Edge entry/security contract tests.
- Modify: `tests/deployment-docs.test.ts`, adding hybrid deployment and A/B documentation assertions.
- Modify: `README.md`, documenting deployment, invocation, diagnostics, and comparison.

### Task 1: Database RRF retrieval

**Files:**
- Create: `supabase/tests/database/hybrid_subtitle_search.sql`
- Create via Supabase CLI: `supabase/migrations/*_add_rrf_hybrid_search.sql`

**Interfaces:**
- Consumes: `public.subtitle_chunks.embedding extensions.vector(384)`, `public.subtitle_chunks.text`, ready subtitle tracks, movies, and the existing cosine HNSW index.
- Produces: `public.hybrid_match_subtitle_chunks(text, extensions.vector, integer, double precision, double precision, integer, bigint)` with source fields plus `rrf_score`, `semantic_rank`, and `full_text_rank`.

- [ ] **Step 1: Write the failing pgTAP contract**

Create `supabase/tests/database/hybrid_subtitle_search.sql` with a transaction, a declared plan, schema/privilege assertions, and synthetic fixtures. The fixture must create one ready movie/track and one processing movie/track, insert four 384-dimensional chunks, and build a query vector whose semantic ordering differs from keyword ordering.

Use these assertions after inserting the fixtures:

```sql
select has_column('public', 'subtitle_chunks', 'fts', 'subtitle chunks have generated FTS');
select ok(
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'subtitle_chunks'
      and column_name = 'fts'
      and is_generated = 'ALWAYS'
  ),
  'subtitle chunks FTS is a stored generated column'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_indexes
    where schemaname = 'public'
      and tablename = 'subtitle_chunks'
      and indexname = 'subtitle_chunks_fts_gin_idx'
  ),
  'subtitle chunks have a GIN FTS index'
);
select has_function(
  'public',
  'hybrid_match_subtitle_chunks',
  array['text', 'extensions.vector', 'integer', 'double precision', 'double precision', 'integer', 'bigint'],
  'hybrid RPC exists'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.hybrid_match_subtitle_chunks(text,extensions.vector,integer,double precision,double precision,integer,bigint)',
    'execute'
  ),
  'anon cannot execute hybrid RPC'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.hybrid_match_subtitle_chunks(text,extensions.vector,integer,double precision,double precision,integer,bigint)',
    'execute'
  ),
  'authenticated cannot execute hybrid RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.hybrid_match_subtitle_chunks(text,extensions.vector,integer,double precision,double precision,integer,bigint)',
    'execute'
  ),
  'service role can execute hybrid RPC'
);
```

Name the ready chunks so the test intent is explicit:

- `love across time` has the best keyword rank and second-best semantic vector.
- `the years cannot divide us` has the best semantic vector but no exact `love` token.
- `love love love` is keyword-heavy but semantically weaker.
- `processing love and time` belongs to a non-ready track and must never appear.

Assert that the `2:1` defaults promote `love across time`, semantic-only and keyword-only candidates remain eligible, a high keyword weight changes the ordering, the processing track is absent, a movie filter cannot leak another movie, null/extreme controls are clamped, and repeated calls return identical chunk-ID ordering.

- [ ] **Step 2: Run the database test and verify RED**

Run:

```powershell
npx supabase start
npx supabase db reset
npx supabase test db supabase/tests/database/hybrid_subtitle_search.sql
```

Expected: FAIL because `subtitle_chunks.fts` and `hybrid_match_subtitle_chunks` do not exist.

- [ ] **Step 3: Generate the migration with the CLI**

Run:

```powershell
npx supabase migration new add_rrf_hybrid_search
$migrationPath = (Get-ChildItem supabase/migrations/*_add_rrf_hybrid_search.sql | Sort-Object Name | Select-Object -Last 1).FullName
$migrationPath
```

Expected: exactly one newly created migration path ending in `_add_rrf_hybrid_search.sql`. Use that exact CLI-generated path for the rest of this task; do not invent or rename its timestamp.

- [ ] **Step 4: Implement the generated FTS column and index**

Add to the CLI-generated migration:

```sql
alter table public.subtitle_chunks
  add column fts pg_catalog.tsvector
  generated always as (
    pg_catalog.to_tsvector('english'::pg_catalog.regconfig, text)
  ) stored;

create index subtitle_chunks_fts_gin_idx
  on public.subtitle_chunks
  using gin (fts);
```

- [ ] **Step 5: Implement the bounded RRF RPC**

In the same migration, create `public.hybrid_match_subtitle_chunks` with the exact seven parameters in the interface. Use parameter normalization, a single parsed tsquery, two materialized candidate sets limited to 40, rank CTEs, a full outer join, and a final join to source metadata.

The core CTE layout must be:

```sql
with parameters as (
  select
    greatest(1, least(coalesce(match_count, 12), 30)) as result_count,
    greatest(0::double precision, least(coalesce(full_text_weight, 1), 10::double precision)) as text_weight,
    greatest(0::double precision, least(coalesce(semantic_weight, 2), 10::double precision)) as vector_weight,
    greatest(1, least(coalesce(rrf_k, 50), 1000)) as smoothing
), parsed_query as (
  select pg_catalog.websearch_to_tsquery(
    'english'::pg_catalog.regconfig,
    coalesce(query_text, '')
  ) as value
), full_text_candidates as materialized (
  select
    chunk.id,
    pg_catalog.ts_rank_cd(chunk.fts, parsed_query.value) as text_score
  from public.subtitle_chunks as chunk
  join public.subtitle_tracks as track on track.id = chunk.track_id
  join public.movies as movie on movie.id = track.movie_id
  cross join parsed_query
  where track.status = 'ready'
    and (filter_movie_id is null or movie.id = filter_movie_id)
    and chunk.fts @@ parsed_query.value
  order by text_score desc, chunk.id
  limit 40
), full_text as (
  select
    id,
    row_number() over (order by text_score desc, id) as rank_ix
  from full_text_candidates
), semantic_candidates as materialized (
  select
    chunk.id,
    chunk.embedding operator(extensions.<=>) query_embedding as distance
  from public.subtitle_chunks as chunk
  join public.subtitle_tracks as track on track.id = chunk.track_id
  join public.movies as movie on movie.id = track.movie_id
  where track.status = 'ready'
    and (filter_movie_id is null or movie.id = filter_movie_id)
  order by chunk.embedding operator(extensions.<=>) query_embedding, chunk.id
  limit 40
), semantic as (
  select
    id,
    distance,
    row_number() over (order by distance, id) as rank_ix
  from semantic_candidates
), fused as (
  select
    coalesce(full_text.id, semantic.id) as chunk_id,
    full_text.rank_ix as full_text_rank,
    semantic.rank_ix as semantic_rank,
    semantic.distance,
    coalesce(1.0 / (parameters.smoothing + full_text.rank_ix), 0.0) * parameters.text_weight
      + coalesce(1.0 / (parameters.smoothing + semantic.rank_ix), 0.0) * parameters.vector_weight
      as rrf_score
  from full_text
  full outer join semantic on semantic.id = full_text.id
  cross join parameters
)
```

Return movie/track/chunk fields, compute `similarity` as `1 - (chunk.embedding <=> query_embedding)`, and return the three diagnostic fields. Order by `rrf_score desc`, then `coalesce(fused.distance, chunk.embedding <=> query_embedding)`, then movie/track/chunk identifiers. Limit using `parameters.result_count`.

Use this final projection after `fused`:

```sql
select
  movie.id as movie_id,
  movie.title as movie_title,
  movie.release_year as movie_release_year,
  chunk.track_id,
  chunk.chunk_index,
  chunk.start_ms,
  chunk.end_ms,
  chunk.text,
  chunk.first_cue_index,
  chunk.last_cue_index,
  1 - (chunk.embedding operator(extensions.<=>) query_embedding) as similarity,
  fused.rrf_score,
  fused.semantic_rank,
  fused.full_text_rank
from fused
join public.subtitle_chunks as chunk on chunk.id = fused.chunk_id
join public.subtitle_tracks as track on track.id = chunk.track_id
join public.movies as movie on movie.id = track.movie_id
cross join parameters
order by
  fused.rrf_score desc,
  coalesce(
    fused.distance,
    chunk.embedding operator(extensions.<=>) query_embedding
  ),
  movie.id,
  chunk.track_id,
  chunk.chunk_index
limit (select result_count from parameters);
```

Declare the function `language sql stable security invoker set search_path = ''`. Revoke all execution from `PUBLIC`, `anon`, and `authenticated`, then grant execute to `service_role` and `postgres` only.

- [ ] **Step 6: Run the focused database test and verify GREEN**

Run:

```powershell
npx supabase db reset
npx supabase test db supabase/tests/database/hybrid_subtitle_search.sql
```

Expected: all planned pgTAP assertions pass with zero failures.

- [ ] **Step 7: Run all database tests**

Run:

```powershell
npx supabase test db
```

Expected: every database test passes; existing vector and montage contracts remain green.

- [ ] **Step 8: Commit the database deliverable**

Run:

```powershell
git add -- $migrationPath supabase/tests/database/hybrid_subtitle_search.sql
git diff --cached --check
git commit -m "feat: add Supabase RRF retrieval"
```

Expected: the commit contains only the new migration and database test.

### Task 2: Hybrid response contract

**Files:**
- Create: `supabase/functions/_shared/hybrid-search.ts`
- Create: `tests/hybrid-search-contract.test.ts`

**Interfaces:**
- Consumes: `MatchSubtitleChunkRow`, `SubtitleCueRow`, `SearchResult`, and `mapSearchResults` from `_shared/search.ts`.
- Produces: `HybridMatchSubtitleChunkRow`, `HybridSearchResult`, and `mapHybridSearchResults(rows, cueRows)`.

- [ ] **Step 1: Write failing hybrid mapping tests**

Create `tests/hybrid-search-contract.test.ts`. Define one valid RPC row with:

```ts
{
  movie_id: 2,
  movie_title: 'Synthetic Film',
  movie_release_year: 2030,
  track_id: 3,
  chunk_index: 4,
  start_ms: 1_000,
  end_ms: 2_000,
  text: 'Love survives time.',
  first_cue_index: 5,
  last_cue_index: 5,
  similarity: 0.83,
  rrf_score: 0.052,
  semantic_rank: 2,
  full_text_rank: 1,
}
```

Assert that `mapHybridSearchResults` preserves the normal search fields/cues and adds camel-case `rrfScore`, `semanticRank`, and `fullTextRank`. Add cases accepting either rank as `null` and rejecting non-finite RRF scores, zero/negative ranks, fractional ranks, and both ranks being null.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm test -- tests/hybrid-search-contract.test.ts
```

Expected: FAIL because `_shared/hybrid-search.ts` does not exist.

- [ ] **Step 3: Implement the focused mapper**

Create `supabase/functions/_shared/hybrid-search.ts`:

```ts
import {
  mapSearchResults,
  type MatchSubtitleChunkRow,
  type SearchResult,
  type SubtitleCueRow,
} from './search.ts'

export interface HybridMatchSubtitleChunkRow extends MatchSubtitleChunkRow {
  rrf_score: number
  semantic_rank: number | null
  full_text_rank: number | null
}

export interface HybridSearchResult extends SearchResult {
  rrfScore: number
  semanticRank: number | null
  fullTextRank: number | null
}

export function mapHybridSearchResults(
  rows: HybridMatchSubtitleChunkRow[],
  cueRows: SubtitleCueRow[],
): HybridSearchResult[] {
  const base = mapSearchResults(rows, cueRows)
  return base.map((result, index) => {
    const row = rows[index]
    if (!Number.isFinite(row.rrf_score)
      || !rank(row.semantic_rank)
      || !rank(row.full_text_rank)
      || (row.semantic_rank === null && row.full_text_rank === null)) {
      throw new Error('invalid hybrid search result')
    }
    return {
      ...result,
      rrfScore: row.rrf_score,
      semanticRank: row.semantic_rank,
      fullTextRank: row.full_text_rank,
    }
  })
}

function rank(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value > 0)
}
```

- [ ] **Step 4: Run focused and full unit tests**

Run:

```powershell
npm test -- tests/hybrid-search-contract.test.ts
npm test
npm run typecheck
```

Expected: focused test passes; all existing tests and TypeScript checks pass.

- [ ] **Step 5: Commit the response contract**

Run:

```powershell
git add -- supabase/functions/_shared/hybrid-search.ts tests/hybrid-search-contract.test.ts
git diff --cached --check
git commit -m "feat: add hybrid search response contract"
```

### Task 3: Isolated hybrid Edge Function

**Files:**
- Create: `supabase/functions/hybrid-subtitle-search/index.ts`
- Create: `tests/hybrid-search-entry-static.test.ts`

**Interfaces:**
- Consumes: `parseSearchRequest`, `assertQueryEmbedding`, `SubtitleCueRow`, `HybridMatchSubtitleChunkRow`, `mapHybridSearchResults`, existing HTTP authentication helpers, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`.
- Produces: authenticated `POST /functions/v1/hybrid-subtitle-search` returning `{ results: HybridSearchResult[] }`.

- [ ] **Step 1: Write the failing static Edge contract**

Create `tests/hybrid-search-entry-static.test.ts` and assert the entry source contains:

```ts
expect(source).toContain("import 'jsr:@supabase/functions-js/edge-runtime.d.ts'")
expect(source).toContain("from 'npm:@supabase/supabase-js@2.110.2'")
expect(source).toContain("new Supabase.ai.Session('gte-small')")
expect(source).toContain('handleAuthenticatedRequest(request, Deno.env')
expect(source.indexOf('handleAuthenticatedRequest(request, Deno.env')).toBeLessThan(source.indexOf('embeddingSession.run'))
expect(source).toContain("embeddingSession.run(input.query, { mean_pool: true, normalize: true })")
expect(source).toContain("client.rpc('hybrid_match_subtitle_chunks'")
```

Also assert each exact RPC parameter name is present, cue queries are bounded by track and cue indexes, method/input/database errors are controlled, and the source does not contain `SUPABASE_SERVICE_ROLE_KEY` in a response or log statement.

- [ ] **Step 2: Run the static test and verify RED**

Run:

```powershell
npm test -- tests/hybrid-search-entry-static.test.ts
```

Expected: FAIL because the Edge entry does not exist.

- [ ] **Step 3: Implement the isolated Edge entry**

Create `supabase/functions/hybrid-subtitle-search/index.ts` by following the existing `search-subtitles` control flow without modifying it. The RPC call must be:

```ts
const rows = await data<HybridMatchSubtitleChunkRow[]>(client.rpc('hybrid_match_subtitle_chunks', {
  query_text: input.query,
  query_embedding: embedding,
  match_count: input.limit,
  full_text_weight: 1,
  semantic_weight: 2,
  rrf_k: 50,
  filter_movie_id: input.movieId ?? null,
}))
```

Use `parseSearchRequest`, generate the normalized embedding, hydrate exact cues with the same track/cue bounds as the baseline endpoint, and return:

```ts
return { results: mapHybridSearchResults(rows, cueRows) }
```

Preserve the baseline empty-ready-track distinction: zero matches on an existing ready scope returns `{ results: [] }`; no ready track returns HTTP 422 `empty_ready_track`. Use HTTP 400 for request errors, 405 for non-POST, and 500 `hybrid_search_failed` for internal failures.

- [ ] **Step 4: Run focused and full Edge tests**

Run:

```powershell
npm test -- tests/hybrid-search-entry-static.test.ts tests/hybrid-search-contract.test.ts tests/search-contract.test.ts
npm test
npm run typecheck
```

Expected: all tests and type checking pass.

- [ ] **Step 5: Commit the Edge Function**

Run:

```powershell
git add -- supabase/functions/hybrid-subtitle-search/index.ts tests/hybrid-search-entry-static.test.ts
git diff --cached --check
git commit -m "feat: add hybrid subtitle search function"
```

### Task 4: Deployment documentation and complete local verification

**Files:**
- Modify: `tests/deployment-docs.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: the new endpoint and its fixed initial weights.
- Produces: exact operator commands for migration, deployment, authenticated invocation, and baseline/hybrid comparison.

- [ ] **Step 1: Write the failing documentation test**

Add a test that requires README to include:

```ts
expect(readme).toContain('npx supabase functions deploy hybrid-subtitle-search --no-verify-jwt')
expect(readme).toContain('/functions/v1/hybrid-subtitle-search')
expect(readme).toContain('"query":"love and time","limit":12')
expect(readme).toContain('rrfScore')
expect(readme).toContain('semanticRank')
expect(readme).toContain('fullTextRank')
expect(readme).toContain('full_text_weight = 1')
expect(readme).toContain('semantic_weight = 2')
expect(readme).toContain('rrf_k = 50')
```

- [ ] **Step 2: Run the documentation test and verify RED**

Run:

```powershell
npm test -- tests/deployment-docs.test.ts
```

Expected: FAIL because the hybrid deployment and invocation are not documented.

- [ ] **Step 3: Document deployment and A/B invocation**

Add `npx supabase functions deploy hybrid-subtitle-search --no-verify-jwt` after `npx supabase db push`. Add a “Hybrid RRF Experiment” section explaining that it follows the official Supabase RRF pattern, uses the fixed initial weights, and is isolated from `search-subtitles`.

Document two authenticated PowerShell calls using the same body:

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

Explain `rrfScore`, `semanticRank`, and `fullTextRank`, including null ranks.

Document the isolated rollback without instructing routine execution: stop calling or delete the `hybrid-subtitle-search` deployment, then apply a deliberate follow-up migration that drops `public.hybrid_match_subtitle_chunks`, `subtitle_chunks_fts_gin_idx`, and `public.subtitle_chunks.fts`. State that the existing `search-subtitles` endpoint remains available throughout. Do not put ad-hoc destructive SQL into the normal deployment sequence.

- [ ] **Step 4: Run all local verification**

Run:

```powershell
npx supabase db reset
npx supabase test db
npm test
npm run typecheck
git diff --check
```

Expected: every command exits 0 with zero failing database tests, zero failing Vitest tests, and no TypeScript or whitespace errors.

- [ ] **Step 5: Commit documentation**

Run:

```powershell
git add -- README.md tests/deployment-docs.test.ts
git diff --cached --check
git commit -m "docs: add RRF experiment workflow"
```

### Task 5: Hosted deployment, A/B evaluation, and GitHub delivery

**Files:**
- No new production files; hosted state and Git branch are verified from the committed artifacts.

**Interfaces:**
- Consumes: linked project `kwoppqigrtvgmmbnzbpx`, authenticated Supabase CLI, hosted `SUBTITLE_PERSONAL_TOKEN`, and the two Edge endpoints.
- Produces: deployed migration/function, compact baseline-versus-RRF comparison, advisor results, and a pushed GitHub branch.

- [ ] **Step 1: Discover CLI commands and verify target**

Run:

```powershell
npx supabase --version
npx supabase db push --help
npx supabase functions deploy --help
npx supabase projects list
npx supabase migration list
```

Expected: CLI 2.109.1, linked project ref `kwoppqigrtvgmmbnzbpx`, and the new migration listed locally but not remotely.

- [ ] **Step 2: Apply the migration**

Run:

```powershell
npx supabase db push
npx supabase migration list
```

Expected: the RRF migration appears in both local and remote columns. If authentication is missing, stop and request `supabase login` or `SUPABASE_ACCESS_TOKEN`; do not bypass authentication.

- [ ] **Step 3: Run hosted database checks**

Run:

```powershell
npx supabase db lint --linked --level warning
```

Expected: no new security or performance warning caused by the generated column, index, or RPC. Investigate and fix any new warning before deployment.

- [ ] **Step 4: Deploy only the isolated Edge Function**

Run:

```powershell
npx supabase functions deploy hybrid-subtitle-search --no-verify-jwt --project-ref kwoppqigrtvgmmbnzbpx
```

Expected: remote compilation and deployment succeed. Do not redeploy or modify `search-subtitles`.

- [ ] **Step 5: Verify authentication boundaries**

Call the hosted hybrid endpoint once without `x-subtitle-token` and once with a wrong token.

Expected: both requests return HTTP 401 and do not perform query inference.

- [ ] **Step 6: Run the `love and time` A/B query**

Load `SUBTITLE_PERSONAL_TOKEN` from the ignored local `.env` without printing it. Call both endpoints with `{"query":"love and time","limit":12}`. Produce a compact table containing rank, movie, timestamp, similarity, and for hybrid results `rrfScore`, `semanticRank`, and `fullTextRank`.

Expected: both endpoints return 12 candidates; the baseline order remains identical to the earlier pure-vector result; the hybrid response contains valid diagnostics.

- [ ] **Step 7: Evaluate the agreed success criterion**

Compare the first 10 results manually. Report rank movements for the relevant *Casablanca* and *Interstellar* scenes and identify weak literal matches such as `my love`. Do not claim improvement unless the returned content supports it; report neutral or worse results honestly and recommend weight changes only from observed evidence.

- [ ] **Step 8: Run final repository verification**

Run:

```powershell
npx supabase test db
npm test
npm run typecheck
git status --short
git log -6 --oneline
```

Expected: all tests pass. The only unrelated working-tree change remains the user's unstaged `.env.example` deletion.

- [ ] **Step 9: Push the branch and verify the remote commit**

Run:

```powershell
git push origin agent/subtitle-vector-search
git ls-remote --heads origin agent/subtitle-vector-search
git rev-parse HEAD
```

Expected: the remote branch hash exactly matches local `HEAD`.

## Completion Checklist

- [ ] Existing vector endpoint unchanged and still callable.
- [ ] Generated FTS column and GIN index deployed.
- [ ] Private RRF RPC deployed with intended privileges.
- [ ] Hybrid Edge Function deployed with custom-token authentication.
- [ ] Database, Vitest, and type checks pass.
- [ ] Hosted A/B results are captured and assessed without overclaiming.
- [ ] Branch is pushed to GitHub.
- [ ] User-owned `.env.example` deletion is not committed.
