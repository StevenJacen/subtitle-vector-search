import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'supabase/functions/seed-visual-concepts/index.ts'),
  'utf8',
)

describe('visual concept seed Edge entry', () => {
  it('uses pinned Edge dependencies and authenticates before model or database work', () => {
    expect(source).toContain("import 'jsr:@supabase/functions-js/edge-runtime.d.ts'")
    expect(source).toContain("from 'npm:@supabase/supabase-js@2.110.2'")
    expect(source).toContain('handleAuthenticatedRequest(request, Deno.env')
    expect(source.indexOf('handleAuthenticatedRequest(request, Deno.env'))
      .toBeLessThan(source.indexOf("new Supabase.ai.Session('gte-small')"))
    expect(source.indexOf('handleAuthenticatedRequest(request, Deno.env'))
      .toBeLessThan(source.indexOf('createClient('))
    expect(source).not.toContain('request.json()')
  })

  it('injects built-in inference and the Task 3 RPC into the bounded seed helper', () => {
    expect(source).toContain("new Supabase.ai.Session('gte-small')")
    expect(source).toContain('seedVisualConcepts({')
    expect(source).toContain('session,')
    expect(source).toContain('client,')
    expect(source).toContain('jsonResponse(result)')
  })

  it('returns controlled method and seed errors without logging secrets or payloads', () => {
    expect(source).toContain("errorResponse(405, 'method_not_allowed', 'only POST is supported')")
    expect(source).toContain("errorResponse(500, 'visual_concept_seed_failed', 'visual concept seed failed')")
    expect(source).not.toContain('console.log')
    expect(source).not.toContain('console.error')
    expect(source).not.toContain('error.message')
  })
})
