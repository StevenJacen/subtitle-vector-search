import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'supabase/functions/match-video-assets/index.ts'),
  'utf8',
)

describe('video asset matching Edge entry', () => {
  it('pins Edge imports and rejects methods other than POST', () => {
    expect(source).toContain("import 'jsr:@supabase/functions-js/edge-runtime.d.ts'")
    expect(source).toContain("from 'npm:@supabase/supabase-js@2.110.2'")
    expect(source).toContain("if (request.method !== 'POST')")
    expect(source).toContain(
      "errorResponse(405, 'method_not_allowed', 'only POST is supported')",
    )
  })

  it('authenticates before parsing JSON or constructing dependencies', () => {
    const auth = source.indexOf('handleAuthenticatedRequest(request, Deno.env')

    expect(auth).toBeGreaterThan(-1)
    expect(auth).toBeLessThan(source.indexOf('request.json()'))
    expect(auth).toBeLessThan(source.indexOf('createDependencies(Deno.env)'))
    expect(source).toContain('parseVideoAssetRequest(await request.json())')
    expect(source).toContain('matchVideoAssets(input, createDependencies(Deno.env))')
    expect(source.indexOf('createDependencies(Deno.env)'))
      .toBeLessThan(source.indexOf('createClient('))
    expect(source.indexOf('createDependencies(Deno.env)'))
      .toBeLessThan(source.indexOf("new Supabase.ai.Session('gte-small')"))
    expect(source.indexOf('createDependencies(Deno.env)'))
      .toBeLessThan(source.indexOf('createPlannerTransport(environment)'))
  })

  it('reads the exact service and provider secrets only on the server', () => {
    const expectedNames = [
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'VECTEEZY_ACCOUNT',
      'VECTEEZY_API_KEY',
    ]
    for (const name of expectedNames) {
      expect(source).toContain(`requiredEnvironment(environment, '${name}')`)
    }
    expect(Array.from(
      source.matchAll(/requiredEnvironment\(environment, '([^']+)'\)/g),
      match => match[1],
    )).toEqual(expectedNames)

    expect(source).toContain('const value = environment.get(name)')
    expect(source).not.toContain('input.SUPABASE')
    expect(source).not.toContain('input.VECTEEZY')
    expect(source).not.toContain('request.headers.get')
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
      expect(source).toContain(boundary)
    }
    expect(source).toContain('resources: page.resources')
    expect(source).toContain('totalResources: page.totalResources')
    expect(source).toContain('fetcher: fetch')
    expect(source).toContain("crypto.subtle.digest('SHA-256'")
    expect(source).toContain("byte.toString(16).padStart(2, '0')")
  })

  it('returns stable controlled errors without logging or download paths', () => {
    expect(source).toContain('if (error instanceof VideoAssetError)')
    expect(source).toContain('errorResponse(error.status, error.code, error.message)')
    expect(source).toContain('if (error instanceof SyntaxError)')
    expect(source).toContain("errorResponse(400, 'invalid_request', 'invalid request')")
    expect(source).toContain(
      "errorResponse(500, 'video_asset_match_failed', 'video asset matching failed')",
    )
    expect(source).not.toContain('console.')
    expect(source.toLocaleLowerCase('en-US')).not.toContain('download')
  })
})
