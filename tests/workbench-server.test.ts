import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLazyPreviewResolver,
  parseWorkbenchServerConfiguration,
  requestSubtitlePassage,
  runWorkbenchServer,
} from '../src/workbench/server.js'
import * as workbenchServer from '../src/workbench/server.js'
import { PreviewRegistry } from '../src/workbench/vecteezy-candidates.js'

const environment = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
  SUBTITLE_PERSONAL_TOKEN: 'personal-token',
  VECTEEZY_ACCOUNT: '161976',
  VECTEEZY_API_KEY: 'vecteezy-key',
  AI_INFERENCE_API_HOST: 'http://54.67.73.171',
  OLLAMA_MODEL: 'qwen3:30b',
  WORKBENCH_PORT: '4317',
  WORKBENCH_ARTIFACT_ROOT: 'artifacts',
}

describe('workbench server configuration', () => {
  it('parses the production environment with conservative local defaults', () => {
    expect(parseWorkbenchServerConfiguration(environment)).toEqual({
      supabaseUrl: 'https://project.supabase.co',
      supabasePublishableKey: 'publishable-key',
      personalToken: 'personal-token',
      vecteezyAccount: '161976',
      vecteezyApiKey: 'vecteezy-key',
      ollamaEndpoint: new URL('http://54.67.73.171'),
      ollamaModel: 'qwen3:30b',
      artifactRoot: 'artifacts',
      fontPath: 'C:\\Windows\\Fonts\\msyh.ttc',
      port: 4317,
    })
  })

  it.each([
    ['missing token', { ...environment, SUBTITLE_PERSONAL_TOKEN: '' }],
    ['invalid Supabase URL', { ...environment, SUPABASE_URL: 'file:///private' }],
    ['invalid account', { ...environment, VECTEEZY_ACCOUNT: 'account' }],
    ['invalid Ollama URL', { ...environment, AI_INFERENCE_API_HOST: 'file:///private' }],
    ['invalid port', { ...environment, WORKBENCH_PORT: '70000' }],
  ])('rejects %s without echoing configuration values', (_name, input) => {
    expect(() => parseWorkbenchServerConfiguration(input)).toThrow('invalid workbench configuration')
  })

  it('starts the full HTTP server in test-only fixture mode without provider credentials', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'workbench-fixture-'))
    const started = await runWorkbenchServer({
      NODE_ENV: 'test',
      WORKBENCH_FIXTURE_MODE: '1',
      WORKBENCH_PORT: '0',
      WORKBENCH_ARTIFACT_ROOT: artifactRoot,
    })
    try {
      const response = await fetch(`${started.url}/api/health`)
      await expect(response.json()).resolves.toMatchObject({ status: 'ok' })
    } finally {
      await new Promise<void>((resolve, reject) => started.server.close(error => error === undefined ? resolve() : reject(error)))
      await rm(artifactRoot, { recursive: true, force: true })
    }
  }, 30_000)

  it('rejects fixture mode outside NODE_ENV=test before reading real credentials', async () => {
    await expect(runWorkbenchServer({
      NODE_ENV: 'production',
      WORKBENCH_FIXTURE_MODE: '1',
    })).rejects.toThrow('workbench fixture mode requires NODE_ENV=test')
  })
})

describe('workbench request digests', () => {
  it('canonicalizes source anchors without changing theme-only digest input', () => {
    const requestDigest = (workbenchServer as typeof workbenchServer & {
      requestDigest?: (input: {
        theme: string
        aspectRatio: '9:16' | '16:9'
        sceneCount: number
        sourceAnchor?: { trackId: number; firstCueIndex: number; lastCueIndex: number }
      }) => string
    }).requestDigest
    expect(requestDigest).toBeTypeOf('function')

    const input = { theme: ' hope ', aspectRatio: '16:9' as const, sceneCount: 5 }
    const first = requestDigest!({
      ...input,
      sourceAnchor: { trackId: 12, firstCueIndex: 40, lastCueIndex: 47 },
    })
    const reordered = requestDigest!({
      ...input,
      sourceAnchor: { lastCueIndex: 47, trackId: 12, firstCueIndex: 40 },
    })

    expect(first).toBe(reordered)
    expect(requestDigest!(input)).toBe(createHash('sha256').update(JSON.stringify({
      version: 2,
      theme: 'hope',
      aspectRatio: '16:9',
      sceneCount: 5,
    })).digest('hex'))
  })
})

describe('subtitle passage client', () => {
  it('posts an exact source anchor only when one is selected', async () => {
    const fetcher = vi.fn(async () => Response.json({ passage: passage() }))

    await requestSubtitlePassage({
      supabaseUrl: environment.SUPABASE_URL,
      publishableKey: environment.SUPABASE_PUBLISHABLE_KEY,
      personalToken: environment.SUBTITLE_PERSONAL_TOKEN,
      theme: 'hope after confinement',
      sceneCount: 5,
      sourceAnchor: { trackId: 12, firstCueIndex: 40, lastCueIndex: 47 },
      fetcher,
    })

    expect(fetcher).toHaveBeenCalledWith(
      'https://project.supabase.co/functions/v1/subtitle-passages',
      expect.objectContaining({
        body: JSON.stringify({
          theme: 'hope after confinement',
          sceneCount: 5,
          sourceAnchor: { trackId: 12, firstCueIndex: 40, lastCueIndex: 47 },
        }),
      }),
    )
  })

  it('posts the exact theme/count and returns a validated continuous passage', async () => {
    const fetcher = vi.fn(async () => Response.json({ passage: passage() }))

    const result = await requestSubtitlePassage({
      supabaseUrl: environment.SUPABASE_URL,
      publishableKey: environment.SUPABASE_PUBLISHABLE_KEY,
      personalToken: environment.SUBTITLE_PERSONAL_TOKEN,
      theme: 'hope after confinement',
      sceneCount: 5,
      fetcher,
    })

    expect(result.cues).toHaveLength(5)
    expect(result.totalDurationMs).toBe(15_000)
    expect(fetcher).toHaveBeenCalledWith(
      'https://project.supabase.co/functions/v1/subtitle-passages',
      expect.objectContaining({
        method: 'POST',
        headers: {
          apikey: 'publishable-key',
          'x-subtitle-token': 'personal-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ theme: 'hope after confinement', sceneCount: 5 }),
      }),
    )
  })

  it('rejects malformed or non-continuous provider data with a controlled error', async () => {
    const invalid = passage()
    invalid.cues[2].cueIndex = 99
    const fetcher = vi.fn(async () => Response.json({
      passage: invalid,
      providerUrl: 'https://private.example',
    }))

    await expect(requestSubtitlePassage({
      supabaseUrl: environment.SUPABASE_URL,
      publishableKey: environment.SUPABASE_PUBLISHABLE_KEY,
      personalToken: environment.SUBTITLE_PERSONAL_TOKEN,
      theme: 'hope',
      sceneCount: 5,
      fetcher,
    })).rejects.toThrow('subtitle passage request failed')
  })
})

describe('durable preview recovery', () => {
  it('rehydrates one opaque preview lazily and caches the provider detail result', async () => {
    const registry = new PreviewRegistry()
    const previewId = '40000000-0000-4000-8000-000000000001'
    const findResourceId = vi.fn(async () => 42)
    const loadPreviewUrl = vi.fn(async () => 'https://cdn.vecteezy.com/recovered.mp4')
    const resolver = createLazyPreviewResolver({ registry, findResourceId, loadPreviewUrl })

    await expect(resolver.resolve(previewId)).resolves.toBe('https://cdn.vecteezy.com/recovered.mp4')
    await expect(resolver.resolve(previewId)).resolves.toBe('https://cdn.vecteezy.com/recovered.mp4')

    expect(findResourceId).toHaveBeenCalledOnce()
    expect(loadPreviewUrl).toHaveBeenCalledOnce()
  })
})

function passage() {
  return {
    movie: { id: 1, title: 'Classic', releaseYear: 1994 },
    trackId: 7,
    startCueIndex: 20,
    endCueIndex: 24,
    totalDurationMs: 15_000,
    cues: Array.from({ length: 5 }, (_, index) => ({
      trackId: 7,
      cueIndex: 20 + index,
      startMs: index * 3_000,
      endMs: (index + 1) * 3_000,
      timestamp: `00:00:${String(index * 3).padStart(2, '0')}.000 --> 00:00:${String((index + 1) * 3).padStart(2, '0')}.000`,
      text: `Cue ${index + 1}`,
    })),
  }
}
