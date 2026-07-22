# Task 5 Subtitle Library Interface Report

## Delivered

- Added accessible `Video production` / `Subtitle library` tabs below the existing status bar. The production tab preserves the existing task rail, creation controls, review, recovery, progress, and final-output workflow.
- Hoisted aspect ratio and scene count into `App` so the library command creates an exact task with the current controls and a `sourceAnchor` derived from the selected result's minimum and maximum cue indexes.
- Added a compact subtitle-library toolbar with a bounded search field, result-count selector, search command, library counts, and sync command.
- Added aligned desktop result rows for title, year, timestamp, dialogue, and overall, semantic, and full-text rank labels. At widths below 700px the metadata stacks and the creation command occupies its own row.
- Added controlled search loading, empty, error, Chinese-normalization degradation, and library-summary degradation states. Failed summary reads no longer report fabricated zero counts.
- Added an accessible synchronization dialog with automatic confirmation, manual title/year/IMDb validation, running-job conflict display, persisted snapshot loading, event-driven progress updates, status/terminal labels, and cooperative Stop command.
- Added the requested Lucide icons: `Clapperboard`, `Search`, `RefreshCw`, `Square`, and `Film`.

## Test-Driven Development

1. Initial RED: the new library and sync component suites failed because both components did not exist, and the app test failed because the view tabs did not exist.
2. GREEN: implemented the components and integration; the focused suite passed.
3. Browser-driven RED: the locally degraded summary endpoint returned HTTP 500, which exposed that the UI rendered unknown counts as zero. Added a regression test that failed against that behavior.
4. GREEN: separated summary state from summary values; unavailable counts now produce a controlled operational status.

## Automated Verification

- `npx vitest run workbench/src/App.test.tsx workbench/src/components/SubtitleLibrary.test.tsx workbench/src/components/SubtitleSyncPanel.test.tsx workbench/src/components/SceneReview.test.tsx`
  - Passed: 4 files, 25 tests.
- `npm run typecheck`
  - Passed: `tsc --noEmit`.
- `npm run workbench:build`
  - Passed: Vite production build.

## Browser Verification

- Started the workbench at `http://127.0.0.1:4174`.
- Desktop check confirmed both tabs, the subtitle search box, and the sync command rendered with no Vite error overlay.
- Mobile check at 390px confirmed the library and synchronization dialog fit within `scrollWidth === innerWidth === 390`.
- A local dependency-degraded environment returned HTTP 500 from `/api/subtitles/summary` and `/api/subtitles/sync`. The UI has no framework overlay, preserves the functional sync dialog, and now reports library counts as unavailable instead of displaying zero.

## React Review

Applied the requested `vercel:react-best-practices` review after implementation. Components use named exports and colocated prop interfaces; effects clean up subscriptions; result keys are stable; controls use native semantics; dialogs and tabs are keyboard operable; no new shared-state or prop-drilling layer was introduced.

## Remaining Concern

The two HTTP 500 responses observed during real-browser verification originate from the currently degraded local service configuration rather than this React task. Fixture-based component behavior, typechecking, and the production bundle are all verified. A configured local subtitle service is needed to perform live search and synchronization successfully.

## Review Hardening

- The synchronization dialog now moves focus inside on open, traps forward and reverse Tab navigation, handles Escape from normal trigger-driven use, and restores focus to the trigger on close.
- Initial synchronization GET responses are discarded after any newer SSE or start/stop command update, preventing stale idle state from hiding a running job.
- Shared workbench operations now report whether they actually ran. Exact-result creation stays in the subtitle library when another command is pending or creation fails, and the result action exposes the busy state.
- Added four regression scenarios covering real-trigger focus restoration, both initial-snapshot races, and pending production work during exact-result creation.

Verification after hardening:

- Focused React suite: 4 files, 29 tests passed.
- `npm run typecheck`: passed.
- `npm run workbench:build`: passed.
