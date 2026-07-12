# Subtitle Vector Search Design

## Goal

Build a private, personal-research workflow that obtains or accepts an English subtitle file for *The Shawshank Redemption*, preserves every cue's timestamp, stores the structured subtitles in Supabase, and retrieves matching dialogue by semantic similarity.

The first version supports English subtitle text and English search queries only. It does not publish, redistribute, or expose full subtitle files.

## Constraints

- Embeddings use Supabase Edge Runtime's built-in `gte-small` model. No OpenAI API or other external embedding API is used.
- `gte-small` is English-only, accepts at most 512 tokens before truncation, and produces 384-dimensional vectors.
- Subtitle acquisition is for private personal research. OpenSubtitles support uses its official API and user-supplied credentials. Every imported track records its source and rights status.
- The repository starts empty and is not currently a Git repository.
- Supabase tables remain private. Browser clients never receive the service-role key.

## Recommended Architecture

The system has three boundaries:

1. A local TypeScript CLI downloads an optional OpenSubtitles file or accepts a local `.srt`/`.vtt`, parses and normalizes cues, builds overlapping dialogue chunks, and invokes Supabase Edge Functions.
2. Supabase Edge Functions authenticate a personal API token, generate embeddings with `Supabase.ai.Session('gte-small')`, and perform database operations with the server-only service-role key.
3. PostgreSQL stores movie metadata, subtitle tracks, exact cues, and searchable chunks. `pgvector` performs cosine-similarity retrieval and returns cue IDs so exact timestamped lines can be reconstructed.

This division keeps subtitle parsing deterministic and testable locally, keeps embedding execution inside Supabase, and prevents database credentials from being exposed in client code.

## Alternatives Considered

### Edge Function parses and embeds an entire subtitle file

This minimizes local code, but a full movie import can exceed Edge Function execution limits and makes partial retry difficult. It is not selected.

### PostgreSQL webhook and queue generate embeddings automatically

This is appropriate for continuously changing document collections, but adds `pgmq`, webhooks, cron, and retry workers for a one-film personal workflow. It is deferred.

### Local multilingual embedding model

This would support Chinese queries and avoid external embedding APIs, but requires a local model runtime and changes the deployment model. It is outside the English-only first version.

## Components

### Local CLI

The CLI provides these commands:

- `subtitle download`: searches and downloads a subtitle through the official OpenSubtitles REST API. It requires `OPENSUBTITLES_API_KEY` and any account credentials required by the API. The downloaded file remains local.
- `subtitle import <path>`: parses SRT or WebVTT, validates timestamps, creates deterministic chunks, and sends batches to the ingestion Edge Function.
- `subtitle search <query>`: calls the search Edge Function and prints ranked timestamped dialogue results.

The CLI reads Supabase URL, publishable key, and a custom personal token from environment variables. It never stores the Supabase service-role key.

### Ingestion Edge Function

The ingestion function accepts movie metadata, track provenance, normalized cues, and chunks in bounded batches. It:

1. Rejects missing or incorrect personal tokens before model inference.
2. Validates payload size, English-only model metadata, timestamps, and chunk-to-cue references.
3. Generates normalized 384-dimensional embeddings with `gte-small`.
4. Upserts the movie and track, inserts cues idempotently, and upserts chunks by track and chunk index.
5. Returns per-batch counts and stable identifiers so the CLI can resume after failure.

The final batch marks the track `ready`. A failed or interrupted import remains `processing` or `failed` and can be resumed safely.

### Search Edge Function

The search function authenticates the personal token, validates a non-empty English query, generates one normalized query embedding, and invokes a database similarity function. It returns ranked chunks plus their exact cues and timestamps.

Search defaults to ten results and caps requests at fifty. The database function caps its own result count as defense in depth.

## Database Design

The `vector` extension is installed in the `extensions` schema.

### `movies`

- `id bigint generated always as identity primary key`
- `title text not null`
- `release_year integer`
- `imdb_id text`
- `created_at timestamptz not null default now()`
- Unique constraint on non-null `imdb_id`

### `subtitle_tracks`

- `id bigint generated always as identity primary key`
- `movie_id bigint not null references movies(id) on delete cascade`
- `language_code text not null`
- `source text not null`
- `source_ref text`
- `source_file_name text`
- `source_sha256 text not null`
- `rights_status text not null` with values `personal_research`, `licensed`, or `unverified`
- `embedding_model text not null default 'gte-small'`
- `embedding_dimensions integer not null default 384`
- `status text not null` with values `processing`, `ready`, or `failed`
- `created_at timestamptz not null default now()`
- Unique constraint on `(movie_id, language_code, source_sha256)`

### `subtitle_cues`

- `id bigint generated always as identity primary key`
- `track_id bigint not null references subtitle_tracks(id) on delete cascade`
- `cue_index integer not null`
- `start_ms integer not null`
- `end_ms integer not null`
- `text text not null`
- Check constraints require `cue_index >= 0`, `start_ms >= 0`, and `end_ms > start_ms`
- Unique constraint on `(track_id, cue_index)`

### `subtitle_chunks`

- `id bigint generated always as identity primary key`
- `track_id bigint not null references subtitle_tracks(id) on delete cascade`
- `chunk_index integer not null`
- `start_ms integer not null`
- `end_ms integer not null`
- `text text not null`
- `first_cue_index integer not null`
- `last_cue_index integer not null`
- `embedding extensions.vector(384) not null`
- Check constraints validate time and cue ranges
- Unique constraint on `(track_id, chunk_index)`

Foreign-key columns are indexed. Cues also have `(track_id, start_ms)`. Chunks use an HNSW index with `vector_cosine_ops`; exact scans remain acceptable for the small initial corpus, but the index keeps the schema ready for additional films.

## Chunking Rules

- Normalize line endings and whitespace while preserving spoken text and cue boundaries.
- Remove SRT/VTT formatting tags from embedding text, while retaining the cleaned cue text stored in the database.
- Build chunks from consecutive cues, targeting 150 to 300 English tokens and never exceeding 450 tokens.
- Add an overlap of two cues between adjacent chunks.
- Never split a cue. Each chunk records its first and last cue index and derives its timestamp range from those cues.
- Reject empty files, malformed timestamp ranges, duplicate cue indexes, and files with no usable spoken text.

These limits stay below the model's 512-token truncation boundary while preserving enough dialogue context for useful retrieval.

## Data Flow

### Import

1. The user obtains an authorized local subtitle or invokes the optional OpenSubtitles downloader.
2. The CLI computes SHA-256, parses cues, validates ordering, and creates chunks.
3. The CLI starts an import and receives movie and track IDs.
4. It sends bounded cue/chunk batches. The Edge Function embeds only chunks not already present.
5. The CLI finalizes the track and reports cue and chunk counts.

### Search

1. The CLI sends an English query and optional movie/track filters.
2. The Edge Function creates one `gte-small` query vector.
3. PostgreSQL ranks ready chunks by cosine similarity.
4. The Edge Function loads the exact cues between each result's first and last cue indexes.
5. The CLI prints similarity, `HH:MM:SS.mmm` ranges, and dialogue.

## Security

- Enable and force RLS on all four public tables.
- Create no `anon` or `authenticated` table policies in the first version.
- Revoke direct table privileges from `anon` and `authenticated`; grant only the server-side service role the required access.
- Similarity functions use `security invoker`, set an explicit empty `search_path`, qualify all schema names, revoke default `PUBLIC` execution, and grant execution only to `service_role`.
- Edge Functions compare the submitted personal token using a constant-time comparison before using the service-role client or running inference.
- `.env` files, OpenSubtitles credentials, personal tokens, and downloaded subtitle files are ignored by version control.
- Logs contain counts and identifiers, not full subtitle text or secrets.

## Error Handling and Idempotency

- The source file SHA-256 prevents accidental duplicate tracks.
- `(track_id, cue_index)` and `(track_id, chunk_index)` make batch retries idempotent.
- Validation errors are returned as structured JSON with stable error codes.
- Model or database failures mark the import failed only after the CLI exhausts bounded retries; a subsequent import resumes missing chunks.
- OpenSubtitles HTTP 401, 403, 404, 406, and 429 responses receive distinct actionable messages. Rate-limit metadata is honored; retries use bounded exponential backoff.
- Search never returns tracks whose status is not `ready`.

## Testing

### Unit tests

- Parse representative SRT and WebVTT timestamps and multiline cues.
- Reject malformed and backward timestamps.
- Verify chunk size, overlap, cue ranges, and deterministic output.
- Verify timestamp formatting and OpenSubtitles response normalization.
- Verify Edge Function request validation and personal-token rejection without invoking the model.

### Integration tests

- Apply the migration to local Supabase and verify RLS blocks publishable-key table access.
- Import a small synthetic subtitle fixture and verify exact cue timestamps and 384-dimensional vectors.
- Search a semantically related English query and verify the expected chunk and cues are returned.
- Retry an import batch and verify row counts do not increase.

### Manual acceptance test

Using an authorized English subtitle for *The Shawshank Redemption*, complete an import, search for an English concept such as `hope during hard times`, and receive ranked dialogue with exact timestamps. No OpenAI credential is configured or used.

## Deliverables

- Supabase CLI project configuration and SQL migration.
- `ingest-subtitles` and `search-subtitles` Edge Functions with shared authentication and validation helpers.
- TypeScript CLI with local-file import, optional OpenSubtitles download, and search commands.
- Synthetic subtitle fixtures and automated tests.
- `.env.example`, `.gitignore`, and a concise setup and usage guide.

## Deferred Scope

- Chinese subtitles or Chinese-to-English semantic search.
- Browser UI, multi-user authentication, or public sharing.
- Automated subtitle redistribution or a bundled copyrighted subtitle file.
- Automatic queue/webhook embedding pipelines.
- Speaker identification and scene-level metadata.
