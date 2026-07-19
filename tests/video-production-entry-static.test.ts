import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'supabase/functions/video-production-metadata/index.ts'), 'utf8')

describe('video production metadata Edge entry', () => {
  it('pins the Edge runtime and Supabase client then delegates to the shared handler', () => {
    expect(source).toContain("import 'jsr:@supabase/functions-js/edge-runtime.d.ts'")
    expect(source).toContain("from 'npm:@supabase/supabase-js@2.110.2'")
    expect(source).toContain('handleVideoProductionRequest(')
    expect(source).toContain('() => createProductionRepository(Deno.env)')
  })

  it('creates the service-role client lazily with only server environment values', () => {
    expect(source).toContain("requiredEnvironment(environment, 'SUPABASE_URL')")
    expect(source).toContain("requiredEnvironment(environment, 'SUPABASE_SERVICE_ROLE_KEY')")
    expect(source.indexOf('handleVideoProductionRequest(')).toBeLessThan(source.indexOf('createClient('))
    expect(source).not.toContain('request.json()')
    expect(source).not.toContain('console.')
    expect(source).not.toContain('VECTEEZY')
    expect(source.toLocaleLowerCase('en-US')).not.toContain('downloadurl')
  })
})
