# Private Subtitle Semantic Search

This is a private, English-only subtitle research tool. It parses authorized `.srt` or `.vtt` files locally, stores source cues and normalized `gte-small` embeddings in a private Supabase project, and returns ranked dialogue with exact timestamps.

Only import subtitles you are authorized to possess and use for personal research. This repository does not provide subtitle files, and its seed data is wholly synthetic.

## Requirements

- Node.js and npm
- Supabase CLI
- Docker Desktop for local Supabase testing
- A Supabase project you control for hosted use
- Optional OpenSubtitles credentials for the `download` command

The current pipeline accepts English subtitle tracks only. It does not translate, detect, or search non-English subtitle content.

## Environment

Create `.env` from `.env.example` and set the following values for the project you intend to use:

```dotenv
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<publishable-key>
SUBTITLE_PERSONAL_TOKEN=<long-random-secret>
OPENSUBTITLES_API_KEY=<opensubtitles-api-key>
OPENSUBTITLES_TOKEN=<opensubtitles-user-token>
OPENSUBTITLES_USER_AGENT=private-subtitle-search v1.0
```

`OPENSUBTITLES_API_KEY`, `OPENSUBTITLES_TOKEN`, and `OPENSUBTITLES_USER_AGENT` are required only when using `subtitle download`. Obtain and use OpenSubtitles credentials in accordance with its terms and your account permissions. Keep `.env`, database passwords, and personal tokens out of source control.

## Local Testing

Local Supabase uses Docker. The seed adds one synthetic ready track with three synthetic cues and two normalized 384-dimensional vectors; it never adds real subtitle dialogue.

```powershell
npm install
npx supabase start
npx supabase db reset
npx supabase test db
npm test
npm run typecheck
```

To exercise both Edge Functions locally, set a non-production token in the current PowerShell session and start the functions:

```powershell
$env:SUBTITLE_PERSONAL_TOKEN='local-test-token'
npx supabase functions serve --no-verify-jwt
```

In a second PowerShell session, an invalid custom token must receive HTTP 401 from both routes:

```powershell
Invoke-WebRequest -Method Post -Uri http://127.0.0.1:54321/functions/v1/ingest-subtitles -Headers @{ 'x-subtitle-token' = 'wrong-token' } -ContentType 'application/json' -Body '{"action":"start"}'
Invoke-WebRequest -Method Post -Uri http://127.0.0.1:54321/functions/v1/search-subtitles -Headers @{ 'x-subtitle-token' = 'wrong-token' } -ContentType 'application/json' -Body '{"query":"lantern"}'
```

Both commands are expected to report a 401 response. Do not use a hosted token for local testing.

## Remote Deployment

Remote deployment changes hosted project state. Link the CLI to a Supabase project you control before running the commands below, and set the local CLI environment values required by your project. The Edge Runtime receives `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from Supabase; set the separate personal token as a function secret.

```powershell
npm install
npx supabase login
npx supabase link --project-ref kwoppqigrtvgmmbnzbpx
npx supabase db push
npx supabase secrets set SUBTITLE_PERSONAL_TOKEN=<random-secret>
npx supabase functions deploy ingest-subtitles --no-verify-jwt
npx supabase functions deploy search-subtitles --no-verify-jwt
npx tsx src/cli.ts import <authorized-file.srt> --title "The Shawshank Redemption" --year 1994 --imdb tt0111161 --source manual
npx tsx src/cli.ts search "hope during hard times"
```

Migrations must be pushed before either function is deployed. The project ref above is the target project for this workflow; substitute a different ref only when intentionally deploying elsewhere. Remote deployment compilation is mandatory because local Deno semantic checking is not available in every Node development environment.

Verify the linked migration state and run hosted database advisors after deployment:

```powershell
npx supabase migration list
npx supabase db lint --linked --level warning
```

The schema and Edge Functions are deployed to the project above. Deployment does not import subtitle content; import only English subtitle files you are authorized to retain and use.

The CLI can also retrieve a subtitle through the official OpenSubtitles API when your credentials and rights permit it:

```powershell
npx tsx src/cli.ts download --imdb 0111161 --output downloads/authorized.srt
npx tsx src/cli.ts import downloads/authorized.srt --title "Authorized Title" --year 2026 --imdb tt0000001 --source opensubtitles --source-ref opensubtitles:42
npx tsx src/cli.ts search "quiet determination" --limit 10
npx tsx src/cli.ts search "quiet determination" --movie-id 7
```

Search output is compact and timestamped:

```text
0.842  00:42:13.120 --> 00:42:18.900
The matching dialogue text...
```

## Privacy And Data Lifecycle

All subtitle tables use forced row-level security with no policies for `anon` or `authenticated`. Direct table, sequence, and `match_subtitle_chunks` access is revoked from public roles; only the Edge Functions' service role can read and write subtitle data after custom-token authentication. Search fetches only the exact cue interval for each ranked chunk, never an entire track.

Back up only data you are entitled to retain. For a hosted project, an operator can export the private tables with a protected database URL:

```powershell
pg_dump --data-only --table=public.movies --table=public.subtitle_tracks --table=public.subtitle_cues --table=public.subtitle_chunks "$env:DATABASE_URL" > subtitle-backup.sql
```

Deleting a movie cascades to its tracks, cues, embeddings, and chunk claims:

```sql
delete from public.movies where imdb_id = 'tt0111161';
```

Use the movie ID or a more specific predicate when removing content. Verify the selected rows before running destructive SQL.

## Troubleshooting

- **Docker is unavailable:** `npx supabase start`, `db reset`, `test db`, and local function serving require Docker Desktop with a running engine. Start Docker Desktop, verify `docker version`, then rerun the local workflow.
- **Function secret missing:** set `SUBTITLE_PERSONAL_TOKEN` with `npx supabase secrets set SUBTITLE_PERSONAL_TOKEN=<random-secret>`, redeploy both functions, and use that same value in the CLI `.env` file.
- **HTTP 401:** confirm the request sends `x-subtitle-token`, the value exactly matches the function secret, and the function deployment is the intended project. The Supabase publishable key does not replace this custom token.
- **OpenSubtitles HTTP 429:** wait for the `Retry-After` duration and retry within your account quota. The client retries bounded transient responses, but it cannot override provider limits.
- **Model dimension error:** this project requires `gte-small` embeddings with `mean_pool: true`, `normalize: true`, and exactly 384 finite numeric dimensions. Do not mix vectors from another model or change the vector column dimension.
- **No matching dialogue found:** this is a successful search with no ranked results. An `empty_ready_track` API error means the requested movie has no finalized ready subtitle track; import authorized English subtitles and finalize the track first.
