# Task 4 Report: Exact Quote Selection And Four-Scene Storyboard

## Status

Complete.

## Scope

- Created `src/quote-selection.ts`.
- Created `src/storyboard.ts`.
- Created `tests/quote-selection.test.ts`.
- Created `tests/storyboard.test.ts`.
- No remote services, providers, model endpoints, or quota-consuming operations were called.

## Implementation

- `selectExactQuote` scans every cue in ranked search results and performs one preferred pass followed by one relaxed pass.
- Preferred eligibility is 5-18 English words and at most 8 seconds. Relaxed eligibility is 3-24 English words and at most 10 seconds.
- Sound-only bracket cues, label-only cues, blank cues, and duplicate `(trackId, cueIndex)` pairs are excluded.
- Candidates are ranked deterministically by similarity descending, duration ascending, movie ID, track ID, and cue index.
- The returned quote uses the original `cue.text` value byte-for-byte, including leading and trailing spaces. The timestamp is formatted from that exact cue's start/end values.
- `buildStoryboard` returns exactly four indexed scenes, with exactly one quote scene at index 2 and bilingual captions on every scene.
- Only the quote scene carries source/movie provenance. All four English visual descriptions are generic and contain no quote or movie title for the tested inputs.
- Blank or over-300-character Chinese quote translations fail with a controlled validation error.

## TDD Evidence

### Quote RED

Command:

`npm test -- tests/quote-selection.test.ts`

Result before production code:

```text
Test Files  1 failed (1)
Tests       no tests
Error: Cannot find module '../src/quote-selection.js'
```

The suite failed at the missing production module boundary before any quote test ran.

### Storyboard RED

Command:

`npm test -- tests/storyboard.test.ts`

Result before production code:

```text
Test Files  1 failed (1)
Tests       no tests
Error: Cannot find module '../src/storyboard.js'
```

The storyboard suite independently failed at its missing production module boundary before any storyboard test ran.

## Verification

Focused command:

`npm test -- tests/quote-selection.test.ts tests/storyboard.test.ts`

Result:

```text
Test Files  2 passed (2)
Tests       22 passed (22)
```

TypeScript command:

`npm run typecheck`

Result: passed with `tsc --noEmit` and no diagnostics.

Full command:

`npm test`

Result:

```text
Test Files  33 passed (33)
Tests       410 passed (410)
```

Diff command:

`git diff --check`

Result: passed with no output.

## Concerns

None. The implementation is local and deterministic; no provider or inference integration was exercised by this task.

## Commit

`caced70` - `feat: select exact quote and build storyboard`

## Task 4 Review Fix Evidence

- Added adversarial storyboard tests for normalized exact-theme equality, normalized quote substring containment, and movie-title containment in the fixed quote visual theme.
- `buildStoryboard` now checks every returned `visualTheme` after trim/lowercase normalization and fails closed with `StoryboardError.code === 'unsafe_visual_collision'` without rewriting or including protected quote/title text in the error.
- Existing fixed visual themes, exact quote copy, bilingual captions, and blank/length translation validation remain unchanged for safe inputs.
- TDD RED: `npm test -- tests/storyboard.test.ts` failed 3 new tests because the unsafe cases returned a storyboard.
- TDD GREEN: `npm test -- tests/storyboard.test.ts` passed 10 tests; focused Task 4 suite passed 25 tests.
- `npm run typecheck` passed.
- `npm test` passed: 33 test files, 413 tests.
- `git diff --check` passed with no output.
- No remote services, providers, or quota-consuming operations were called.
