# Movie Quote Montage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a private English-theme endpoint that uses Supabase `gte-small` inference and a diversity-aware pgvector RPC to return a traceable exact-quote montage.

**Architecture:** A service-role-only SQL RPC performs thresholded HNSW candidate retrieval and per-movie ranking. A custom-token-authenticated Edge Function validates input, generates the query embedding with Supabase AI, calls the RPC, and returns deterministic joined copy plus source metadata. Existing search and ingestion interfaces remain unchanged.

**Tech Stack:** PostgreSQL 17, pgvector 0.8.2, pgTAP, Supabase Edge Functions/Deno 2, `@supabase/supabase-js@2.110.2`, TypeScript 7, Vitest 4.1.10.

## Global Constraints

- English ASCII themes only; 1-300 trimmed characters and at least one letter.
- Use built-in normalized `gte-small` embeddings with exactly 384 finite dimensions.
- Do not use an external LLM or generate new prose.
- Preserve private RLS tables and service-role-only RPC execution.
- Authenticate with `SUBTITLE_PERSONAL_TOKEN` / `x-subtitle-token` before inference or database access.
- Deploy `movie-quote-montage` with gateway JWT verification disabled.
- Do not change `match_subtitle_chunks` or the existing Edge Functions.

---

### Task 1: Diversity-aware database RPC

**Files:**
- Modify: `supabase/migrations/20260718023039_movie_quote_montage.sql`
- Create: `supabase/tests/database/movie_quote_montage.sql`

**Interfaces:**
- Consumes: `public.movies`, `public.subtitle_tracks`, `public.subtitle_chunks`, `extensions.vector(384)` and `extensions.<=>`.
- Produces: `public.search_movie_quote_montage(extensions.vector,double precision,integer,integer,bigint[])` returning ranked source rows.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/database/movie_quote_montage.sql` with a transaction, synthetic movies/tracks/chunks, and assertions for function security and behavior. Use orthogonal unit vectors so similarity expectations are deterministic:

```sql
begin;
select plan(10);

select has_function(
  'public',
  'search_movie_quote_montage',
  array['extensions.vector', 'double precision', 'integer', 'integer', 'bigint[]'],
  'montage RPC exists'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.search_movie_quote_montage(extensions.vector,double precision,integer,integer,bigint[])',
    'execute'
  ),
  'anon cannot execute montage RPC'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.search_movie_quote_montage(extensions.vector,double precision,integer,integer,bigint[])',
    'execute'
  ),
  'authenticated cannot execute montage RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.search_movie_quote_montage(extensions.vector,double precision,integer,integer,bigint[])',
    'execute'
  ),
  'service role can execute montage RPC'
);

create temporary table montage_ids(movie_id bigint, track_id bigint, label text);
with first_movie as (
  insert into public.movies(title, release_year, imdb_id)
  values ('Montage Alpha', 2031, 'montage-alpha') returning id
), first_track as (
  insert into public.subtitle_tracks(movie_id, language_code, source, source_sha256, rights_status, status)
  select id, 'en', 'synthetic', 'montage-alpha-sha', 'personal_research', 'ready'
  from first_movie returning id, movie_id
)
insert into montage_ids select movie_id, id, 'alpha' from first_track;

with second_movie as (
  insert into public.movies(title, release_year, imdb_id)
  values ('Montage Beta', 2032, 'montage-beta') returning id
), second_track as (
  insert into public.subtitle_tracks(movie_id, language_code, source, source_sha256, rights_status, status)
  select id, 'en', 'synthetic', 'montage-beta-sha', 'personal_research', 'ready'
  from second_movie returning id, movie_id
)
insert into montage_ids select movie_id, id, 'beta' from second_track;

insert into public.subtitle_chunks(track_id, chunk_index, start_ms, end_ms, text, first_cue_index, last_cue_index, embedding)
select track_id, chunk_index, chunk_index * 1000, chunk_index * 1000 + 900,
       label || ' chunk ' || chunk_index, chunk_index, chunk_index,
       ('[' || pg_catalog.array_to_string(
         pg_catalog.array_cat(
           case when label = 'alpha' and chunk_index = 0 then array[1::real,0::real]
                when label = 'alpha' then array[0.9::real,0.1::real]
                else array[0.8::real,0.2::real] end,
           pg_catalog.array_fill(0::real, array[382])
         ), ','
       ) || ']')::extensions.vector(384)
from montage_ids
cross join pg_catalog.generate_series(0, 1) as generated(chunk_index);

create temporary table montage_query(embedding extensions.vector(384));
insert into montage_query
values (('[' || pg_catalog.array_to_string(
  pg_catalog.array_cat(array[1::real,0::real], pg_catalog.array_fill(0::real, array[382])), ','
) || ']')::extensions.vector(384));

select is(
  (select count(*) from public.search_movie_quote_montage((select embedding from montage_query), 0, 15, 1, null)),
  2::bigint,
  'per-movie cap keeps one result from each movie'
);
select is(
  (select movie_title from public.search_movie_quote_montage((select embedding from montage_query), 0, 3, 1, null) limit 1),
  'Montage Alpha',
  'results are ordered by descending similarity'
);
select ok(
  not exists (
    select 1 from public.search_movie_quote_montage((select embedding from montage_query), 0.95, 15, 3, null)
    where similarity < 0.95
  ),
  'threshold excludes weaker matches'
);
select is(
  (select count(*) from public.search_movie_quote_montage(
    (select embedding from montage_query), 0, 15, 3,
    array[(select movie_id from montage_ids where label = 'beta')]
  )),
  2::bigint,
  'movie filter returns only requested movie rows'
);
select ok(
  not exists (
    select 1 from public.search_movie_quote_montage(
      (select embedding from montage_query), 0, 15, 3,
      array[(select movie_id from montage_ids where label = 'beta')]
    ) where movie_title <> 'Montage Beta'
  ),
  'movie filter never leaks other movies'
);
select is(
  (select count(*) from public.search_movie_quote_montage((select embedding from montage_query), -9, 0, 99, null)),
  3::bigint,
  'numeric inputs are clamped safely'
);

select * from finish();
rollback;
```

- [ ] **Step 2: Run the database test and verify RED**

Run:

```powershell
npx --yes supabase@2.109.1 start
npx --yes supabase@2.109.1 db reset
npx --yes supabase@2.109.1 test db supabase/tests/database/movie_quote_montage.sql
```

Expected: FAIL because `public.search_movie_quote_montage` does not exist.

- [ ] **Step 3: Implement the minimal RPC migration**

Write `supabase/migrations/20260718023039_movie_quote_montage.sql`:

```sql
create or replace function public.search_movie_quote_montage(
  query_embedding extensions.vector(384),
  match_threshold double precision default 0.72,
  match_count integer default 8,
  max_per_movie integer default 1,
  filter_movie_ids bigint[] default null
)
returns table (
  movie_id bigint,
  movie_title text,
  movie_release_year integer,
  track_id bigint,
  chunk_index integer,
  start_ms integer,
  end_ms integer,
  text text,
  first_cue_index integer,
  last_cue_index integer,
  similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  with parameters as (
    select
      pg_catalog.greatest(0::double precision, pg_catalog.least(pg_catalog.coalesce(match_threshold, 0.72), 1::double precision)) as threshold,
      pg_catalog.greatest(3, pg_catalog.least(pg_catalog.coalesce(match_count, 8), 15)) as result_count,
      pg_catalog.greatest(1, pg_catalog.least(pg_catalog.coalesce(max_per_movie, 1), 3)) as movie_limit
  ), candidates as materialized (
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
      chunk.embedding operator(extensions.<=>) query_embedding as distance
    from public.subtitle_chunks as chunk
    join public.subtitle_tracks as track on track.id = chunk.track_id
    join public.movies as movie on movie.id = track.movie_id
    cross join parameters
    where track.status = 'ready'
      and chunk.embedding is not null
      and (filter_movie_ids is null or movie.id = any(filter_movie_ids))
      and chunk.embedding operator(extensions.<=>) query_embedding <= 1 - parameters.threshold
    order by chunk.embedding operator(extensions.<=>) query_embedding
    limit pg_catalog.least(200, (select result_count * 8 from parameters))
  ), diversified as (
    select candidates.*,
      pg_catalog.row_number() over (partition by candidates.movie_id order by candidates.distance, candidates.track_id, candidates.chunk_index) as movie_rank
    from candidates
  )
  select
    diversified.movie_id,
    diversified.movie_title,
    diversified.movie_release_year,
    diversified.track_id,
    diversified.chunk_index,
    diversified.start_ms,
    diversified.end_ms,
    diversified.text,
    diversified.first_cue_index,
    diversified.last_cue_index,
    1 - diversified.distance as similarity
  from diversified
  cross join parameters
  where diversified.movie_rank <= parameters.movie_limit
  order by diversified.distance, diversified.movie_id, diversified.track_id, diversified.chunk_index
  limit (select result_count from parameters);
$$;

revoke all on function public.search_movie_quote_montage(extensions.vector, double precision, integer, integer, bigint[]) from public;
revoke all on function public.search_movie_quote_montage(extensions.vector, double precision, integer, integer, bigint[]) from anon;
revoke all on function public.search_movie_quote_montage(extensions.vector, double precision, integer, integer, bigint[]) from authenticated;
grant execute on function public.search_movie_quote_montage(extensions.vector, double precision, integer, integer, bigint[]) to service_role;
grant execute on function public.search_movie_quote_montage(extensions.vector, double precision, integer, integer, bigint[]) to postgres;
```

- [ ] **Step 4: Reset and verify GREEN**

Run the three database commands from Step 2 again. Expected: all ten assertions PASS.

- [ ] **Step 5: Commit the database unit**

```powershell
git add supabase/migrations/20260718023039_movie_quote_montage.sql supabase/tests/database/movie_quote_montage.sql
git commit -m "feat: add diverse movie quote retrieval"
```

---

### Task 2: Montage request and response contract

**Files:**
- Create: `supabase/functions/_shared/montage.ts`
- Create: `tests/montage-contract.test.ts`

**Interfaces:**
- Consumes: `MatchSubtitleChunkRow` and `assertQueryEmbedding` from `_shared/search.ts`.
- Produces: `parseMontageRequest(value)`, `assertMontageEmbedding(value)`, and `buildMontageResponse(theme, rows)`.

- [ ] **Step 1: Write failing Vitest contract tests**

Create `tests/montage-contract.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  assertMontageEmbedding,
  buildMontageResponse,
  parseMontageRequest,
} from '../supabase/functions/_shared/montage.js'

const row = {
  movie_id: 2,
  movie_title: 'Synthetic Film',
  movie_release_year: 2030,
  track_id: 3,
  chunk_index: 4,
  start_ms: 1_000,
  end_ms: 2_000,
  text: 'We carry the light.',
  first_cue_index: 5,
  last_cue_index: 6,
  similarity: 0.83,
}

describe('montage request', () => {
  it('trims an English theme and supplies defaults', () => {
    expect(parseMontageRequest({ theme: '  hope after despair  ' })).toEqual({
      theme: 'hope after despair',
      quoteCount: 8,
      matchThreshold: 0.72,
      maxPerMovie: 1,
    })
  })

  it('accepts every explicit control', () => {
    expect(parseMontageRequest({
      theme: "Don't give up!",
      quoteCount: 15,
      matchThreshold: 1,
      maxPerMovie: 3,
      movieIds: [2, 5],
    })).toEqual({
      theme: "Don't give up!",
      quoteCount: 15,
      matchThreshold: 1,
      maxPerMovie: 3,
      movieIds: [2, 5],
    })
  })

  it.each([
    {},
    { theme: '' },
    { theme: '2026' },
    { theme: 'hope 希望' },
    { theme: `a${'b'.repeat(300)}` },
    { theme: 'hope', quoteCount: 2 },
    { theme: 'hope', quoteCount: 16 },
    { theme: 'hope', matchThreshold: Number.NaN },
    { theme: 'hope', matchThreshold: -0.1 },
    { theme: 'hope', maxPerMovie: 4 },
    { theme: 'hope', movieIds: [] },
    { theme: 'hope', movieIds: [1, 1] },
    { theme: 'hope', movieIds: [0] },
  ])('rejects invalid input %#', input => {
    expect(() => parseMontageRequest(input)).toThrow()
  })
})

describe('montage embedding and response', () => {
  it('requires a finite 384-dimensional embedding', () => {
    const embedding = Array.from({ length: 384 }, () => 0.25)
    expect(assertMontageEmbedding(embedding)).toEqual(embedding)
    expect(() => assertMontageEmbedding([...embedding.slice(1), Number.NaN])).toThrow('invalid embedding')
  })

  it('maps exact stored text and source fields', () => {
    expect(buildMontageResponse('hope', [row, { ...row, chunk_index: 5, text: 'We begin again.' }])).toEqual({
      theme: 'hope',
      copy: 'We carry the light.\n\nWe begin again.',
      quotes: [
        {
          text: 'We carry the light.', movieId: 2, movieTitle: 'Synthetic Film', releaseYear: 2030,
          trackId: 3, chunkIndex: 4, startMs: 1_000, endMs: 2_000,
          firstCueIndex: 5, lastCueIndex: 6, similarity: 0.83,
        },
        {
          text: 'We begin again.', movieId: 2, movieTitle: 'Synthetic Film', releaseYear: 2030,
          trackId: 3, chunkIndex: 5, startMs: 1_000, endMs: 2_000,
          firstCueIndex: 5, lastCueIndex: 6, similarity: 0.83,
        },
      ],
    })
    expect(buildMontageResponse('hope', [])).toEqual({ theme: 'hope', copy: '', quotes: [] })
  })
})
```

- [ ] **Step 2: Run the contract test and verify RED**

Run `npx --yes vitest@4.1.10 run tests/montage-contract.test.ts`. Expected: FAIL because `_shared/montage.ts` is absent.

- [ ] **Step 3: Implement the contract**

Create `supabase/functions/_shared/montage.ts`:

```ts
import { assertQueryEmbedding, type MatchSubtitleChunkRow } from './search.ts'

export interface MontageRequest {
  theme: string
  quoteCount: number
  matchThreshold: number
  maxPerMovie: number
  movieIds?: number[]
}

export class MontageRequestError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'english_theme_required' = 'invalid_request',
    message = code === 'english_theme_required' ? 'English themes are required' : 'invalid request',
  ) {
    super(message)
    this.name = 'MontageRequestError'
  }
}

export function parseMontageRequest(value: unknown): MontageRequest {
  const input = object(value)
  const theme = englishTheme(input.theme)
  const quoteCount = input.quoteCount === undefined ? 8 : integerInRange(input.quoteCount, 3, 15)
  const matchThreshold = input.matchThreshold === undefined ? 0.72 : numberInRange(input.matchThreshold, 0, 1)
  const maxPerMovie = input.maxPerMovie === undefined ? 1 : integerInRange(input.maxPerMovie, 1, 3)
  const movieIds = input.movieIds === undefined ? undefined : positiveUniqueIntegers(input.movieIds)
  return { theme, quoteCount, matchThreshold, maxPerMovie, ...(movieIds === undefined ? {} : { movieIds }) }
}

export function assertMontageEmbedding(value: unknown): number[] {
  return assertQueryEmbedding(value)
}

export function buildMontageResponse(theme: string, rows: MatchSubtitleChunkRow[]) {
  return {
    theme,
    copy: rows.map(row => row.text).join('\n\n'),
    quotes: rows.map(row => ({
      text: row.text,
      movieId: row.movie_id,
      movieTitle: row.movie_title,
      releaseYear: row.movie_release_year,
      trackId: row.track_id,
      chunkIndex: row.chunk_index,
      startMs: row.start_ms,
      endMs: row.end_ms,
      firstCueIndex: row.first_cue_index,
      lastCueIndex: row.last_cue_index,
      similarity: row.similarity,
    })),
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MontageRequestError()
  return value as Record<string, unknown>
}

function englishTheme(value: unknown): string {
  if (typeof value !== 'string') throw new MontageRequestError()
  const theme = value.trim()
  if (theme === '' || theme.length > 300 || !/^[\x09-\x0D\x20-\x7E]+$/.test(theme) || !/[A-Za-z]/.test(theme)) {
    throw new MontageRequestError('english_theme_required')
  }
  return theme
}

function integerInRange(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new MontageRequestError()
  }
  return value
}

function numberInRange(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new MontageRequestError()
  }
  return value
}

function positiveUniqueIntegers(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0
    || value.some(item => typeof item !== 'number' || !Number.isSafeInteger(item) || item <= 0)
    || new Set(value).size !== value.length) {
    throw new MontageRequestError()
  }
  return value as number[]
}
```

- [ ] **Step 4: Verify GREEN and the full unit suite**

Run:

```powershell
npx --yes vitest@4.1.10 run tests/montage-contract.test.ts
npx --yes vitest@4.1.10 run
npx --yes -p typescript@7.0.2 tsc --noEmit
```

Expected: contract test and full suite PASS; typecheck exits 0.

- [ ] **Step 5: Commit the contract unit**

```powershell
git add supabase/functions/_shared/montage.ts tests/montage-contract.test.ts
git commit -m "feat: define movie montage contract"
```

---

### Task 3: Private Edge Function

**Files:**
- Create: `supabase/functions/movie-quote-montage/index.ts`
- Create: `tests/montage-entry-static.test.ts`

**Interfaces:**
- Consumes: personal-token HTTP helpers, montage contract, built-in `gte-small`, service-role Supabase client, and `search_movie_quote_montage`.
- Produces: private `POST /functions/v1/movie-quote-montage` response contract from the design spec.

- [ ] **Step 1: Write the failing static entry test**

Create `tests/montage-entry-static.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'supabase/functions/movie-quote-montage/index.ts'), 'utf8')

describe('movie quote montage Edge entry', () => {
  it('authenticates before inference and uses the pinned Supabase runtime', () => {
    expect(source).toContain("import 'jsr:@supabase/functions-js/edge-runtime.d.ts'")
    expect(source).toContain("from 'npm:@supabase/supabase-js@2.110.2'")
    expect(source).toContain("new Supabase.ai.Session('gte-small')")
    expect(source.indexOf('handleAuthenticatedRequest(request, Deno.env')).toBeLessThan(source.indexOf('embeddingSession.run'))
    expect(source).toContain('{ mean_pool: true, normalize: true }')
  })

  it('calls the private RPC with every retrieval control', () => {
    expect(source).toContain("client.rpc('search_movie_quote_montage'")
    for (const name of ['query_embedding', 'match_threshold', 'match_count', 'max_per_movie', 'filter_movie_ids']) {
      expect(source).toContain(name)
    }
  })

  it('returns stable errors without raw database details', () => {
    expect(source).toContain("errorResponse(500, 'montage_failed', 'movie quote montage failed')")
    expect(source).not.toContain('result.error.message')
  })
})
```

- [ ] **Step 2: Run the entry test and verify RED**

Run `npx --yes vitest@4.1.10 run tests/montage-entry-static.test.ts`. Expected: FAIL because the Edge entry is absent.

- [ ] **Step 3: Implement the Edge entry**

Create `supabase/functions/movie-quote-montage/index.ts`:

```ts
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.110.2'
import {
  assertMontageEmbedding,
  buildMontageResponse,
  MontageRequestError,
  parseMontageRequest,
} from '../_shared/montage.ts'
import type { MatchSubtitleChunkRow } from '../_shared/search.ts'
import { errorResponse, handleAuthenticatedRequest, jsonResponse } from '../_shared/http.ts'

const embeddingSession = new Supabase.ai.Session('gte-small')

Deno.serve(async request => {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'only POST is supported')
  }

  return await handleAuthenticatedRequest(request, Deno.env, async () => {
    try {
      const input = parseMontageRequest(await request.json())
      const embedding = assertMontageEmbedding(
        await embeddingSession.run(input.theme, { mean_pool: true, normalize: true }),
      )
      const client = createClient(
        requiredEnvironment('SUPABASE_URL'),
        requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      )
      const result = await client.rpc('search_movie_quote_montage', {
        query_embedding: embedding,
        match_threshold: input.matchThreshold,
        match_count: input.quoteCount,
        max_per_movie: input.maxPerMovie,
        filter_movie_ids: input.movieIds ?? null,
      })
      if (result.error !== null) throw new Error('database operation failed')
      return jsonResponse(buildMontageResponse(input.theme, result.data as MatchSubtitleChunkRow[]))
    } catch (error) {
      if (error instanceof MontageRequestError) return errorResponse(400, error.code, error.message)
      if (error instanceof SyntaxError) return errorResponse(400, 'invalid_request', 'invalid request')
      return errorResponse(500, 'montage_failed', 'movie quote montage failed')
    }
  })
})

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)
  if (value === undefined || value.trim() === '') throw new Error('missing configuration')
  return value
}
```

- [ ] **Step 4: Verify GREEN and full static/unit checks**

Run the entry test, full Vitest suite, and `tsc --noEmit`. Expected: all pass with no warnings or unknown TypeScript tokens.

- [ ] **Step 5: Commit the Edge Function unit**

```powershell
git add supabase/functions/movie-quote-montage/index.ts tests/montage-entry-static.test.ts
git commit -m "feat: add private movie quote montage endpoint"
```

---

### Task 4: Documentation, hosted deployment, and verification

**Files:**
- Modify: `README.md`
- Add: `docs/superpowers/specs/2026-07-18-movie-quote-montage-design.md`
- Add: `docs/superpowers/plans/2026-07-18-movie-quote-montage.md`

**Interfaces:**
- Consumes: completed migration and Edge Function.
- Produces: reproducible operator instructions and deployed hosted behavior.

- [ ] **Step 1: Add a failing documentation contract**

Extend `tests/deployment-docs.test.ts` to require the new function name, `--no-verify-jwt`, `x-subtitle-token`, and an example request containing `theme`, `quoteCount`, `matchThreshold`, and `maxPerMovie`.

- [ ] **Step 2: Verify documentation RED**

Run `npx --yes vitest@4.1.10 run tests/deployment-docs.test.ts`. Expected: FAIL because README lacks montage deployment and invocation instructions.

- [ ] **Step 3: Update README and verify GREEN**

Document:

```powershell
npx supabase functions deploy movie-quote-montage --no-verify-jwt
Invoke-RestMethod -Method Post `
  -Uri https://kwoppqigrtvgmmbnzbpx.supabase.co/functions/v1/movie-quote-montage `
  -Headers @{ 'x-subtitle-token' = $env:SUBTITLE_PERSONAL_TOKEN } `
  -ContentType 'application/json' `
  -Body '{"theme":"hope after despair","quoteCount":8,"matchThreshold":0.72,"maxPerMovie":1}'
```

State that `copy` is deterministic retrieved dialogue, not LLM-generated prose.

- [ ] **Step 4: Run pre-deployment verification**

Run database tests, all Vitest tests, and typecheck fresh. Review `git diff --check` and `git status --short`. Do not deploy if any check fails.

- [ ] **Step 5: Apply hosted schema and deploy**

Use the Supabase migration API once with the exact contents of `20260718023039_movie_quote_montage.sql`, named `movie_quote_montage`. Deploy all files needed by `movie-quote-montage` with `verify_jwt: false`, including the entry and imported shared modules.

- [ ] **Step 6: Verify hosted database behavior**

Run read-only SQL using an existing stored embedding to assert result count, descending similarity, threshold, movie diversity, and function privileges. Run both security and performance advisors and record every advisory URL that is relevant to the new objects.

- [ ] **Step 7: Verify hosted HTTP behavior**

Call the deployed URL without a token and with an invalid token; both must return 401. If `SUBTITLE_PERSONAL_TOKEN` is available in the operator environment, call a valid theme and verify the response shape and limits. If the secret value is not available, report valid-call verification as pending rather than claiming it passed. Inspect recent Edge Function logs after the calls.

- [ ] **Step 8: Final regression verification and commit**

Run the complete local verification suite again, inspect the final diff, then commit:

```powershell
git add README.md tests/deployment-docs.test.ts docs/superpowers
git commit -m "docs: document movie quote montage deployment"
```

Do not push or open a PR unless the user separately authorizes publication.
