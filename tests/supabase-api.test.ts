import { describe, expect, it, vi } from 'vitest'
import type { Cue, SubtitleChunk } from '../src/domain.js'
import { SubtitleApi, SubtitleApiError, SubtitleApiTransportError } from '../src/supabase-api.js'

const config = {
  supabaseUrl: 'https://project.supabase.co/',
  publishableKey: 'publishable-key',
  personalToken: 'personal-token',
}

const startInput = {
  movie: { title: 'Example Film', imdbId: 'tt0111161' },
  track: { languageCode: 'en', source: 'manual', sourceSha256: 'abc123', rightsStatus: 'personal_research' as const },
}

const cues: Cue[] = [{ index: 0, startMs: 1000, endMs: 2000, text: 'Keep going.' }]
const chunks: SubtitleChunk[] = [{
  index: 0,
  startMs: 1000,
  endMs: 2000,
  firstCueIndex: 0,
  lastCueIndex: 0,
  text: 'Keep going.',
}]

describe('SubtitleApi', () => {
  it('starts an import with the configured Edge URL and personal authentication', async () => {
    const fetchFn = vi.fn().mockResolvedValue(Response.json({
      movieId: 7,
      trackId: 11,
      existingCueCount: 0,
      existingChunkCount: 0,
    }))
    const api = new SubtitleApi({ ...config, fetchFn })

    await expect(api.startImport({
      movie: { title: 'Example Film', releaseYear: 1994, imdbId: 'tt0111161' },
      track: {
        languageCode: 'en',
        source: 'opensubtitles',
        sourceRef: 'opensubtitles:42',
        sourceFileName: 'example.srt',
        sourceSha256: 'abc123',
        rightsStatus: 'personal_research',
      },
    })).resolves.toEqual({ movieId: 7, trackId: 11, existingCueCount: 0, existingChunkCount: 0 })

    expect(fetchFn).toHaveBeenCalledWith(
      'https://project.supabase.co/functions/v1/ingest-subtitles',
      expect.objectContaining({
        method: 'POST',
        headers: {
          apikey: 'publishable-key',
          'x-subtitle-token': 'personal-token',
          'content-type': 'application/json',
        },
      }),
    )
    expect(JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      action: 'start',
      movie: { title: 'Example Film', releaseYear: 1994, imdbId: 'tt0111161' },
      track: {
        languageCode: 'en',
        source: 'opensubtitles',
        sourceRef: 'opensubtitles:42',
        sourceFileName: 'example.srt',
        sourceSha256: 'abc123',
        rightsStatus: 'personal_research',
      },
    })
  })

  it('sends cues and chunks in an import batch action', async () => {
    const fetchFn = vi.fn().mockResolvedValue(Response.json({ acceptedCueCount: 1, acceptedChunkCount: 1 }))
    const api = new SubtitleApi({ ...config, fetchFn })

    await expect(api.sendBatch({ trackId: 11, cues, chunks })).resolves.toEqual({
      acceptedCueCount: 1,
      acceptedChunkCount: 1,
    })

    expect(fetchFn).toHaveBeenCalledWith(
      'https://project.supabase.co/functions/v1/ingest-subtitles',
      expect.objectContaining({
        body: JSON.stringify({ action: 'batch', trackId: 11, cues, chunks }),
      }),
    )
  })

  it('defaults import provenance rights to personal research', async () => {
    const fetchFn = vi.fn().mockResolvedValue(Response.json({
      movieId: 7,
      trackId: 11,
      existingCueCount: 0,
      existingChunkCount: 0,
    }))
    const api = new SubtitleApi({ ...config, fetchFn })

    await api.startImport({
      movie: { title: 'Example Film', imdbId: 'tt0111161' },
      track: { languageCode: 'en', source: 'manual', sourceSha256: 'abc123', rightsStatus: undefined },
    })

    expect(fetchFn).toHaveBeenCalledWith(
      'https://project.supabase.co/functions/v1/ingest-subtitles',
      expect.anything(),
    )
    expect(JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      action: 'start',
      movie: { title: 'Example Film', imdbId: 'tt0111161' },
      track: {
        languageCode: 'en',
        source: 'manual',
        sourceSha256: 'abc123',
        rightsStatus: 'personal_research',
      },
    })
  })

  it('finalizes an import through the finalize action', async () => {
    const fetchFn = vi.fn().mockResolvedValue(Response.json({ trackId: 11, status: 'ready' }))
    const api = new SubtitleApi({ ...config, fetchFn })

    await expect(api.finalizeImport(11)).resolves.toEqual({ trackId: 11, status: 'ready' })

    expect(fetchFn).toHaveBeenCalledWith(
      'https://project.supabase.co/functions/v1/ingest-subtitles',
      expect.objectContaining({ body: JSON.stringify({ action: 'finalize', trackId: 11 }) }),
    )
  })

  it('marks an import failed through the authenticated fail action', async () => {
    const fetchFn = vi.fn().mockResolvedValue(Response.json({ trackId: 11, status: 'failed' }))
    const api = new SubtitleApi({ ...config, fetchFn })

    await expect(api.failImport(11)).resolves.toEqual({ trackId: 11, status: 'failed' })
    expect(fetchFn).toHaveBeenCalledWith(
      'https://project.supabase.co/functions/v1/ingest-subtitles',
      expect.objectContaining({ body: JSON.stringify({ action: 'fail', trackId: 11 }) }),
    )
  })

  it('retries network failures and transient HTTP responses at most three attempts', async () => {
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'busy', message: 'busy' } }), { status: 503 }))
      .mockResolvedValueOnce(Response.json({ movieId: 7, trackId: 11, existingCueCount: 0, existingChunkCount: 0 }))
    const delayFn = vi.fn().mockResolvedValue(undefined)
    const api = new SubtitleApi({ ...config, fetchFn, delayFn })

    await expect(api.startImport(startInput)).resolves.toMatchObject({ trackId: 11 })
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(delayFn).toHaveBeenNthCalledWith(1, 250)
    expect(delayFn).toHaveBeenNthCalledWith(2, 500)
  })

  it('retries HTTP 429 but never retries other 4xx responses', async () => {
    const retryingFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }), { status: 429 }))
      .mockResolvedValueOnce(Response.json({ acceptedCueCount: 1, acceptedChunkCount: 1 }))
    const delayFn = vi.fn().mockResolvedValue(undefined)
    const retryingApi = new SubtitleApi({ ...config, fetchFn: retryingFetch, delayFn })

    await expect(retryingApi.sendBatch({ trackId: 11, cues, chunks })).resolves.toMatchObject({ acceptedChunkCount: 1 })
    expect(retryingFetch).toHaveBeenCalledTimes(2)

    const rejectingFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'invalid_request', message: 'invalid request' },
    }), { status: 400 }))
    const rejectingApi = new SubtitleApi({ ...config, fetchFn: rejectingFetch, delayFn })
    await expect(rejectingApi.startImport(startInput)).rejects.toMatchObject({ status: 400 })
    expect(rejectingFetch).toHaveBeenCalledTimes(1)
  })

  it('stops after three transient attempts', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'unavailable', message: 'unavailable' },
    }), { status: 500 }))
    const delayFn = vi.fn().mockResolvedValue(undefined)
    const api = new SubtitleApi({ ...config, fetchFn, delayFn })

    await expect(api.startImport(startInput)).rejects.toMatchObject({ status: 500 })
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(delayFn).toHaveBeenCalledTimes(2)
  })

  it('wraps exhausted fetch failures as transport errors and retries them', async () => {
    const networkFailure = new TypeError('network unavailable')
    const fetchFn = vi.fn().mockRejectedValue(networkFailure)
    const delayFn = vi.fn().mockResolvedValue(undefined)
    const api = new SubtitleApi({ ...config, fetchFn, delayFn })

    const error = await api.startImport(startInput).catch(error => error)

    expect(error).toBeInstanceOf(SubtitleApiTransportError)
    expect((error as Error).cause).toBe(networkFailure)
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(delayFn).toHaveBeenCalledTimes(2)
  })

  it('does not retry serialization failures that occur before fetch', async () => {
    const serializationFailure = new Error('cannot serialize input')
    const fetchFn = vi.fn()
    const delayFn = vi.fn().mockResolvedValue(undefined)
    const api = new SubtitleApi({ ...config, fetchFn, delayFn })
    const invalidInput = {
      movie: {
        title: { toJSON: () => { throw serializationFailure } },
        imdbId: 'tt0111161',
      },
      track: startInput.track,
    } as unknown as typeof startInput

    await expect(api.startImport(invalidInput)).rejects.toBe(serializationFailure)
    expect(fetchFn).not.toHaveBeenCalled()
    expect(delayFn).not.toHaveBeenCalled()
  })

  it('searches through the search Edge Function with optional movie filtering', async () => {
    const fetchFn = vi.fn().mockResolvedValue(Response.json({ results: [] }))
    const api = new SubtitleApi({ ...config, fetchFn })

    await expect(api.search({ query: 'hope during hard times', limit: 10, movieId: 7 })).resolves.toEqual([])

    expect(fetchFn).toHaveBeenCalledWith(
      'https://project.supabase.co/functions/v1/search-subtitles',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query: 'hope during hard times', limit: 10, movieId: 7 }),
      }),
    )
  })

  it('rejects a malformed successful search response as a validation error', async () => {
    const fetchFn = vi.fn().mockResolvedValue(Response.json({ results: { unexpected: true } }))
    const api = new SubtitleApi({ ...config, fetchFn })

    await expect(api.search({ query: 'quiet determination' })).rejects.toMatchObject({
      status: 502,
      code: 'invalid_response',
      message: 'subtitle search returned an invalid response',
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('preserves the structured English-only search validation error', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'english_query_required', message: 'English queries are required' },
    }), { status: 400 }))
    const api = new SubtitleApi({ ...config, fetchFn })

    await expect(api.search({ query: '希望' })).rejects.toMatchObject({
      status: 400,
      code: 'english_query_required',
      message: 'English queries are required',
    })
  })

  it('decodes structured JSON errors from Edge Functions', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'invalid_request', message: 'title is required' },
    }), { status: 400 }))
    const api = new SubtitleApi({ ...config, fetchFn })

    const error = await api.finalizeImport(11).catch(error => error)

    expect(error).toBeInstanceOf(SubtitleApiError)
    expect(error).toMatchObject({ status: 400, code: 'invalid_request', message: 'title is required' })
  })
})
