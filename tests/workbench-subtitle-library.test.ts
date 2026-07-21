import { describe, expect, it, vi } from 'vitest'
import { SubtitleLibraryClient, normalizeSearchQuery } from '../src/workbench/subtitle-library.js'

const hybridResult = {
  similarity: 0.91,
  rrfScore: 0.052,
  semanticRank: 1,
  fullTextRank: 2,
  movie: { id: 4, title: 'Facing Fear', releaseYear: 1999 },
  trackId: 7,
  chunkIndex: 3,
  startMs: 1_000,
  endMs: 2_000,
  timestamp: '00:00:01.000 --> 00:00:02.000',
  text: 'Face your fear.',
  cues: [{ index: 9, startMs: 1_000, endMs: 2_000, text: 'Face your fear.' }],
}

describe('subtitle library client', () => {
  it('normalizes Han input and validates ranked hybrid results', async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://ollama.test/api/generate')
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual' })
      expect(JSON.parse(init?.body as string)).toMatchObject({
        model: 'gemma4:12b',
        stream: false,
        format: 'json',
        think: false,
      })
      return new Response(JSON.stringify({ response: JSON.stringify({ query: 'facing fear' }) }))
    })
    const hybridFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://supabase.test/functions/v1/hybrid-subtitle-search')
      expect(init).toMatchObject({
        method: 'POST',
        headers: expect.objectContaining({ apikey: 'publishable-key', 'x-subtitle-token': 'personal-token' }),
      })
      expect(JSON.parse(init?.body as string)).toEqual({ query: 'facing fear', limit: 20 })
      return new Response(JSON.stringify({ results: [hybridResult] }))
    })
    const client = new SubtitleLibraryClient({
      supabaseUrl: 'https://supabase.test',
      publishableKey: 'publishable-key',
      personalToken: 'personal-token',
      ollamaEndpoint: new URL('http://ollama.test'),
      ollamaModel: 'gemma4:12b',
      fetchFn: async (url, init) => String(url).startsWith('http://ollama.test')
        ? await fetchFn(url, init)
        : await hybridFetch(url, init),
    })

    const result = await client.search({ query: '面对恐惧', limit: 20 })

    expect(result).toMatchObject({
      originalQuery: '面对恐惧',
      normalizedQuery: 'facing fear',
      warning: null,
      results: [{ trackId: 7, semanticRank: 1, fullTextRank: 2 }],
    })
  })

  it('falls back to the original Han query when normalization fails', async () => {
    const result = await normalizeSearchQuery({
      query: '面对恐惧',
      translate: async () => { throw new Error('provider unavailable') },
    })

    expect(result).toEqual({ query: '面对恐惧', warning: 'query_normalization_failed' })
  })

  it('rejects malformed hybrid results before returning them', async () => {
    const client = new SubtitleLibraryClient({
      supabaseUrl: 'https://supabase.test',
      publishableKey: 'publishable-key',
      personalToken: 'personal-token',
      ollamaEndpoint: new URL('http://ollama.test'),
      ollamaModel: 'gemma4:12b',
      fetchFn: async () => new Response(JSON.stringify({
        results: [{ ...hybridResult, semanticRank: 0 }],
      })),
    })

    await expect(client.search({ query: 'face fear', limit: 20 }))
      .rejects.toThrow('subtitle library search returned an invalid response')
  })

  it('rejects more hybrid results than the requested limit', async () => {
    const client = new SubtitleLibraryClient({
      supabaseUrl: 'https://supabase.test',
      publishableKey: 'publishable-key',
      personalToken: 'personal-token',
      ollamaEndpoint: new URL('http://ollama.test'),
      ollamaModel: 'gemma4:12b',
      fetchFn: async () => new Response(JSON.stringify({ results: [hybridResult, hybridResult] })),
    })

    await expect(client.search({ query: 'face fear', limit: 1 }))
      .rejects.toThrow('subtitle library search returned an invalid response')
  })

  it('returns only ready-library aggregate counts', async () => {
    const client = new SubtitleLibraryClient({
      supabaseUrl: 'https://supabase.test',
      publishableKey: 'publishable-key',
      personalToken: 'personal-token',
      ollamaEndpoint: new URL('http://ollama.test'),
      ollamaModel: 'gemma4:12b',
      fetchFn: async (url, init) => {
        expect(String(url)).toBe('https://supabase.test/functions/v1/subtitle-library')
        expect(init).toMatchObject({ method: 'POST' })
        return new Response(JSON.stringify({ readyTracks: 12, readyMovies: 5 }))
      },
    })

    await expect(client.summary()).resolves.toEqual({ readyTracks: 12, readyMovies: 5 })
  })
})
