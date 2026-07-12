# Subtitle Vector Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a private CLI workflow that imports timestamped English SRT/VTT subtitles into Supabase, generates embeddings with the built-in `gte-small` Edge Runtime model, and retrieves exact dialogue cues by English semantic query.

**Architecture:** A Node.js TypeScript CLI owns subtitle acquisition, parsing, deterministic chunking, and orchestration. Two Supabase Edge Functions authenticate a personal token, use the server-only service role, run `gte-small`, and call a private RLS-protected Postgres schema with `pgvector` retrieval.

**Tech Stack:** Node.js 22, TypeScript 7, Vitest 4, Commander 15, `subtitle` 4.2.2, Supabase CLI 2.109.1, `@supabase/supabase-js` 2.110.2, Supabase Edge Functions, PostgreSQL, pgvector.

## Global Constraints

- English subtitle text and English queries only.
- Embeddings use only `Supabase.ai.Session('gte-small')`, with `mean_pool: true` and `normalize: true`.
- Store embeddings as `extensions.vector(384)` and reject any other vector length.
- Keep every source cue and its exact millisecond timestamps.
- Keep all tables private with forced RLS, no `anon` or `authenticated` policies, and no browser-visible service-role key.
- OpenSubtitles access uses the official REST API, user-supplied credentials, and personal-research provenance metadata.
- Do not commit downloaded subtitle files, `.env`, credentials, tokens, or copyrighted subtitle fixtures.

---

## File Map

- `package.json`: pinned scripts and dependencies.
- `tsconfig.json`: Node/Edge-compatible strict TypeScript settings.
- `.gitignore`, `.env.example`: secret and subtitle-file boundaries.
- `src/domain.ts`: shared CLI data contracts.
- `src/subtitles.ts`: SRT/VTT parsing, cleaning, validation, timestamp formatting.
- `src/chunks.ts`: deterministic overlapping chunk construction.
- `src/opensubtitles.ts`: official OpenSubtitles REST search and download client.
- `src/supabase-api.ts`: typed Edge Function HTTP client.
- `src/cli.ts`: `download`, `import`, and `search` commands.
- `tests/*.test.ts`: Node unit tests with synthetic text only.
- `supabase/config.toml`: local Supabase project configuration.
- `supabase/migrations/*_create_subtitle_search.sql`: schema, RLS, indexes, grants, and retrieval RPC.
- `supabase/tests/database/private_subtitles.sql`: pgTAP schema and privacy checks.
- `supabase/functions/_shared/*.ts`: token authentication, validation, CORS-free JSON responses, and Supabase client creation.
- `supabase/functions/ingest-subtitles/index.ts`: resumable start/batch/finalize ingestion API.
- `supabase/functions/search-subtitles/index.ts`: query embedding, vector RPC, and cue reconstruction.
- `README.md`: setup, deployment, import, search, privacy, and model limitations.

---

### Task 1: Project Foundation, Subtitle Parsing, and Chunking

**Files:**
- Create: `.gitignore`
- Create: `.env.example`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/domain.ts`
- Create: `src/subtitles.ts`
- Create: `src/chunks.ts`
- Create: `tests/subtitles.test.ts`
- Create: `tests/chunks.test.ts`

**Interfaces:**
- Produces: `Cue`, `SubtitleChunk`, `parseSubtitle(content, extension)`, `formatTimestamp(ms)`, and `buildChunks(cues, options)`.
- Consumes: `subtitle.parseSync()` nodes with cue timestamps in milliseconds.

- [ ] **Step 1: Initialize Git and create pinned project metadata**

Run:

```powershell
git init
npm init -y
npm install subtitle@4.2.2 commander@15.0.0 dotenv@17.4.2
npm install --save-dev typescript@7.0.2 tsx@4.23.0 vitest@4.1.10 @types/node@26.1.1 supabase@2.109.1
```

Then set `package.json` to:

```json
{
  "name": "private-subtitle-search",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "subtitle": "tsx src/cli.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "supabase": "supabase"
  },
  "dependencies": {
    "commander": "15.0.0",
    "dotenv": "17.4.2",
    "subtitle": "4.2.2"
  },
  "devDependencies": {
    "@types/node": "26.1.1",
    "supabase": "2.109.1",
    "tsx": "4.23.0",
    "typescript": "7.0.2",
    "vitest": "4.1.10"
  }
}
```

Use strict NodeNext TypeScript in `tsconfig.json`, including `src/**/*.ts` and `tests/**/*.ts`. Ignore `.env`, `downloads/`, `*.srt`, `*.vtt`, Supabase temp state, coverage, build output, and `node_modules`. Document these required environment names without values in `.env.example`:

```dotenv
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
SUBTITLE_PERSONAL_TOKEN=
OPENSUBTITLES_API_KEY=
OPENSUBTITLES_TOKEN=
OPENSUBTITLES_USER_AGENT=private-subtitle-search v1.0
```

- [ ] **Step 2: Write failing parsing tests**

Create synthetic tests that specify the desired API:

```ts
import { describe, expect, it } from 'vitest'
import { formatTimestamp, parseSubtitle } from '../src/subtitles.js'

describe('parseSubtitle', () => {
  it('preserves SRT timestamps and joins multiline dialogue', () => {
    const cues = parseSubtitle(
      '1\n00:00:01,250 --> 00:00:03,500\nHello.\nAre you there?\n',
      '.srt',
    )
    expect(cues).toEqual([{ index: 0, startMs: 1250, endMs: 3500, text: 'Hello. Are you there?' }])
  })

  it('parses WebVTT and removes formatting tags', () => {
    const cues = parseSubtitle(
      'WEBVTT\n\n00:00:02.000 --> 00:00:04.000\n<i>Keep hope alive.</i>\n',
      '.vtt',
    )
    expect(cues[0]).toMatchObject({ startMs: 2000, endMs: 4000, text: 'Keep hope alive.' })
  })

  it('rejects backward timestamps', () => {
    expect(() => parseSubtitle('1\n00:00:03,000 --> 00:00:02,000\nBad\n', '.srt'))
      .toThrow('end time must be greater than start time')
  })
})

it('formats milliseconds for search output', () => {
  expect(formatTimestamp(3723004)).toBe('01:02:03.004')
})
```

- [ ] **Step 3: Run parsing tests and verify the expected failure**

Run: `npm test -- tests/subtitles.test.ts`

Expected: FAIL because `src/subtitles.ts` does not exist.

- [ ] **Step 4: Implement parsing and validation**

Define these contracts in `src/domain.ts`:

```ts
export interface Cue {
  index: number
  startMs: number
  endMs: number
  text: string
}

export interface SubtitleChunk {
  index: number
  startMs: number
  endMs: number
  firstCueIndex: number
  lastCueIndex: number
  text: string
}
```

Implement `parseSubtitle` with `parseSync`, selecting only `type === 'cue'` nodes. Normalize CRLF, strip HTML/WebVTT tags, decode the common entities `&amp;`, `&lt;`, `&gt;`, `&quot;`, and `&#39;`, collapse whitespace, discard empty cue text, renumber accepted cues from zero, and reject unsupported extensions, empty results, negative timestamps, and `end <= start`.

Implement `formatTimestamp` using integer arithmetic and `padStart`, returning `HH:MM:SS.mmm`.

- [ ] **Step 5: Run parsing tests and verify green**

Run: `npm test -- tests/subtitles.test.ts`

Expected: all parsing tests PASS.

- [ ] **Step 6: Write failing chunking tests**

Specify deterministic overlap and timestamp boundaries:

```ts
import { expect, it } from 'vitest'
import { buildChunks } from '../src/chunks.js'

const cues = Array.from({ length: 6 }, (_, index) => ({
  index,
  startMs: index * 1000,
  endMs: index * 1000 + 900,
  text: `line ${index} carries several useful words`,
}))

it('builds deterministic chunks with cue overlap', () => {
  const chunks = buildChunks(cues, { targetTokens: 14, maxTokens: 20, overlapCues: 2 })
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks[1].firstCueIndex).toBe(chunks[0].lastCueIndex - 1)
  expect(chunks[0].startMs).toBe(cues[chunks[0].firstCueIndex].startMs)
  expect(chunks[0].endMs).toBe(cues[chunks[0].lastCueIndex].endMs)
})

it('rejects a single cue above the model-safe maximum', () => {
  const oversized = [{ index: 0, startMs: 0, endMs: 1000, text: 'word '.repeat(500) }]
  expect(() => buildChunks(oversized)).toThrow('cue exceeds the embedding token limit')
})
```

- [ ] **Step 7: Run chunking tests and verify red**

Run: `npm test -- tests/chunks.test.ts`

Expected: FAIL because `buildChunks` does not exist.

- [ ] **Step 8: Implement token estimation and chunking**

Implement `estimateTokens(text)` by counting English word pieces and punctuation matches from `/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?|[^\sA-Za-z0-9]/g`. Implement:

```ts
export function buildChunks(
  cues: Cue[],
  options: { targetTokens?: number; maxTokens?: number; overlapCues?: number } = {},
): SubtitleChunk[]
```

Defaults are `targetTokens: 250`, `maxTokens: 450`, and `overlapCues: 2`. Accumulate whole cues until adding another would exceed the target, never emit above the maximum, restart at the last two emitted cues, and guard against a non-advancing overlap loop. Derive each chunk's time and cue range from its first and last cues.

- [ ] **Step 9: Run unit tests and typecheck**

Run:

```powershell
npm test
npm run typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 10: Commit the foundation**

```powershell
git add .gitignore .env.example package.json package-lock.json tsconfig.json src tests docs
git commit -m "feat: add subtitle parsing and chunking foundation"
```

---

### Task 2: Official OpenSubtitles Client and CLI Contracts

**Files:**
- Create: `src/opensubtitles.ts`
- Create: `src/supabase-api.ts`
- Create: `src/cli.ts`
- Create: `tests/opensubtitles.test.ts`
- Create: `tests/supabase-api.test.ts`

**Interfaces:**
- Produces: `OpenSubtitlesClient.searchEnglishByImdb()`, `downloadFile()`, `SubtitleApi.startImport()`, `sendBatch()`, `finalizeImport()`, and `search()`.
- Consumes: normalized `Cue[]` and `SubtitleChunk[]` from Task 1.

- [ ] **Step 1: Write failing OpenSubtitles client tests**

Use an injected `fetch` function and assert official endpoint shape without network calls:

```ts
it('searches English subtitles by IMDb id with required headers', async () => {
  const fetchFn = vi.fn().mockResolvedValue(Response.json({
    data: [{ id: '42', attributes: { language: 'en', files: [{ file_id: 99, file_name: 'movie.srt' }] } }],
  }))
  const client = new OpenSubtitlesClient({ apiKey: 'key', token: 'token', userAgent: 'research-app', fetchFn })
  const result = await client.searchEnglishByImdb('0111161')
  expect(fetchFn).toHaveBeenCalledWith(
    'https://api.opensubtitles.com/api/v1/subtitles?imdb_id=0111161&languages=en',
    expect.objectContaining({ headers: expect.objectContaining({ 'Api-Key': 'key', 'User-Agent': 'research-app' }) }),
  )
  expect(result[0].fileId).toBe(99)
})
```

Add tests for POST `/api/v1/download`, missing files, 401/403/404/406/429 error mapping, and a bounded retry on 429 honoring `Retry-After` through an injected delay function.

- [ ] **Step 2: Verify the OpenSubtitles tests fail**

Run: `npm test -- tests/opensubtitles.test.ts`

Expected: FAIL because `OpenSubtitlesClient` does not exist.

- [ ] **Step 3: Implement the official REST client**

Implement requests against `https://api.opensubtitles.com/api/v1` with `Api-Key`, `User-Agent`, and `Authorization: Bearer <token>` where required. Normalize search data into:

```ts
export interface SubtitleCandidate {
  subtitleId: string
  fileId: number
  fileName: string
  language: string
}
```

`downloadFile(fileId)` posts `{ file_id: fileId }`, follows the returned one-time `link`, and returns `{ fileName, bytes }`. Retry only HTTP 429 and transient 5xx responses, at most three attempts.

- [ ] **Step 4: Write and run failing Edge API client tests**

Test URL construction, personal-token header, publishable-key header, JSON error decoding, import action bodies, and query parameters. Run `npm test -- tests/supabase-api.test.ts` and expect FAIL because `SubtitleApi` does not exist.

- [ ] **Step 5: Implement the Edge API client and CLI shell**

Create `SubtitleApi` around injected `fetch`, sending:

```ts
headers: {
  apikey: config.publishableKey,
  'x-subtitle-token': config.personalToken,
  'content-type': 'application/json',
}
```

Implement Commander commands:

```text
subtitle download --imdb 0111161 --output downloads/shawshank.srt
subtitle import downloads/shawshank.srt --title "The Shawshank Redemption" --year 1994 --imdb tt0111161 --source opensubtitles
subtitle search "hope during hard times" --limit 10
```

The import command computes SHA-256, calls `startImport`, sends batches of at most 100 cues and 8 chunks, calls `finalizeImport`, and prints counts without printing full subtitle text. The download command requires explicit output and refuses to overwrite an existing file.

- [ ] **Step 6: Verify Task 2**

Run:

```powershell
npm test
npm run typecheck
npm run subtitle -- --help
```

Expected: all tests PASS, typecheck passes, and help lists `download`, `import`, and `search`.

- [ ] **Step 7: Commit the clients**

```powershell
git add src tests package.json package-lock.json
git commit -m "feat: add subtitle source and API clients"
```

---

### Task 3: Private Supabase Vector Schema

**Files:**
- Create: `supabase/config.toml`
- Create: `supabase/tests/database/private_subtitles.sql`
- Create via CLI: `supabase/migrations/<generated>_create_subtitle_search.sql`

**Interfaces:**
- Produces: `movies`, `subtitle_tracks`, `subtitle_cues`, `subtitle_chunks`, and `match_subtitle_chunks(vector(384), integer, bigint)`.
- Consumes: 384-dimensional normalized vectors from Edge Functions.

- [ ] **Step 1: Initialize Supabase with the installed CLI and discover commands**

Run:

```powershell
npx supabase --help
npx supabase init
npx supabase migration new create_subtitle_search
```

Expected: CLI help succeeds, `supabase/config.toml` exists, and the CLI creates the migration filename.

- [ ] **Step 2: Write the failing pgTAP privacy and schema test**

Create a transaction-scoped pgTAP test that asserts the four tables exist, `subtitle_chunks.embedding` has type `extensions.vector(384)`, foreign keys exist, RLS is enabled and forced, and `anon` cannot select from `movies`. Include a direct insert of synthetic movie/track/cue/chunk rows under the test owner and assert retrying the same cue/chunk upsert leaves one row.

Run:

```powershell
npx supabase start
npx supabase test db
```

Expected: FAIL because the schema migration is empty.

- [ ] **Step 3: Implement the migration**

The migration must:

```sql
create extension if not exists vector with schema extensions;

create table public.movies (
  id bigint generated always as identity primary key,
  title text not null check (btrim(title) <> ''),
  release_year integer check (release_year between 1888 and 2200),
  imdb_id text unique,
  created_at timestamptz not null default now()
);
```

Create the other tables exactly as specified in the approved design, using identity primary keys, indexed foreign keys, named check constraints, and unique import keys. Use `embedding extensions.vector(384) not null`.

Add:

```sql
create index subtitle_chunks_embedding_hnsw_idx
  on public.subtitle_chunks
  using hnsw (embedding extensions.vector_cosine_ops);
```

Create `public.match_subtitle_chunks` as `language sql stable security invoker set search_path = ''`. Filter to `subtitle_tracks.status = 'ready'`, apply an optional movie ID, order by cosine distance, return `1 - distance` as similarity, and cap `match_count` with `least(greatest(match_count, 1), 50)`.

For every table:

```sql
alter table public.<table> enable row level security;
alter table public.<table> force row level security;
revoke all on table public.<table> from anon, authenticated;
grant select, insert, update, delete on table public.<table> to service_role;
```

Revoke function execution from `public`, `anon`, and `authenticated`; grant it only to `service_role`. Grant sequence usage only to `service_role`.

- [ ] **Step 4: Verify schema, RLS, and indexes**

Run:

```powershell
npx supabase db reset
npx supabase test db
npx supabase db lint --level warning
```

Expected: pgTAP PASS and no schema warnings requiring correction.

- [ ] **Step 5: Commit the database layer**

```powershell
git add supabase
git commit -m "feat: add private subtitle vector schema"
```

---

### Task 4: Authenticated Resumable Ingestion Edge Function

**Files:**
- Create: `supabase/functions/_shared/auth.ts`
- Create: `supabase/functions/_shared/http.ts`
- Create: `supabase/functions/_shared/contracts.ts`
- Create: `supabase/functions/ingest-subtitles/index.ts`
- Create: `tests/edge-validation.test.ts`

**Interfaces:**
- Produces: POST actions `start`, `batch`, and `finalize` at `/functions/v1/ingest-subtitles`.
- Consumes: normalized cues/chunks from `SubtitleApi` and writes 384-dimensional embeddings.

- [ ] **Step 1: Write failing shared validation and authentication tests**

Test that missing/wrong `x-subtitle-token` returns 401, valid equal-length tokens pass, timestamps and cue ranges are validated, batch size is capped at 100 cues and 8 chunks, and no model callback occurs before authentication succeeds. Inject environment and model callbacks into pure functions so Vitest can test behavior without Edge Runtime.

Run: `npm test -- tests/edge-validation.test.ts`

Expected: FAIL because the shared modules do not exist.

- [ ] **Step 2: Implement constant-time token authentication and contracts**

Hash both UTF-8 token values with `crypto.subtle.digest('SHA-256', ...)`, compare all 32 bytes without early return, and reject missing `SUBTITLE_PERSONAL_TOKEN`. Define discriminated request unions:

```ts
type IngestRequest =
  | { action: 'start'; movie: MovieInput; track: TrackInput }
  | { action: 'batch'; trackId: number; cues: Cue[]; chunks: SubtitleChunk[] }
  | { action: 'finalize'; trackId: number }
```

Return errors as `{ error: { code: string; message: string } }` and never include submitted subtitle text in logs.

- [ ] **Step 3: Verify shared tests pass**

Run: `npm test -- tests/edge-validation.test.ts`

Expected: PASS.

- [ ] **Step 4: Implement ingestion actions**

Use pinned Edge imports:

```ts
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.110.2'

const embeddingSession = new Supabase.ai.Session('gte-small')
```

Create the service client only after authentication with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

- `start`: upsert movie by `imdb_id`, then find-or-create track by `(movie_id, language_code, source_sha256)` and return IDs plus existing progress.
- `batch`: upsert cues first; embed only chunk indexes absent for the track; run each chunk with `{ mean_pool: true, normalize: true }`; assert the result is an array of exactly 384 finite numbers; upsert chunks.
- `finalize`: verify at least one cue and chunk exist, then set status to `ready`.

On a database/model error, return a stable 5xx code while preserving already committed idempotent batches.

- [ ] **Step 5: Run the local Edge Function smoke test**

Run in one terminal:

```powershell
$env:SUBTITLE_PERSONAL_TOKEN='local-test-token'
npx supabase functions serve ingest-subtitles --no-verify-jwt
```

Call without the custom token from another terminal and verify HTTP 401. Call with `{ "action": "invalid" }` and the correct token and verify HTTP 400 without model inference.

- [ ] **Step 6: Run all checks and commit ingestion**

```powershell
npm test
npm run typecheck
git add supabase/functions tests
git commit -m "feat: add resumable subtitle ingestion function"
```

Expected: PASS.

---

### Task 5: Semantic Search Function, End-to-End Verification, and Documentation

**Files:**
- Create: `supabase/functions/search-subtitles/index.ts`
- Create: `tests/search-contract.test.ts`
- Create: `supabase/seed.sql`
- Create: `README.md`
- Modify: `src/cli.ts`
- Modify: `src/supabase-api.ts`

**Interfaces:**
- Produces: POST `/functions/v1/search-subtitles` with `{ query, limit, movieId? }` and timestamped ranked results.
- Consumes: `match_subtitle_chunks` RPC and exact cue rows.

- [ ] **Step 1: Write failing search contract tests**

Specify that blank queries are rejected, limits default to 10 and clamp to 50, vectors must have 384 finite values, database rows are grouped into exact cues, and output has this shape:

```ts
interface SearchResult {
  similarity: number
  movie: { id: number; title: string; releaseYear: number | null }
  trackId: number
  chunkIndex: number
  startMs: number
  endMs: number
  timestamp: string
  text: string
  cues: Cue[]
}
```

Run: `npm test -- tests/search-contract.test.ts`

Expected: FAIL because the search validation/result mapper does not exist.

- [ ] **Step 2: Implement the search Edge Function**

Authenticate before inference, run the normalized query through the module-level `gte-small` session, validate 384 dimensions, invoke `match_subtitle_chunks`, and fetch cues using `track_id` plus `cue_index >= first_cue_index` and `<= last_cue_index`. Preserve rank order from the RPC and return no full-track payload.

- [ ] **Step 3: Complete CLI search output**

Print each result in this compact format:

```text
0.842  00:42:13.120 --> 00:42:18.900
The matching dialogue text...
```

Exit non-zero for authentication, network, validation, and empty-ready-track errors. An ordinary no-match response remains a successful command with `No matching dialogue found.`

- [ ] **Step 4: Add synthetic local seed and run database retrieval test**

Seed one synthetic movie, ready track, three cues, and two explicit 384-value normalized test vectors. Query `match_subtitle_chunks` with the first vector and assert the first chunk ranks first and includes the correct cue range. Do not use text from any copyrighted film.

Run:

```powershell
npx supabase db reset
npx supabase test db
npm test
npm run typecheck
```

Expected: all checks PASS.

- [ ] **Step 5: Document setup and deployment with exact commands**

Document:

```powershell
npm install
npx supabase start
npx supabase db reset
npx supabase secrets set SUBTITLE_PERSONAL_TOKEN=<random-secret>
npx supabase functions deploy ingest-subtitles --no-verify-jwt
npx supabase functions deploy search-subtitles --no-verify-jwt
npm run subtitle -- import <authorized-file.srt> --title "The Shawshank Redemption" --year 1994 --imdb tt0111161 --source manual
npm run subtitle -- search "hope during hard times"
```

Include environment setup, OpenSubtitles token requirements, English-only behavior, personal-research rights warning, private RLS model, backup/deletion SQL, and troubleshooting for Docker, function secrets, 401, 429, and model dimension errors.

- [ ] **Step 6: Perform final verification**

Run:

```powershell
npm test
npm run typecheck
npx supabase db reset
npx supabase test db
npx supabase functions serve --no-verify-jwt
```

Then invoke both functions with invalid tokens and verify 401. If a linked hosted Supabase project is available, deploy, import a user-authorized English subtitle, search an English concept, and verify timestamped results. If credentials are unavailable, record the hosted test as unrun while preserving all local evidence.

- [ ] **Step 7: Commit the completed workflow**

```powershell
git add README.md src tests supabase package.json package-lock.json
git commit -m "feat: complete private subtitle semantic search"
```

---

## Plan Self-Review

- Every approved design requirement maps to a task: source acquisition, local parsing, exact cue storage, overlapping chunks, built-in embeddings, private RLS, resumable import, semantic search, and timestamp reconstruction.
- All model references use `gte-small` and all vector contracts use 384 dimensions.
- No task requires copyrighted subtitle text in source control.
- Hosted deployment and real-film acceptance are explicitly conditional on user-owned Supabase/OpenSubtitles credentials; local tests remain deterministic and complete without them.
- The plan contains no unresolved implementation placeholders.
