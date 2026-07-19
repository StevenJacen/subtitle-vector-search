import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const seedSource = readFileSync(
  resolve(process.cwd(), 'supabase/functions/seed-visual-concepts/index.ts'),
  'utf8',
)

const matchSource = readFileSync(
  resolve(process.cwd(), 'supabase/functions/match-video-assets/index.ts'),
  'utf8',
)

const selectionSource = readFileSync(
  resolve(process.cwd(), 'supabase/functions/select-video-asset/index.ts'),
  'utf8',
)

describe('visual concept seed Edge entry', () => {
  it('loads the native model before serving and authenticates before database work', () => {
    expect(seedSource).toContain("import 'jsr:@supabase/functions-js/edge-runtime.d.ts'")
    expect(seedSource).toContain("from 'npm:@supabase/supabase-js@2.110.2'")
    expect(seedSource).toContain("const embeddingSession = new Supabase.ai.Session('gte-small')")
    expect(seedSource).toContain('handleAuthenticatedRequest(request, Deno.env')
    expect(seedSource.indexOf("const embeddingSession = new Supabase.ai.Session('gte-small')"))
      .toBeLessThan(seedSource.indexOf('Deno.serve'))
    expect(seedSource.indexOf('handleAuthenticatedRequest(request, Deno.env'))
      .toBeLessThan(seedSource.indexOf('createClient('))
    expect(seedSource).not.toContain('request.json()')
  })

  it('injects built-in inference and the Task 3 RPC into the bounded seed helper', () => {
    expect(seedSource).toContain("new Supabase.ai.Session('gte-small')")
    expect(seedSource).toContain("const index = new URL(request.url).searchParams.get('index')")
    expect(seedSource).toContain('seedVisualConcepts({')
    expect(seedSource).toContain('session: embeddingSession,')
    expect(seedSource).toContain('client,')
    expect(seedSource).toContain('}, index)')
    expect(seedSource).toContain('jsonResponse(result)')
  })

  it('returns controlled method and seed errors without logging secrets or payloads', () => {
    expect(seedSource).toContain("errorResponse(405, 'method_not_allowed', 'only POST is supported')")
    expect(seedSource).toContain('error instanceof VisualConceptSeedIndexError')
    expect(seedSource).toContain(
      "errorResponse(400, 'invalid_seed_index', 'index must be an integer from 0 to 23')",
    )
    expect(seedSource).toContain("errorResponse(500, 'visual_concept_seed_failed', 'visual concept seed failed')")
    expect(seedSource).not.toContain('console.log')
    expect(seedSource).not.toContain('console.error')
    expect(seedSource).not.toContain('error.message')
  })
})

describe('video asset matching Edge entry', () => {
  it('pins Edge imports and rejects methods other than POST', () => {
    const methodGuard = matchSource.indexOf("if (request.method !== 'POST')")
    const methodResponse = matchSource.indexOf(
      "errorResponse(405, 'method_not_allowed', 'only POST is supported')",
    )
    const auth = matchSource.indexOf('handleAuthenticatedRequest(request, Deno.env')

    expect(matchSource).toContain("import 'jsr:@supabase/functions-js/edge-runtime.d.ts'")
    expect(matchSource).toContain("from 'npm:@supabase/supabase-js@2.110.2'")
    expect(methodGuard).toBeGreaterThan(-1)
    expect(methodResponse).toBeGreaterThan(-1)
    expect(auth).toBeGreaterThan(-1)
    expect(methodGuard).toBeLessThan(auth)
    expect(methodResponse).toBeLessThan(auth)
    expect(matchSource).toContain(
      "errorResponse(405, 'method_not_allowed', 'only POST is supported')",
    )
  })

  it('authenticates before parsing JSON or constructing dependencies', () => {
    const auth = matchSource.indexOf('handleAuthenticatedRequest(request, Deno.env')

    expect(auth).toBeGreaterThan(-1)
    expect(auth).toBeLessThan(matchSource.indexOf('request.json()'))
    expect(auth).toBeLessThan(matchSource.indexOf('createDependencies(Deno.env)'))
    expect(matchSource).toContain('parseVideoAssetRequest(await request.json())')
    expect(matchSource).toContain('matchVideoAssets(input, createDependencies(Deno.env))')
    expect(matchSource.indexOf('createDependencies(Deno.env)'))
      .toBeLessThan(matchSource.indexOf('createClient('))
    expect(matchSource.indexOf('createDependencies(Deno.env)'))
      .toBeLessThan(matchSource.indexOf("new Supabase.ai.Session('gte-small')"))
    expect(matchSource.indexOf('createDependencies(Deno.env)'))
      .toBeLessThan(matchSource.indexOf('createPlannerTransport(environment)'))
  })

  it('reads the exact service and provider secrets only on the server', () => {
    const expectedNames = [
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'VECTEEZY_ACCOUNT',
      'VECTEEZY_API_KEY',
    ]
    for (const name of expectedNames) {
      expect(matchSource).toContain(`requiredEnvironment(environment, '${name}')`)
    }
    expect(Array.from(
      matchSource.matchAll(/requiredEnvironment\(environment, '([^']+)'\)/g),
      match => match[1],
    )).toEqual(expectedNames)

    expect(matchSource).toContain('const value = environment.get(name)')
    expect(matchSource).not.toContain('input.SUPABASE')
    expect(matchSource).not.toContain('input.VECTEEZY')
    expect(matchSource).not.toContain('request.headers.get')
  })

  it('wires the committed matching dependencies', () => {
    for (const boundary of [
      'repository: createVideoAssetRepository(client)',
      'createPlannerTransport(environment)',
      'planVisualSearch(input, {',
      'fallbackVisualPlan(fallbackInput, { session, client })',
      'searchVecteezy(term, providerOptions)',
      'getVecteezyResource(providerResourceId, providerOptions)',
      'fuse: fuseVecteezyLanes',
      'sha256,',
      'now: Date.now',
    ]) {
      expect(matchSource).toContain(boundary)
    }
    expect(matchSource).toContain('resources: page.resources')
    expect(matchSource).toContain('totalResources: page.totalResources')
    expect(matchSource).toContain('fetcher: fetch')
    expect(matchSource).toContain("crypto.subtle.digest('SHA-256'")
    expect(matchSource).toContain("byte.toString(16).padStart(2, '0')")
  })

  it('returns stable controlled errors without logging or download paths', () => {
    expect(matchSource).toContain('if (error instanceof VideoAssetError)')
    expect(matchSource).toContain('errorResponse(error.status, error.code, error.message)')
    expect(matchSource).toContain('if (error instanceof SyntaxError)')
    expect(matchSource).toContain("errorResponse(400, 'invalid_request', 'invalid request')")
    expect(matchSource).toContain(
      "errorResponse(500, 'video_asset_match_failed', 'video asset matching failed')",
    )
    expect(matchSource).not.toContain('console.')
    expect(matchSource.toLocaleLowerCase('en-US')).not.toContain('download')
  })
})

describe('video asset selection Edge entry', () => {
  it('pins Edge imports and delegates to the authenticated selection handler', () => {
    expect(selectionSource).toContain("import 'jsr:@supabase/functions-js/edge-runtime.d.ts'")
    expect(selectionSource).toContain("from 'npm:@supabase/supabase-js@2.110.2'")
    expect(selectionSource).toContain('handleSelectVideoAssetRequest(')
    expect(selectionSource).toContain('() => createSelectionRepository(Deno.env)')
  })

  it('uses only the service-role database path and has no model, provider, detail, or media-fetch path', () => {
    const expectedNames = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
    for (const name of expectedNames) {
      expect(selectionSource).toContain(`requiredEnvironment(environment, '${name}')`)
    }
    expect(Array.from(
      selectionSource.matchAll(/requiredEnvironment\(environment, '([^']+)'\)/g),
      match => match[1],
    )).toEqual(expectedNames)
    expect(selectionSource).not.toContain('planner')
    expect(selectionSource).not.toContain('gte-small')
    expect(selectionSource).not.toContain('Vecteezy')
    expect(selectionSource).not.toContain('detail')
    expect(selectionSource.toLocaleLowerCase('en-US')).not.toContain('download')
  })

})
