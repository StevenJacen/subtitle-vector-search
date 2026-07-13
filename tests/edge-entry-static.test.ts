import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as ts from 'typescript/unstable/ast'
import { describe, expect, it } from 'vitest'

const entryPath = resolve(process.cwd(), 'supabase/functions/ingest-subtitles/index.ts')
const entrySource = readFileSync(entryPath, 'utf8')

describe('ingest Edge entry static coverage', () => {
  it('retains the pinned Edge imports and can be tokenized by TypeScript', () => {
    expect(entrySource).toContain("import 'jsr:@supabase/functions-js/edge-runtime.d.ts'")
    expect(entrySource).toContain("from 'npm:@supabase/supabase-js@2.110.2'")

    const scanner = ts.createScanner(false, ts.LanguageVariant.Standard, entrySource)
    const tokens: ts.SyntaxKind[] = []
    for (let token = scanner.scan(), scanned = 0; token !== ts.SyntaxKind.EndOfFile && scanned < 10_000; token = scanner.scan(), scanned += 1) {
      tokens.push(token)
    }

    expect(tokens.length).toBeLessThan(10_000)
    expect(tokens).not.toContain(ts.SyntaxKind.Unknown)
  })

  it('never reads properties directly from an unknown RPC error', () => {
    expect(entrySource).not.toMatch(/result\.error\?\./)
    expect(entrySource).toContain('databaseErrorCode(result.error)')
  })

  it('releases only the current token claims when batch inference or completion fails', () => {
    expect(entrySource).toContain("client.rpc('release_subtitle_chunk_claims'")
    expect(entrySource).toContain('p_claim_token: claimToken')
    expect(entrySource).toContain("'ingestion_transient_failure'")
  })
})
