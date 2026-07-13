# Subtitle Vector Search Final-Fix Report

## Status

`DONE_WITH_CONCERNS`

Worktree: `D:\Project\subtitle\.worktrees\subtitle-vector-search`  
Branch: `agent/subtitle-vector-search`  
Base HEAD: `d58e218e8f047ef108a086a77ccbac8483c2e17c`
Existing fix-wave commit at start: `c9beb7d71a8b38dde077c5b94a7931e9d99cfcf2`

The worktree was clean when this review resumed: the prior worker's intended fix wave was already committed at `c9beb7d`, despite the handoff saying it was uncommitted. This completion adds the missing final pgTAP behavior and RPC-privilege matrix plus its static plan-count guard. No Docker, Deno, hosted Supabase, deployment, push, or other remote state change was attempted.

## Fix Wave Covered

- Edge start validation accepts only exact `en`.
- `MovieInput.imdbId` is required in the Node, Edge, and CLI contracts.
- Claims support token-scoped release, retry recovery, failure recording, and failed-to-processing reopening.
- Edge failures narrow unknown database errors safely and return structured transient errors after releasing only matching claims.
- Finalization checks complete cue ranges, boundary timestamps, and ordered non-empty cue text using SQLSTATE `P0004` for chunk/cue mismatches.
- Node retries only network errors, HTTP 429, and HTTP 5xx; it accumulates accepted counts and marks exhausted imports failed.
- Hosted setup docs specify login, exact project link, database push, secret setup, deployment, migration list, and linked lint ordering.

## Files Changed

Prior intended fix-wave commit `c9beb7d` changed:

- `README.md`
- `src/cli.ts`
- `src/supabase-api.ts`
- `supabase/functions/_shared/contracts.ts`
- `supabase/functions/_shared/rpc-errors.ts`
- `supabase/functions/ingest-subtitles/index.ts`
- `supabase/migrations/20260713100000_finalize_subtitle_ingestion.sql`
- `supabase/tests/database/private_subtitles.sql`
- `tests/chunk-claim-contract.test.ts`
- `tests/cli.test.ts`
- `tests/deployment-docs.test.ts`
- `tests/edge-entry-static.test.ts`
- `tests/edge-validation.test.ts`
- `tests/ingestion-rpc-contract.test.ts`
- `tests/private-subtitles-contract.test.ts`
- `tests/supabase-api.test.ts`

This completion additionally updates:

- `supabase/tests/database/private_subtitles.sql`
- `tests/private-subtitles-contract.test.ts`
- `.superpowers/sdd/final-fix-report.md`

## pgTAP Static Review

- The declared `select plan(137)` equals the 137 static `select ok(...)`, `select is(...)`, and `select has_table(...)` assertions.
- The new transactional fixture covers active-claim protection, stale takeover, wrong-token completion and release, accepted completion, completed-chunk exclusion and no-overwrite behavior, pending-finalize rejection, timestamp/text mismatch rejection, valid empty-cue finalization, and fail/reopen recovery.
- pgTAP also verifies that reserve, complete, release, fail, reopen, and finalize RPCs are executable by `service_role` and not by `anon` or `authenticated`.
- The SQL is statically reviewed only; PostgreSQL/pgTAP execution remains unrun below.

## Verification

Focused RED before the pgTAP fixture was added:

```powershell
npm test -- tests/private-subtitles-contract.test.ts
```

Observed expected failure: missing behavior-matrix and final RPC privilege assertion text.

Focused GREEN after the fixture and plan update:

```powershell
npm test -- tests/private-subtitles-contract.test.ts
```

Observed: 1 file passed, 7 tests passed.

Final commands run:

```powershell
npm test
# 12 files passed, 94 tests passed

npm run typecheck
# exit 0, no diagnostics

npm.cmd run subtitle -- --help
# exit 0; lists download, import, and search

git diff --check
# exit 0, no whitespace errors
```

## Unrun Checks And Concerns

Docker/Postgres/pgTAP were intentionally not attempted:

```powershell
npx supabase start
npx supabase db reset
npx supabase test db
npx supabase db lint --local --level warning
```

Deno Edge semantic compilation was intentionally not attempted:

```powershell
deno check supabase/functions/ingest-subtitles/index.ts
```

No remote action was attempted. Required hosted follow-up commands, in order, are:

```powershell
npx supabase login
npx supabase link --project-ref kwoppqigrtvgmmbnzbpx
npx supabase db push
npx supabase secrets set OPENAI_API_KEY=...
npx supabase functions deploy ingest-subtitles
npx supabase migration list
npx supabase db lint --linked --level warning
```

The remaining concern is execution-environment coverage only: Node/static contracts pass, but the migration and pgTAP behavior matrix still need an actual local Docker database or linked hosted database run, and the Edge function still needs Deno/deployment compilation.
