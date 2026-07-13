# Subtitle Vector Search Final-Fix Report

## Status

`DONE_WITH_CONCERNS`

Worktree: `D:\Project\subtitle\.worktrees\subtitle-vector-search`  
Branch: `agent/subtitle-vector-search`  
Base HEAD: `d58e218e8f047ef108a086a77ccbac8483c2e17c`

The user requested an early stop after the first verification pass. No Docker, Deno, hosted Supabase, deployment, push, or remote state change was attempted.

## Implemented

- Edge start validation now accepts only the exact language code `en`.
- `MovieInput.imdbId` is required in the Node client and remains required by the Edge contract and CLI.
- Added migration `20260713100000_finalize_subtitle_ingestion.sql`:
  - validates and enforces `subtitle_tracks.language_code = 'en'`;
  - adds service-role-only, security-invoker, empty-`search_path` claim release keyed by track and claim token;
  - adds locked fail and failed-to-processing reopen transitions;
  - replaces finalization with complete cue-range, boundary timestamp, and ordered non-empty cue-text checks;
  - uses stable SQLSTATE `P0004` for chunk/cue mismatch.
- Edge batch processing releases only its matching token claims after inference or completion failure and returns a structured 503 transient error.
- Fixed the prior strict-type defect by narrowing an unknown database error before reading `code`; static coverage rejects `result.error?.`.
- `SubtitleApi` retries network errors, HTTP 429, and HTTP 5xx only, for at most three attempts with 250/500 ms exponential delays. Other HTTP 4xx responses are not retried.
- Added authenticated `fail` ingestion action and `SubtitleApi.failImport`.
- CLI accumulates API-returned accepted counts and marks a started track failed when batch retries are exhausted.
- Starting the same failed source reopens it to `processing` through a locked RPC.
- README hosted sequence is now login, link to `kwoppqigrtvgmmbnzbpx`, database push, secret set, then function deployment, followed by migration-list and linked lint verification.
- pgTAP schema/security coverage now includes the claim table shape, FK index, forced RLS, no policies, public-role privilege denial, service-role access, and a matching explicit plan count of 118.

## TDD Evidence

RED command:

```powershell
npm test -- tests/edge-validation.test.ts tests/supabase-api.test.ts tests/cli.test.ts tests/edge-entry-static.test.ts tests/chunk-claim-contract.test.ts tests/ingestion-rpc-contract.test.ts tests/private-subtitles-contract.test.ts tests/deployment-docs.test.ts
```

Observed RED: exit 1; 17 failed and 30 passed tests, plus two suites failed to load because the final migration did not yet exist. Failures reproduced exact-English rejection, fail action, retries, accepted counts, token release, unknown error property access, final consistency contracts, claim pgTAP coverage, and deployment ordering.

Post-implementation full Node command:

```powershell
npm test
```

Observed: exit 1; 90 passed, 1 failed, 1 todo across 12 files. The one failure was a test-only loop using the claim-table list for identity sequences even though `subtitle_chunk_claims` has no identity sequence. The loop was corrected to use the four real identity-sequence tables. Per the user's instruction to run tests once, the corrected test was not rerun.

Typecheck command:

```powershell
npm run typecheck
```

Observed: exit 0 with no TypeScript diagnostics.

CLI help command:

```powershell
npx tsx src/cli.ts --help
```

Observed: exit 0; help listed `download`, `import`, and `search`.

Whitespace verification:

```powershell
git diff --check
```

Observed: exit 0 with no output.

## Files Changed

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

## Self-Review

- Claim release predicates include both `track_id` and `claim_token` and execute after locking the track. Wrong-token claims cannot be deleted by the RPC.
- Completion still uses `ON CONFLICT DO NOTHING`, so retries cannot overwrite an existing embedding.
- Failed/reopen transitions lock the track and never reopen a ready track.
- Final chunk text uses one ASCII space, matching `buildChunks`, and excludes empty/whitespace-only cue text while preserving complete cue-index range checks.
- The Edge batch catch suppresses a secondary release failure so the original transient failure is returned. If the release RPC itself fails, the durable claim remains protected until stale takeover; this needs hosted observability.
- Node `tsconfig.json` excludes Edge entries. The exact known unknown-property defect is statically guarded, but this is not a substitute for Deno semantic compilation.

## Unfinished Findings And Required Remote Checks

1. **Final claim schema pgTAP behavior matrix is incomplete.** Claim-table schema/security assertions were added, but the requested sequential synthetic exercises for completed exclusion, active protection, stale takeover, wrong-token completion/release, no overwrite, pending finalize, fail/reopen, timestamp/text mismatch, and valid empty-cue ranges remain represented by one explicit `it.todo`. This is the primary unfinished finding.
2. **Strong Edge semantic compile validation is incomplete.** Deno is unavailable, no Edge-specific TypeScript harness was added before the stop, and only static source/token checks cover the prior defect. Hosted function deployment compilation is mandatory.
3. **The corrected full Node suite was not rerun.** The only observed post-implementation failure was corrected, but there is no fresh green full-suite evidence.
4. **Database runtime checks were not run.** Docker is unavailable, so `supabase db reset`, `supabase test db`, and database lint were not executed. Migration SQL and the pgTAP plan count require local or hosted execution.
5. **No remote checks were run.** Required follow-up: `npx supabase db push`, deploy both functions, verify deployment compilation, run `npx supabase migration list`, run `npx supabase db lint --linked --level warning`, inspect Supabase advisors, and exercise authenticated fail/reopen plus claim recovery with synthetic data.

## Git

The coherent checkpoint is committed locally. Nothing was pushed.
