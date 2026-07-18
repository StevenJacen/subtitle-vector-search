# Subtitle-to-Vecteezy Candidate Matching Design

## Goal

Build a private first-stage workflow that accepts a stored subtitle chunk, a raw
line of text, or a theme and returns 5-10 strongly related Vecteezy video
candidates for manual selection.

The workflow will:

1. Convert the input into a concrete visual intent with the self-hosted
   `gemma4:12b` model.
2. Produce exactly three English Vecteezy searches: literal scene, human action,
   and visual metaphor.
3. Search Vecteezy without downloading any asset.
4. Fuse and de-duplicate the three rankings.
5. Persist stable candidate metadata and the eventual manual selection in
   Supabase.

This phase stops before asset download, Supabase Storage, FFmpeg rendering, or
automatic candidate selection.

## Decision

Three approaches were considered:

- A fixed visual-concept library is predictable and fully hosted in Supabase,
  but it cannot express the long tail of movie dialogue well.
- Gemma-only planning is more flexible, but a model timeout or malformed output
  would make the whole workflow unavailable.
- A hybrid planner uses Gemma as the primary path and a small `gte-small`
  concept library as an English-input fallback.

The hybrid approach is selected. It gives the best semantic coverage while
keeping a deterministic degraded path inside Supabase.

## Verified Service Behavior

The design is based on live, read-only probes made before implementation:

- The existing Supabase project stores private subtitle chunks with normalized
  384-dimensional `gte-small` embeddings and protects its Edge Functions with
  `SUBTITLE_PERSONAL_TOKEN` in the `x-subtitle-token` header.
- The current Ollama service reports version `0.32.1` and exposes
  `gemma4:12b`, an approximately 11.9B-parameter Q4 model with text, vision,
  audio, tool, and thinking capabilities.
- A structured-output chat probe completed in about 5.7 seconds. Its visual
  descriptions were useful, but it emitted two metaphor queries and omitted the
  required literal query. Strict output validation and one repair attempt are
  therefore required.
- Vecteezy video search returns stable resource IDs, titles, content type,
  license type, AI-generated flags, tags, orientation, available file types,
  available download sizes, and temporary preview/thumbnail URLs.
- The tested account did not consistently receive duration or source dimensions.
  Those fields must remain optional and must not drive ranking in this phase.
- The account currently has a 500-download monthly allowance. Search is
  read-only; this phase must never call a Vecteezy download endpoint.

Vecteezy search results and metadata will not be sent to Gemma, used as model
training data, or embedded in the local concept library. Vecteezy's own search
API performs provider-side retrieval; local AI only creates search terms from
the user's input.

## Existing System Boundaries

The new workflow extends, rather than replaces, the current system:

- Reuse the shared constant-time personal-token authentication.
- Reuse `SUPABASE_URL` and the server-only service-role client.
- Read only subtitle chunks whose parent track has status `ready`.
- Keep `search-subtitles`, `hybrid-subtitle-search`,
  `movie-quote-montage`, and their RPCs unchanged.
- Keep all new database objects private with forced row-level security and no
  `anon` or `authenticated` policies.

## Architecture

### 1. `match-video-assets` Edge Function

Expose a private `POST /functions/v1/match-video-assets` endpoint. The function
authenticates before parsing source text, running inference, querying the
database, or calling Vecteezy.

The request may contain:

```json
{
  "subtitleChunkId": 123,
  "text": null,
  "theme": "hope after a long period of isolation",
  "candidateCount": 8
}
```

Rules:

- At least one of `subtitleChunkId`, `text`, or `theme` is required.
- `subtitleChunkId` and `text` are mutually exclusive; `theme` may refine either.
- `text` is limited to 1,000 Unicode characters and is never persisted.
- `theme` is limited to 300 Unicode characters.
- `candidateCount` defaults to 8 and, when supplied, must be an integer in the
  inclusive range 5-10.
- A supplied chunk must exist and belong to a ready subtitle track.
- UTF-8 input is accepted. Gemma must emit English Vecteezy search terms.

When a chunk is supplied, the function uses its text plus at most one adjacent
cue on each side as planning context. Adjacent context is transient and is not
copied into any new table.

### 2. Visual planner

Define a small planner adapter so model transport is isolated from prompt,
validation, and ranking logic.

The preferred adapter uses `Supabase.ai.Session('gemma4:12b')` with the Ollama
host supplied through `AI_INFERENCE_API_HOST`. Implementation starts with a
compatibility spike that must prove the hosted Edge Runtime can:

- reach the configured Ollama host;
- select `gemma4:12b`;
- request bounded structured JSON; and
- enforce the required upstream authentication.

If `Supabase.ai.Session` cannot satisfy all four requirements, use a direct
Ollama `/api/chat` adapter from the Edge Function. That fallback is allowed only
through an authenticated proxy and must read its authorization value from an
Edge Function secret. The request and response contracts remain identical, so
the transport choice does not leak into application logic.

The planner returns:

```json
{
  "visualIntent": {
    "subject": "a solitary adult",
    "action": "opening curtains and stepping into morning light",
    "setting": "a quiet room at dawn",
    "mood": "renewed hope",
    "lighting": "soft natural sunrise",
    "shot": "medium cinematic shot"
  },
  "queries": [
    { "kind": "literal", "term": "solitary person opening curtains sunrise quiet room cinematic video" },
    { "kind": "action", "term": "person stepping into morning light hopeful fresh start video" },
    { "kind": "metaphor", "term": "green sprout emerging after rain sunrise renewal macro video" }
  ]
}
```

Planner constraints:

- Return exactly one query for each kind: `literal`, `action`, and `metaphor`.
- Use concrete, searchable English visual language, not dialogue paraphrases.
- Limit each query to 180 characters.
- Do not include movie titles, character names, brands, quoted dialogue, or
  references to recreating a copyrighted scene.
- Do not invent age, gender, ethnicity, disability, or other personal traits
  unless the input explicitly requires them.
- Prefer filmable subjects, actions, settings, lighting, and camera language.
- Keep the metaphor visually legible rather than abstract or literary.

Validate the output against a strict schema. On failure, make one repair request
that includes only the validation errors and the malformed structured object.
Never repeat inference more than once.

### 3. Supabase fallback concept library

If planning times out, is unreachable, or still fails validation after repair,
use a private `visual_concepts` table seeded with approximately 24 common visual
archetypes such as isolation, reunion, escape, loss, hope, conflict, discovery,
time, memory, and transformation.

Each concept contains a short English description, three curated Vecteezy query
terms, and a normalized 384-dimensional `gte-small` embedding. The Edge Function
embeds the English source input with the existing built-in model and chooses the
nearest enabled concept.

This fallback is guaranteed only for English input because `gte-small` is the
project's English embedding model. Non-English input requires a successful Gemma
plan; if Gemma is unavailable, the function returns a controlled upstream error
instead of pretending the fallback is reliable.

### 4. Three Vecteezy searches

Run the three searches concurrently after planning succeeds. Each request uses:

- `content_type=video`
- `sort_by=relevance`
- `license_type=commercial`
- `family_friendly=true`
- a short-duration filter when the API supports it consistently
- `per_page=10`

The three lanes and default weights are:

| Lane | Purpose | Weight |
| --- | --- | ---: |
| `literal` | Directly filmable subject, action, and setting | 0.40 |
| `action` | Human motion and emotional behavior | 0.40 |
| `metaphor` | A visually clear symbolic equivalent | 0.20 |

Do not add a local semantic score over Vecteezy titles or metadata. The provider
already ranks each lane; local code only combines those rankings.

### 5. Rank fusion

De-duplicate results by Vecteezy resource ID and combine the three lists with
weighted Reciprocal Rank Fusion:

```text
score(resource) = sum(weight[lane] / (60 + rank_in_lane))
```

Sort by fused score descending, then best individual rank ascending, then
resource ID ascending for deterministic ties. Retain the requested 5-10
candidates.

The response may contain fresh preview URLs for manual review. Preview and
thumbnail URLs are temporary provider data and must not be stored in Postgres.

### 6. `select-video-asset` Edge Function

Expose a second authenticated endpoint for manual selection:

```json
{
  "runId": "d62a53a1-08fb-4bee-a1ed-d8ba13de85f2",
  "providerResourceId": 987654321,
  "note": "Strongest match for the opening image"
}
```

The resource must already be a persisted candidate for the run. A run has at
most one active selection; selecting another candidate replaces the previous
selection atomically. This endpoint records intent only and never downloads an
asset.

## Database Design

### `visual_concepts`

- `id bigint generated always as identity primary key`
- `concept_key text not null unique`
- `description text not null`
- `literal_query text not null`
- `action_query text not null`
- `metaphor_query text not null`
- `embedding extensions.vector(384) not null`
- `enabled boolean not null default true`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Create an HNSW cosine index on enabled concept embeddings if the seeded concept
count grows beyond a small sequential scan. The initial 24-row seed does not
require one for performance.

### `video_search_runs`

- `id uuid primary key default gen_random_uuid()`
- `subtitle_chunk_id bigint null references public.subtitle_chunks(id)`
- `input_kind text not null` with `chunk`, `text`, or `theme` constraint
- `input_digest text not null`
- `theme text null`
- `candidate_count integer not null` constrained to 5-10
- `status text not null` constrained to `planning`, `completed`, `degraded`, or
  `failed`
- `planner_model text not null`
- `prompt_version text not null`
- `fallback_used boolean not null default false`
- `visual_intent jsonb null`
- `planner_elapsed_ms integer null`
- `total_elapsed_ms integer null`
- `failure_code text null`
- `created_at timestamptz not null default now()`
- `completed_at timestamptz null`

`input_digest` is a SHA-256 digest over a versioned canonical request. It supports
idempotency without storing raw ad hoc dialogue. A partial unique index prevents
duplicate in-flight or completed runs for the same digest and prompt version.
Database checks keep `input_kind` consistent with `subtitle_chunk_id`: a chunk
run requires the foreign key, while text-only and theme-only runs do not store
one.

Use a `begin_video_search_run` RPC to atomically return an existing active or
completed run or insert a new `planning` row. A `finish_video_search_run` RPC
writes all query and candidate rows and moves the run to `completed`, `degraded`,
or `failed` in one transaction. Failed rows remain as controlled audit records
but are excluded from the idempotency index so a later request can retry.

### `video_search_queries`

- `id bigint generated always as identity primary key`
- `run_id uuid not null references public.video_search_runs(id) on delete cascade`
- `kind text not null` constrained to `literal`, `action`, or `metaphor`
- `term text not null`
- `weight double precision not null` constrained to `(0, 1]`
- `filters jsonb not null`
- `provider_total integer null`
- `status text not null` constrained to `completed` or `failed`
- `elapsed_ms integer null`
- `created_at timestamptz not null default now()`
- unique `(run_id, kind)`

### `video_search_candidates`

- `id bigint generated always as identity primary key`
- `run_id uuid not null references public.video_search_runs(id) on delete cascade`
- `provider text not null default 'vecteezy'`
- `provider_resource_id bigint not null`
- `title text not null`
- `content_type text not null`
- `license_type text null`
- `ai_generated boolean null`
- `orientation text null`
- `tags text[] not null default '{}'`
- `file_types jsonb not null default '[]'`
- `download_sizes jsonb not null default '[]'`
- `fused_score double precision not null`
- `best_rank integer not null`
- `matched_query_kinds text[] not null`
- `created_at timestamptz not null default now()`
- unique `(run_id, provider, provider_resource_id)`
- unique `(run_id, id)` to support the selection ownership foreign key

Persist only the documented, stable basic fields observed from the API. Do not
persist preview URLs, thumbnail URLs, authorization parameters, or the complete
raw provider response. Duration and dimensions remain optional elements inside
the provider metadata arrays because the live API did not return them
consistently.

### `video_asset_selections`

- `id bigint generated always as identity primary key`
- `run_id uuid not null unique references public.video_search_runs(id) on delete cascade`
- `candidate_id bigint not null`
- `note text null` limited to 500 characters
- `selected_at timestamptz not null default now()`
- foreign key `(run_id, candidate_id)` references
  `public.video_search_candidates(run_id, id)`

The composite foreign key guarantees that `candidate_id` belongs to `run_id`.
An atomic database RPC inserts or replaces the one active selection.

### Privacy and grants

Enable and force RLS on all five tables. Create no policies for `anon` or
`authenticated`. Revoke table, sequence, and function privileges from `public`,
`anon`, and `authenticated`; grant only the minimum required privileges to
`service_role`.

Use `security invoker` functions with `set search_path = ''` where possible.
The finish RPC writes a terminal run state, its three query records, and any
candidate records in one transaction so partially persisted result sets cannot
appear successful.

## Response Contract

A successful `match-video-assets` response has this shape:

```json
{
  "runId": "d62a53a1-08fb-4bee-a1ed-d8ba13de85f2",
  "status": "completed",
  "planner": {
    "model": "gemma4:12b",
    "promptVersion": "visual-plan-v1",
    "fallbackUsed": false
  },
  "visualIntent": {
    "subject": "a solitary adult",
    "action": "opening curtains",
    "setting": "a quiet room at dawn",
    "mood": "renewed hope",
    "lighting": "soft natural sunrise",
    "shot": "medium cinematic shot"
  },
  "queries": [
    { "kind": "literal", "term": "...", "status": "completed" },
    { "kind": "action", "term": "...", "status": "completed" },
    { "kind": "metaphor", "term": "...", "status": "completed" }
  ],
  "candidates": [
    {
      "providerResourceId": 987654321,
      "title": "Person Opening Curtains at Sunrise",
      "licenseType": "commercial",
      "aiGenerated": false,
      "orientation": "horizontal",
      "fileTypes": [{ "extension": "mp4", "size": 12345678 }],
      "downloadSizes": [{ "id": 42, "width": 1920, "height": 1080 }],
      "score": 0.0214,
      "bestRank": 1,
      "matchedBy": ["literal", "action"],
      "previewUrl": "https://temporary-provider-preview.example/video.mp4"
    }
  ]
}
```

The example URL is illustrative and is never a persisted value.

## Failure Handling

- Return `405` for unsupported methods and include CORS headers consistently.
- Return `401` before any inference, database read, or provider request when the
  personal token is absent or invalid.
- Return `400` for invalid input combinations or bounds and `404` for a missing
  or non-ready subtitle chunk.
- Give the planner a 20-second request timeout. Attempt one structured repair,
  then use the concept fallback when the source input is English.
- Give each Vecteezy lane a 10-second timeout. Two or three successful lanes may
  return a `degraded` or `completed` run; fewer than two successful lanes fail
  the run with `502`.
- Never expose provider response bodies, database errors, model prompts, secret
  values, or internal stack traces to the caller.
- Logs may contain run IDs, timings, result counts, and controlled error codes,
  but never subtitle text, raw input text, prompt bodies, or preview URLs.
- An idempotent retry must not repeat planning or provider search. For an existing
  completed run, it may use read-only Vecteezy detail requests for the persisted
  resource IDs to return fresh preview URLs. An active run returns `409` with a
  short `Retry-After` value.

## Security Gate

The current public Ollama tunnel has no verified authentication. Hosted
deployment is blocked until the model endpoint is protected by authentication,
rate limiting, request-size limits, response-size limits, and a strict allowlist
for the required Ollama routes.

Required Edge Function secrets are:

- `VECTEEZY_ACCOUNT`
- `VECTEEZY_API_KEY`
- `AI_INFERENCE_API_HOST`
- `OLLAMA_MODEL=gemma4:12b`
- an Ollama proxy authorization secret if the Session transport cannot attach it

No provider or model secret may be accepted from the request body, returned to
the client, committed to Git, or stored in a database row.

## Testing Strategy

Implementation follows test-driven development.

### Unit tests

- Authentication occurs before inference and external HTTP calls.
- Input unions, lengths, and candidate bounds are enforced.
- Planner output requires exactly one of each query kind.
- Duplicate kinds, overlong terms, dialogue text, named movie references, and
  invented demographic traits are rejected.
- One repair is attempted and no unbounded model retry is possible.
- English fallback selects the nearest enabled visual concept.
- Weighted RRF uses the specified formula, de-duplicates resource IDs, and has
  deterministic tie-breaking.
- Provider response sanitization keeps only approved metadata and never persists
  preview URLs or raw payloads.
- Selection rejects a candidate from another run.

### Database tests

Use pgTAP to verify table shapes, constraints, foreign keys, forced RLS, absent
public policies, grants, vector dimensions, uniqueness, and atomic persistence.
Test that `anon` and `authenticated` cannot read or mutate any new object and
that `service_role` has only the intended access.

### Integration tests

Mock Ollama and Vecteezy to cover valid planning, repair, fallback, one failed
search lane, two failed lanes, timeouts, duplicate resources, empty results, and
malformed provider fields. Assert that no test path invokes a download route.

### Hosted smoke test

After the security gate passes, deploy to the linked Supabase project and run a
generic, non-copyrighted theme through the hosted Edge Function. Verify the
response contract, persisted metadata, private grants, fresh preview URLs, and
unchanged Vecteezy download usage.

Use a 20-theme evaluation set. The initial acceptance target is:

- at least 80% of runs contain one candidate judged strongly relevant in the top
  10 by manual review;
- valid Gemma output after at most one repair;
- a healthy-planner p95 response time below 25 seconds;
- no stored preview URLs or raw provider payloads; and
- zero Vecteezy download calls.

## Rollout Sequence

1. Protect the Ollama endpoint and complete the hosted Session compatibility
   spike.
2. Add the private schema, atomic RPCs, constraints, and pgTAP coverage.
3. Seed and embed the fallback visual concepts with built-in `gte-small`.
4. Add planner, validator, Vecteezy client, RRF, and unit tests.
5. Add and deploy `match-video-assets` behind the existing personal token.
6. Evaluate 20 generic themes and tune prompt text or lane weights without
   changing the response contract.
7. Add and deploy `select-video-asset` after candidate quality is accepted.

## Non-Goals

- Downloading Vecteezy assets or consuming download quota
- Persisting media files in Supabase Storage
- Inspecting clips with ffprobe or a vision model
- Generating embeddings from Vecteezy content or metadata
- Training or fine-tuning a model
- Automatically choosing the top-ranked candidate
- Building a selection UI
- Cutting, captioning, or rendering a video with FFmpeg
- Long-term storage of provider preview URLs

Asset download, technical clip inspection, timeline assembly, and video rendering
will be designed as separate phases after manual candidate quality is proven.
