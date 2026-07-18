# Supabase RRF Hybrid Subtitle Search Design

## Goal

Add an isolated, all-Supabase hybrid-search experiment for English movie subtitles. The experiment combines PostgreSQL full-text search and the existing `gte-small` pgvector search with Reciprocal Rank Fusion (RRF), following the official Supabase hybrid-search pattern.

The existing `search-subtitles` endpoint and `match_subtitle_chunks` RPC remain unchanged so their current behavior can be used as the A/B baseline.

## Success Criterion

Run both endpoints with the English query `love and time`, requesting 12 results from each. Compare the first 10 candidates. The experiment is useful if the hybrid results promote strongly relevant passages, such as the appropriate *Casablanca* and *Interstellar* scenes, without increasing weak literal matches or reducing useful semantic matches.

This is a retrieval-quality experiment, not a claim that RRF is a model-based reranker. The result will be reported with enough diagnostics for manual comparison.

## Selected Approach

Implement RRF inside a PostgreSQL RPC, following the official Supabase design:

1. Generate the query embedding in a Supabase Edge Function with the built-in `gte-small` model.
2. Run indexed English full-text retrieval and indexed cosine-vector retrieval as separate candidate queries.
3. Assign a rank within each result list.
4. Combine the ranks using weighted RRF.
5. Return the highest fused results through an isolated Edge Function.

This is preferred over adding raw text and vector scores because the two score scales are not directly comparable. It is preferred over merging two RPC responses in the Edge Function because a database-side fusion is a single, deterministic operation with less data transfer.

## Database Changes

Add a stored generated column to `public.subtitle_chunks`:

```sql
fts tsvector generated always as (
  pg_catalog.to_tsvector('english', text)
) stored
```

Add a GIN index for the full-text vector. Preserve the existing HNSW cosine index on `embedding`; the hybrid query must continue to use the cosine-distance expression supported by that index.

Create a new RPC named `public.hybrid_match_subtitle_chunks`. It accepts:

- `query_text text`
- `query_embedding extensions.vector(384)`
- `match_count integer default 12`
- `full_text_weight double precision default 1`
- `semantic_weight double precision default 2`
- `rrf_k integer default 50`
- `filter_movie_id bigint default null`

The RPC returns the existing movie, track, chunk, timestamp, text, cue-range, and cosine-similarity fields, plus:

- `rrf_score double precision`
- `semantic_rank bigint`
- `full_text_rank bigint`

Null rank values indicate that a result appeared in only one candidate list.

### Candidate and Ranking Rules

- Search only tracks whose status is `ready`.
- Apply the optional movie filter inside both candidate queries.
- Parse English input with `websearch_to_tsquery('english', query_text)`.
- Rank full-text candidates using `ts_rank_cd`.
- Rank semantic candidates by cosine distance using the existing `<=>` operator and HNSW-compatible ordering.
- Retrieve at most 40 candidates from each list for this experiment.
- Join candidates by subtitle chunk ID using a full outer join.
- Calculate the fused score as:

```text
full_text_weight / (rrf_k + full_text_rank)
+ semantic_weight / (rrf_k + semantic_rank)
```

Missing ranks contribute zero. Order by fused score descending, then semantic distance, then stable chunk identifiers. Clamp result count and numeric controls to safe ranges.

The initial `2:1` semantic-to-keyword weighting is an experiment default, not a permanent tuning decision. It protects thematic matches from being overwhelmed by short literal phrases such as `my love`.

## Edge Function

Create an isolated `hybrid-subtitle-search` Edge Function. It must:

- Accept `POST` only.
- Reuse the existing constant-time `x-subtitle-token` authentication.
- Validate the same English query, result-limit, and optional movie-ID contract as `search-subtitles`.
- Generate a normalized 384-dimensional query embedding using `Supabase.ai.Session('gte-small')` with `mean_pool: true` and `normalize: true`.
- Call `hybrid_match_subtitle_chunks` with the query text and query embedding.
- Fetch only the cue intervals referenced by returned chunks.
- Return the same source and timestamp information as the existing endpoint, augmented with the RRF diagnostic fields.
- Return controlled errors without exposing secrets or raw database failures.

The existing `search-subtitles` Edge Function is not modified or redeployed as part of the experiment.

## Security

- Use `SECURITY INVOKER` and an empty `search_path` on the RPC.
- Fully qualify database objects, text-search functions, and vector operators.
- Revoke RPC execution from `PUBLIC`, `anon`, and `authenticated`.
- Grant RPC execution only to `service_role` and `postgres`.
- Keep forced RLS and existing table grants unchanged.
- Keep the service-role key inside the Edge Function.
- Do not return embeddings, secrets, or unrestricted subtitle-track contents.

## Testing Strategy

Follow test-driven development.

### Database Tests

Create synthetic chunks whose keyword and vector ranks intentionally differ. Verify:

- the generated full-text column and GIN index exist;
- the RPC exists with the intended signature and privileges;
- a result ranked well in both lists is promoted;
- semantic-only and keyword-only candidates remain eligible;
- weights change ordering predictably;
- ready-track and movie filters are enforced;
- result and parameter bounds are clamped;
- ties have deterministic ordering.

### Edge Tests

Verify request validation, authentication-before-inference, normalized `gte-small` inference options, RPC parameters, cue hydration, response diagnostics, and controlled errors.

### Hosted A/B Test

After local tests pass:

1. Apply the migration and deploy only `hybrid-subtitle-search`.
2. Call both `search-subtitles` and `hybrid-subtitle-search` with `love and time` and a limit of 12.
3. Compare the first 10 movie/timestamp candidates and record the rank movement.
4. Check that the hybrid endpoint returns diagnostics and does not change the baseline endpoint.
5. Report whether the experiment improved the manually judged candidate set, including weak matches that remain.

## Rollback

Because the experiment is isolated, rollback consists of undeploying or no longer calling `hybrid-subtitle-search`, dropping `hybrid_match_subtitle_chunks`, dropping the GIN index, and dropping the generated `fts` column. The baseline vector endpoint remains available throughout.

## Non-Goals

- Replacing the existing search endpoint
- Deploying `movie-quote-montage`
- Calling an external embedding or reranking provider
- Re-embedding stored subtitle chunks
- Generating new prose
- Supporting non-English queries
- Permanently selecting RRF weights before evaluating the A/B result
