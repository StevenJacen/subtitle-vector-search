# Task 3 TDD and Self-Review Report

## Scope

Implemented the local private edge client in the approved worktree and branch:

- Worktree: `D:\Project\subtitle\.worktrees\subtitle-vector-search`
- Branch: `agent/subtitle-vector-search`
- Base commit: `dddb958`
- Production file: `src/video-production-api.ts`
- Test file: `tests/video-production-api.test.ts`

No edge functions, migrations, deployment configuration, provider integrations, quotas, or dependencies were changed.

## TDD Record

### RED

Added the complete local client test contract before creating the production client. Ran:

```text
npm test -- tests/video-production-api.test.ts
```

Observed the expected failure:

```text
Error: Cannot find module '../src/video-production-api.js'
Tests: no tests
```

This confirmed the new tests failed because the requested client did not yet exist.

### GREEN

Implemented the minimum client and local validators. The first post-implementation run exposed only a test fixture typo (`runId is not defined`), which was corrected in the test fixture. A second test-double issue was corrected to model one-shot response bodies correctly for exhausted retries.

Focused verification then passed:

```text
npm test -- tests/video-production-api.test.ts
1 file passed, 17 tests passed
```

Adjacent API verification passed:

```text
npm test -- tests/video-production-api.test.ts tests/supabase-api.test.ts
2 files passed, 31 tests passed
```

## Implemented Behavior

- Added `VideoProductionApi` with `matchScene`, `selectCandidate`, `start`, `recordDownload`, `beginRender`, `complete`, `fail`, and `retry`.
- Configures exactly the three required endpoint URLs from the Supabase URL.
- Sends `POST`, `apikey`, `x-subtitle-token`, `content-type: application/json`, and serialized JSON bodies.
- Uses injected `fetchFn` and `delayFn`; tests make no remote calls.
- Retries only thrown fetch failures, HTTP 429, and HTTP 5xx responses.
- Performs at most two retries, with the existing 250 ms and 500 ms delay pattern.
- Does not retry other 4xx responses or malformed successful payloads.
- Decodes structured `{ error: { code, message } }` responses into `SubtitleApiError`.
- Converts exhausted fetch failures into the existing generic `SubtitleApiTransportError`.
- Validates scene matching, candidate fields, selection fields, download fields, render status values, and all metadata success payloads at runtime.
- Accepts the approved retained-download retry status `downloading` as well as `planned`.
- Normalizes Task 2 wire responses to the public interfaces: selection returns only `selectionId`, download recording adds the request `renderId`, and status-only actions add their request `renderId`.
- Keeps preview/download/status URLs out of metadata request types and request bodies; only `requiredAttributionUrl` is present in download metadata.
- Does not log or include the configured personal token in error messages.

## Verification

```text
npm run typecheck
PASS

npm test
31 files passed, 380 tests passed

git diff --check
PASS (run before commit)
```

## Self-Review

### Requirements covered

- All eight methods: covered by direct method tests and endpoint/body assertions.
- Exact URLs and headers: covered for matching, selection, and metadata actions.
- Candidate validation: malformed provider resource IDs are rejected.
- Selection validation: malformed selection IDs and mismatched echoed identifiers are rejected.
- Metadata validation: malformed status and download responses are rejected.
- Structured errors: code, message, and HTTP status are preserved without token exposure.
- Retry policy: network, 429, and 5xx cases retry twice; other 4xx cases do not retry; exhausted retries stop at three total attempts.
- Retry clarification: `planned` and `downloading` are accepted for retry responses.
- Dependency and network constraints: no package changes and all tests use injected local fetch functions.

### Security and boundary checks

- The personal token is stored only in the private headers object and is never logged.
- Transport errors expose a stable generic message rather than the underlying fetch message.
- Metadata request types contain no provider URL field other than `requiredAttributionUrl`.
- Candidate preview URLs are validated as response data and are not persisted or forwarded to metadata actions.

### Remaining concerns

- The client intentionally does not refresh or persist provider preview URLs; callers must consume them while the match response is in memory.
- Default retry delays use timers when `delayFn` is not injected, matching the existing `SubtitleApi` behavior.
- Endpoint authentication and provider behavior remain owned by the already-approved edge functions and are not exercised through remote integration tests by design.
