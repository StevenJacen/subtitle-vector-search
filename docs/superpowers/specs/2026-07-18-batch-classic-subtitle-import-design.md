# Batch Classic Subtitle Import Design

## Goal

Add 200 more classic films to the private Supabase subtitle vector-search corpus while preserving the existing privacy and copyright boundaries: subtitle files stay local and ignored, subtitle text is not committed, and imports use the user's configured OpenSubtitles account for personal research.

## Selection

The candidate pool is generated from IMDb public datasets. It excludes the six films already imported, keeps `movie` titles only, excludes adult titles, requires at least 100,000 votes, and ranks by IMDb rating plus a small vote-count weight. The committed `data/classic-movie-candidates.json` contains 230 candidates so the importer can skip unavailable or failing titles and still aim for 200 successes.

## Import Flow

The batch command reads candidates in rank order, skips entries already marked successful in `.batch-state/classic-import-state.json`, downloads English subtitles to ignored `downloads/classics`, then calls the existing single-film import command. It records each success or failure immediately after the attempt, making the run safe to stop and resume.

## Quota Handling

OpenSubtitles may enforce daily download limits. If a command reports HTTP 429, quota, rate-limit, or daily-limit text, the batch command stops immediately and preserves state. The next run continues from the next unprocessed candidate.

## Data Safety

The batch command does not add public table access, does not expose service keys, and does not print subtitle text. The remote database remains private through the existing Edge Function and forced RLS design.

## Verification

Unit tests cover successful batch import, resume behavior, and quota-limit stopping. Full verification uses `npm test`, `npm run typecheck`, a dry-run command, and a Supabase count query after each import session.
