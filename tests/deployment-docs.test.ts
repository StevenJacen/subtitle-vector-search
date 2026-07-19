import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8')

function sectionBetween(startHeading: string, endHeading: string): string {
  const headingIndex = (heading: string): number => {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`^${escapedHeading}\\r?$`, 'm').exec(readme)?.index ?? -1
  }
  const start = headingIndex(startHeading)
  const end = headingIndex(endHeading)

  expect(start, `${startHeading} heading`).toBeGreaterThan(-1)
  expect(end, `${endHeading} heading`).toBeGreaterThan(start)
  return readme.slice(start, end)
}

function requestExample(section: string, endpoint: string): string {
  const endpointMarker = `/functions/v1/${endpoint}`
  const endpointIndex = section.indexOf(endpointMarker)
  const requestStart = section.lastIndexOf('Invoke-RestMethod -Method Post', endpointIndex)
  const nextRequest = section.indexOf('Invoke-RestMethod -Method Post', endpointIndex)
  const codeFence = section.indexOf('```', endpointIndex)
  const requestEnd = nextRequest === -1 || codeFence < nextRequest ? codeFence : nextRequest

  expect(endpointIndex, `${endpoint} endpoint example`).toBeGreaterThan(-1)
  expect(requestStart, `${endpoint} POST example`).toBeGreaterThan(-1)
  expect(requestEnd, `${endpoint} example end`).toBeGreaterThan(endpointIndex)
  return section.slice(requestStart, requestEnd)
}

it('documents hosted deployment in migration-before-function order', () => {
  const login = readme.indexOf('npx supabase login')
  const link = readme.indexOf('npx supabase link --project-ref kwoppqigrtvgmmbnzbpx')
  const push = readme.indexOf('npx supabase db push')
  const secrets = readme.indexOf('npx supabase secrets set SUBTITLE_PERSONAL_TOKEN=<random-secret>')
  const deploy = readme.indexOf('npx supabase functions deploy ingest-subtitles --no-verify-jwt')

  expect(login).toBeGreaterThan(-1)
  expect(link).toBeGreaterThan(login)
  expect(push).toBeGreaterThan(link)
  expect(secrets).toBeGreaterThan(push)
  expect(deploy).toBeGreaterThan(secrets)
  expect(readme).toContain('npx supabase migration list')
  expect(readme).toContain('npx supabase db lint --linked --level warning')
  expect(readme).toContain('Remote deployment compilation is mandatory')
})

it('documents the server-side movie quote montage example', () => {
  expect(readme).toContain('npx supabase functions deploy movie-quote-montage --no-verify-jwt')
  expect(readme).toContain("'x-subtitle-token' = $env:SUBTITLE_PERSONAL_TOKEN")
  expect(readme).toContain('"theme":"love and time"')
  expect(readme).toContain('"quoteCount":8')
  expect(readme).toContain('"matchThreshold":0.72')
  expect(readme).toContain('"maxPerMovie":1')
  expect(readme).toContain("new Supabase.ai.Session('gte-small')")
})

it('documents the isolated Supabase RRF experiment', () => {
  expect(readme).toContain('npx supabase functions deploy hybrid-subtitle-search --no-verify-jwt')
  expect(readme).toContain('/functions/v1/hybrid-subtitle-search')
  expect(readme).toContain('"query":"love and time","limit":12')
  expect(readme).toContain('rrfScore')
  expect(readme).toContain('semanticRank')
  expect(readme).toContain('fullTextRank')
  expect(readme).toContain('full_text_weight = 1')
  expect(readme).toContain('semantic_weight = 2')
  expect(readme).toContain('rrf_k = 50')
})

it('documents hosted planner transports and the explicit internal test exception', () => {
  const configuration = sectionBetween(
    '### Video Candidate Matching Configuration',
    '## Local Testing',
  )

  expect(configuration).toContain('VECTEEZY_ACCOUNT=<account-id>')
  expect(configuration).toContain('VECTEEZY_API_KEY=<api-key>')
  expect(configuration).toContain('AI_INFERENCE_API_HOST=https://<authenticated-ollama-gateway>')
  expect(configuration).toContain('OLLAMA_MODEL=gemma4:12b')
  expect(configuration).toContain('VIDEO_PLANNER_TRANSPORT=supabase-ai')
  expect(configuration).toContain('OLLAMA_GATEWAY_SECURITY_CONFIRMED=true')
  expect(configuration).toContain('VIDEO_PLANNER_TRANSPORT=ollama-http')
  expect(configuration).toContain('OLLAMA_AUTH_TOKEN=<bearer-token>')
  expect(configuration).toContain('OLLAMA_ALLOW_UNAUTHENTICATED_TEST_GATEWAY=true')
  expect(configuration).toContain("Supabase.ai.Session('gemma4:12b')")
  expect(configuration).toMatch(
    /hosted compatibility\s+with\s+`AI_INFERENCE_API_HOST`\s+is\s+not\s+yet proven/i,
  )
  expect(configuration).toMatch(
    /keep hosted inference disabled\s+until\s+both the security gate and the\s+hosted compatibility spike pass/i,
  )
  expect(configuration).toMatch(/unauthenticated `GET \/api\/tags` must return HTTP (401 or 403|401\/403)/)
  expect(configuration).toMatch(/`ollama-http`[^.]+`AI_INFERENCE_API_HOST`[^.]+`OLLAMA_AUTH_TOKEN`[^.]+`OLLAMA_MODEL`/)
  expect(configuration).toMatch(/internal test[^.]+explicit[^.]+unauthenticated/i)
  expect(configuration).toMatch(/never enable[^.]+production/i)
  expect(configuration).toMatch(/local[^.]+`GET \/api\/tags`[^.]+not sufficient/i)
  expect(configuration).toContain('`text/html`')
  expect(configuration).not.toContain('supabase-ai` transport uses the configured authenticated gateway')
})

it('scopes migration and authenticated requests to the video candidate workflow', () => {
  const remoteDeployment = sectionBetween('## Remote Deployment', '## Video Candidate Matching')
  const workflow = sectionBetween('## Video Candidate Matching', '## Movie Quote Montage')
  const push = workflow.indexOf('npx supabase db push')
  const seed = workflow.indexOf('npx supabase functions deploy seed-visual-concepts --no-verify-jwt')
  const match = workflow.indexOf('npx supabase functions deploy match-video-assets --no-verify-jwt')
  const select = workflow.indexOf('npx supabase functions deploy select-video-asset --no-verify-jwt')

  expect(remoteDeployment).toContain('Migrations must be pushed before any function is deployed')
  expect(seed).toBeGreaterThan(push)
  expect(match).toBeGreaterThan(seed)
  expect(select).toBeGreaterThan(match)

  for (const endpoint of ['seed-visual-concepts', 'match-video-assets', 'select-video-asset']) {
    const example = requestExample(workflow, endpoint)
    expect(example).toContain("'x-subtitle-token' = $env:SUBTITLE_PERSONAL_TOKEN")
  }
  const seedExample = requestExample(workflow, 'seed-visual-concepts')
  expect(workflow).toContain('0..23 | ForEach-Object')
  expect(seedExample).toContain('seed-visual-concepts?index=$_')
})

it('documents private candidate records and synthetic examples in its own section', () => {
  const workflow = sectionBetween('## Video Candidate Matching', '## Movie Quote Montage')
  const matchExample = requestExample(workflow, 'match-video-assets')
  const approvedSyntheticBody = '{"theme":"a fresh start after uncertainty","candidateCount":8}'

  expect(matchExample).toContain(`-Body '${approvedSyntheticBody}'`)
  expect(matchExample).not.toMatch(/"(?:text|subtitleChunkId)"\s*:/)
  expect(workflow).toContain('inclusive range 5-10')
  expect(workflow).toContain('`literal`, `action`, and `metaphor`')
  expect(workflow).toContain('manual selection')
  for (const table of [
    'visual_concepts',
    'video_search_runs',
    'video_search_queries',
    'video_search_candidates',
    'video_asset_selections',
  ]) {
    expect(workflow).toContain(`\`${table}\``)
  }
  expect(workflow).toContain('idempotent')
  expect(workflow).toMatch(/does not (?:store|persist) preview URLs/i)
  expect(workflow).toContain('does not call a Vecteezy download endpoint')
  expect(workflow).toContain('does not fetch media')
  expect(workflow).toContain('does not train')
  expect(workflow).toContain('Rollback and deactivation')
  expect(workflow).toMatch(/generic synthetic (?:visual )?theme/i)
  expect(workflow).toMatch(/do\s+not send real movie dialogue/i)
})
