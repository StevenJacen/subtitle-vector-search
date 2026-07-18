# Movie Quote Montage Design

## Goal

Build an English-only, all-Supabase workflow that converts a theme into a normalized 384-dimensional `gte-small` embedding, retrieves diverse and sufficiently relevant subtitle chunks, and returns a deterministic montage made only from stored movie dialogue.

No external text-generation model is used. The montage preserves retrieved text and never invents connective prose.

## Existing System

- Hosted project: `kwoppqigrtvgmmbnzbpx`
- PostgreSQL 17 and pgvector `0.8.2`
- 15 ready English subtitle tracks and 1,087 fully embedded chunks
- `gte-small`, 384-dimensional normalized embeddings
- HNSW cosine index `subtitle_chunks_embedding_hnsw_idx`
- Private RLS-protected subtitle tables
- Existing `SUBTITLE_PERSONAL_TOKEN` / `x-subtitle-token` authentication shared by the ingestion and search Edge Functions

## Architecture

1. A caller sends an authenticated `POST` request to `movie-quote-montage`.
2. The Edge Function validates the English theme and retrieval controls.
3. Supabase Edge Runtime generates the theme embedding with built-in `gte-small` inference.
4. The function calls a service-role-only RPC, `search_movie_quote_montage`.
5. The RPC filters by similarity, retrieves a wider HNSW-ranked candidate set, ranks candidates within each movie, enforces a per-movie cap, and returns the best final rows.
6. The Edge Function returns the rows as structured sources and joins their exact stored text with blank lines to create `copy`.

## Database Contract

Create:

```sql
public.search_movie_quote_montage(
  query_embedding extensions.vector(384),
  match_threshold double precision default 0.72,
  match_count integer default 8,
  max_per_movie integer default 1,
  filter_movie_ids bigint[] default null
)
```

Return `movie_id`, `movie_title`, `movie_release_year`, `track_id`, `chunk_index`, `start_ms`, `end_ms`, `text`, `first_cue_index`, `last_cue_index`, and `similarity`.

Database rules:

- Clamp threshold to `0..1`, result count to `3..15`, and per-movie count to `1..3`.
- Search only ready tracks and non-null embeddings.
- Apply an optional movie ID array filter inside the candidate query.
- Retrieve no more than 200 candidates and keep the HNSW-compatible distance expression in `ORDER BY`.
- Keep at most `max_per_movie` rows per movie and return final rows by descending similarity.
- Use `SECURITY INVOKER`, an empty `search_path`, and qualified database objects and vector operators.
- Revoke execution from `PUBLIC`, `anon`, and `authenticated`; grant it only to `service_role` and `postgres`.
- Preserve `match_subtitle_chunks` unchanged.

## Edge Function Contract

Deploy `movie-quote-montage` with gateway JWT verification disabled, matching the repository's existing private-token model. The function must call `handleAuthenticatedRequest` before inference or database access.

Request:

```json
{
  "theme": "hope after despair",
  "quoteCount": 8,
  "matchThreshold": 0.72,
  "maxPerMovie": 1,
  "movieIds": [2, 5, 8]
}
```

Only `theme` is required. Validation rules:

- Accept `POST` only.
- Require `theme` to be trimmed ASCII English text containing at least one letter and no more than 300 characters.
- Default `quoteCount` to 8 and require an integer from 3 through 15.
- Default `matchThreshold` to 0.72 and require a finite number from 0 through 1.
- Default `maxPerMovie` to 1 and require an integer from 1 through 3.
- When present, require `movieIds` to be a non-empty array of unique positive safe integers.
- Return 400 for invalid JSON or input, 401 for invalid personal tokens, 405 for unsupported methods, and 500 for inference, configuration, or database failures.

The function uses `Supabase.ai.Session('gte-small')`, normalized mean pooling, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`.

Successful response:

```json
{
  "theme": "hope after despair",
  "copy": "First exact subtitle chunk.\n\nSecond exact subtitle chunk.",
  "quotes": [
    {
      "text": "First exact subtitle chunk.",
      "movieId": 2,
      "movieTitle": "The Shawshank Redemption",
      "releaseYear": 1994,
      "trackId": 2,
      "chunkIndex": 10,
      "startMs": 120000,
      "endMs": 125000,
      "firstCueIndex": 31,
      "lastCueIndex": 33,
      "similarity": 0.83
    }
  ]
}
```

No match is a successful 200 response with empty `copy` and `quotes`.

## Security

- Reuse constant-time personal-token authentication.
- Keep the service-role key inside the function.
- Do not add public RLS policies or direct browser table access.
- Do not grant the montage RPC to browser roles.
- Do not return embeddings, secrets, or raw database errors.

## Testing

Use test-first implementation.

Database tests cover function existence and security, similarity ordering and thresholding, count clamping, per-movie diversity, ready-track exclusion, and movie filters. Edge unit tests cover request validation, response mapping, embedding validation, and authentication-before-inference. Static entry tests cover pinned imports, built-in inference options, the expected RPC name, and absence of secret leakage. Hosted verification exercises invalid authentication, invalid input, a valid English theme, diversity limits, thresholds, advisors, and recent function logs.

## Non-Goals

- Generating new prose
- Chinese input or translation
- Re-embedding existing subtitle chunks
- Changing the existing search endpoint or RPC
- Opening private subtitle tables to public roles
