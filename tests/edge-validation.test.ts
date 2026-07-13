import { describe, expect, it, vi } from 'vitest'
import { authenticateRequest } from '../supabase/functions/_shared/auth.js'
import { parseIngestRequest } from '../supabase/functions/_shared/contracts.js'
import { embedChunks } from '../supabase/functions/_shared/embeddings.js'
import { FinalizeIntegrityError, finalizeTrackIntegrity } from '../supabase/functions/_shared/finalize-integrity.js'
import { handleAuthenticatedRequest } from '../supabase/functions/_shared/http.js'

const environment = {
  get(name: string): string | undefined {
    return name === 'SUBTITLE_PERSONAL_TOKEN' ? 'correct-token' : undefined
  },
}

function request(token?: string): Request {
  return new Request('https://example.test/ingest-subtitles', {
    headers: token === undefined ? {} : { 'x-subtitle-token': token },
  })
}

function batch(overrides: Record<string, unknown> = {}) {
  return {
    action: 'batch',
    trackId: 11,
    cues: [{ index: 0, startMs: 0, endMs: 900, text: '' }],
    chunks: [{
      index: 0,
      startMs: 0,
      endMs: 900,
      firstCueIndex: 0,
      lastCueIndex: 0,
      text: 'spoken dialogue',
    }],
    ...overrides,
  }
}

describe('Edge ingestion authentication', () => {
  it('returns 401 for missing or wrong personal tokens before invoking the authorized callback', async () => {
    const callback = vi.fn().mockResolvedValue(Response.json({ ok: true }))

    for (const incomingToken of [undefined, 'wrong-token']) {
      const response = await handleAuthenticatedRequest(request(incomingToken), environment, callback)

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({
        error: { code: 'unauthorized', message: 'invalid subtitle token' },
      })
    }

    expect(callback).not.toHaveBeenCalled()
  })

  it('accepts equal tokens and invokes the callback only after authentication', async () => {
    const callback = vi.fn().mockResolvedValue(Response.json({ ok: true }))

    await expect(authenticateRequest(request('correct-token'), environment)).resolves.toEqual({ ok: true })
    await expect(handleAuthenticatedRequest(request('correct-token'), environment, callback)).resolves.toBeInstanceOf(Response)

    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('rejects a missing configured personal token', async () => {
    const missingEnvironment = { get: () => undefined }

    await expect(authenticateRequest(request('correct-token'), missingEnvironment)).resolves.toEqual({
      ok: false,
      error: { code: 'unauthorized', message: 'invalid subtitle token' },
    })
  })
})

describe('Edge ingestion contracts', () => {
  it('accepts empty cue text while preserving valid timestamp and cue boundaries', () => {
    expect(parseIngestRequest(batch())).toEqual(batch())
  })

  it.each([
    ['backward cue timestamp', batch({ cues: [{ index: 0, startMs: 900, endMs: 900, text: '' }] })],
    ['negative cue timestamp', batch({ cues: [{ index: 0, startMs: -1, endMs: 900, text: '' }] })],
    ['invalid chunk cue range', batch({ chunks: [{ index: 0, startMs: 0, endMs: 900, firstCueIndex: 1, lastCueIndex: 0, text: 'spoken dialogue' }] })],
    ['more than 100 cues', batch({ cues: Array.from({ length: 101 }, (_, index) => ({ index, startMs: index * 1_000, endMs: index * 1_000 + 900, text: '' })) })],
    ['more than 8 chunks', batch({ chunks: Array.from({ length: 9 }, (_, index) => ({ index, startMs: index * 1_000, endMs: index * 1_000 + 900, firstCueIndex: index, lastCueIndex: index, text: 'spoken dialogue' })) })],
  ])('rejects %s', (_description, input) => {
    expect(() => parseIngestRequest(input)).toThrow('invalid request')
  })
})

describe('Edge embedding validation', () => {
  it('rejects model outputs that are not finite 384-dimensional vectors', async () => {
    const model = vi.fn().mockResolvedValue([...
      Array.from({ length: 383 }, () => 0),
      Number.NaN,
    ])

    await expect(embedChunks([batch().chunks[0]], model)).rejects.toThrow('invalid embedding')
    expect(model).toHaveBeenCalledWith('spoken dialogue')
  })

  it('returns an accepted 384-dimensional embedding with its original chunk', async () => {
    const chunk = batch().chunks[0]
    const embedding = Array.from({ length: 384 }, () => 0.25)

    await expect(embedChunks([chunk], async () => embedding)).resolves.toEqual([{ chunk, embedding }])
  })
})

describe('Edge finalize integrity', () => {
  it('rejects a chunk whose final cue is missing', () => {
    expect(() => finalizeTrackIntegrity([0], [{ firstCueIndex: 0, lastCueIndex: 1 }]))
      .toThrow(FinalizeIntegrityError)
  })

  it('rejects a chunk whose cue range has an interior gap', () => {
    expect(() => finalizeTrackIntegrity([0, 2], [{ firstCueIndex: 0, lastCueIndex: 2 }]))
      .toThrow(FinalizeIntegrityError)
  })

  it('accepts complete chunk references after cues arrive in later batches', () => {
    expect(() => finalizeTrackIntegrity(
      [0, 1, 2, 3],
      [{ firstCueIndex: 0, lastCueIndex: 1 }, { firstCueIndex: 2, lastCueIndex: 3 }],
    )).not.toThrow()
  })

  it('does not mark a track ready when a persisted chunk references missing cues', () => {
    const markReady = vi.fn().mockResolvedValue(undefined)
    let error: unknown

    try {
      finalizeTrackIntegrity([0], [{ firstCueIndex: 100, lastCueIndex: 101 }], markReady)
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({
      code: 'incomplete_cue_ranges',
      message: 'subtitle track has incomplete cue ranges',
    })

    expect(markReady).not.toHaveBeenCalled()
  })
})
