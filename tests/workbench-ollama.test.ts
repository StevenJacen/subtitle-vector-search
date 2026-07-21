import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPassagePrompt,
  OllamaPlanError,
  parsePassagePlan,
  planPassageWithOllama,
} from '../src/workbench/ollama.js'
import type { PassageCue } from '../src/workbench/passage-selection.js'

const cues: PassageCue[] = [
  { trackId: 4, cueIndex: 20, startMs: 0, endMs: 2_000, text: 'Hope is a good thing.' },
  { trackId: 4, cueIndex: 21, startMs: 2_000, endMs: 5_000, text: 'Keep moving toward the light.' },
]

const context = {
  movieTitle: 'Hidden Path',
  characterNames: ['Morgan'],
}

const validOutput = [
  {
    index: 0,
    captionZh: '希望是美好的事物。',
    visualConcept: 'sunrise over an open road',
    mood: 'quiet optimism',
    action: 'walking toward daylight',
    setting: 'open countryside',
    lighting: 'soft morning light',
  },
  {
    index: 1,
    captionZh: '继续向着光明前行。',
    visualConcept: 'traveler crossing a quiet bridge',
  },
]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Ollama passage-plan parser', () => {
  it('accepts the exact count and order and returns trimmed planned cues without model English', () => {
    const result = parsePassagePlan(validOutput.map(item => ({
      ...item,
      captionZh: ` ${item.captionZh} `,
      visualConcept: ` ${item.visualConcept} `,
    })), cues, context)

    expect(result).toEqual([
      {
        captionZh: '希望是美好的事物。',
        visualConcept: 'sunrise over an open road',
        mood: 'quiet optimism',
        action: 'walking toward daylight',
        setting: 'open countryside',
        lighting: 'soft morning light',
      },
      {
        captionZh: '继续向着光明前行。',
        visualConcept: 'traveler crossing a quiet bridge',
      },
    ])
    expect(result[0]).not.toHaveProperty('text')
    expect(result[0]).not.toHaveProperty('index')
  })

  it.each([
    ['too few items', validOutput.slice(0, 1)],
    ['too many items', [...validOutput, { ...validOutput[1], index: 2 }]],
    ['out-of-order items', [validOutput[1], validOutput[0]]],
    ['duplicate indices', [{ ...validOutput[0] }, { ...validOutput[1], index: 0 }]],
  ])('rejects %s', (_label, value) => {
    expectPlanError(() => parsePassagePlan(value, cues, context), 'invalid_output')
  })

  it.each([
    ['an extra English key', [{ ...validOutput[0], english: cues[0].text }, validOutput[1]]],
    ['an unknown key', [{ ...validOutput[0], camera: 'wide shot' }, validOutput[1]]],
    ['a missing required key', [{ index: 0, captionZh: validOutput[0].captionZh }, validOutput[1]]],
    ['a non-string optional facet', [{ ...validOutput[0], mood: 5 }, validOutput[1]]],
    ['an undefined optional facet', [{ ...validOutput[0], mood: undefined }, validOutput[1]]],
  ])('rejects %s', (_label, value) => {
    expectPlanError(() => parsePassagePlan(value, cues, context), 'invalid_output')
  })

  it.each([
    ['blank Chinese', [{ ...validOutput[0], captionZh: '   ' }, validOutput[1]]],
    ['non-Chinese translation', [{ ...validOutput[0], captionZh: 'hopeful morning' }, validOutput[1]]],
    ['non-English concept', [{ ...validOutput[0], visualConcept: '清晨道路' }, validOutput[1]]],
    ['control characters', [{ ...validOutput[0], mood: 'quiet\noptimism' }, validOutput[1]]],
  ])('rejects %s', (_label, value) => {
    expectPlanError(() => parsePassagePlan(value, cues, context), 'invalid_output')
  })

  it.each([
    ['the movie title', 'wide view of the Hidden Path at dawn'],
    ['a supplied character name', 'Morgan walking through a station'],
    ['a provider name', 'Vecteezy footage of an open road'],
    ['an HTTP URL', 'sunrise footage from http://media.example/video'],
    ['a provider URL', 'footage from media.vecteezy.com/video'],
    ['the full exact English cue', `sunrise while someone says ${cues[0].text}`],
  ])('rejects %s in a visual field', (_label, visualConcept) => {
    expectPlanError(() => parsePassagePlan([
      { ...validOutput[0], visualConcept },
      validOutput[1],
    ], cues, context), 'forbidden_content')
  })

  it('rejects the full Chinese translation in optional facets', () => {
    expectPlanError(() => parsePassagePlan([
      { ...validOutput[0], mood: `quiet ${validOutput[0].captionZh}` },
      validOutput[1],
    ], cues, context), 'forbidden_content')
  })

  it('builds an indexed JSON-only prompt without asking Ollama to return English', () => {
    const prompt = buildPassagePrompt(cues)

    expect(prompt).toContain(JSON.stringify(cues.map((cue, index) => ({ index, text: cue.text }))))
    expect(prompt).toContain('Return only a JSON array')
    expect(prompt).toContain('captionZh')
    expect(prompt).toContain('visualConcept')
    expect(prompt).toMatch(/do not return (?:or repeat )?the English/i)
  })
})

describe('Ollama passage-plan transport', () => {
  it('posts the required non-streaming JSON request to the configured origin', async () => {
    const fetchFn = vi.fn().mockResolvedValue(responseEnvelope(validOutput))

    await expect(planPassageWithOllama({
      endpoint: new URL('http://54.67.73.171/custom/path'),
      model: 'gemma4:12b',
      cues,
      ...context,
      fetchFn,
    })).resolves.toHaveLength(2)

    expect(fetchFn).toHaveBeenCalledOnce()
    const [url, init] = fetchFn.mock.calls[0] as [URL, RequestInit]
    expect(url.toString()).toBe('http://54.67.73.171/api/generate')
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      redirect: 'manual',
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'gemma4:12b',
      prompt: buildPassagePrompt(cues),
      stream: false,
      format: 'json',
    })
    expect(init.headers).not.toHaveProperty('authorization')
  })

  it('accepts one surrounding JSON markdown fence in the Ollama response string', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      response: `\`\`\`json\n${JSON.stringify(validOutput)}\n\`\`\``,
    })))

    await expect(planPassageWithOllama({
      endpoint: new URL('http://ollama.test'), model: 'gemma4:12b', cues, ...context, fetchFn,
    })).resolves.toHaveLength(2)
  })

  it('does not require optional movie or character context for transport planning', async () => {
    const fetchFn = vi.fn().mockResolvedValue(responseEnvelope(validOutput))

    await expect(planPassageWithOllama({
      endpoint: new URL('http://ollama.test'), model: 'gemma4:12b', cues, fetchFn,
    })).resolves.toHaveLength(2)
  })

  it.each([
    ['malformed envelope', JSON.stringify({ message: 'not an Ollama generate response' })],
    ['malformed model JSON', JSON.stringify({ response: '{not json}' })],
    ['provider error envelope', JSON.stringify({ error: 'SECRET PROVIDER FAILURE' })],
  ])('rejects %s with a controlled error', async (_label, body) => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(body))
    await expectRejectedCode(planPassageWithOllama({
      endpoint: new URL('http://ollama.test'), model: 'gemma4:12b', cues, ...context, fetchFn,
    }), 'invalid_response')
  })

  it('uses a 60-second abort signal and maps an abort to timeout', async () => {
    const controller = new AbortController()
    controller.abort()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    const fetchFn = vi.fn().mockRejectedValue(new DOMException('SECRET ABORT', 'AbortError'))

    await expectRejectedCode(planPassageWithOllama({
      endpoint: new URL('http://ollama.test'), model: 'gemma4:12b', cues, ...context, fetchFn,
    }), 'timeout')
    expect(timeout).toHaveBeenCalledWith(60_000)
  })

  it('maps an abort while consuming the response body to timeout', async () => {
    const controller = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    const body = new ReadableStream<Uint8Array>({
      pull() {
        controller.abort()
        throw new DOMException('SECRET BODY ABORT', 'AbortError')
      },
    })
    const fetchFn = vi.fn().mockResolvedValue(new Response(body))

    await expectRejectedCode(planPassageWithOllama({
      endpoint: new URL('http://ollama.test'), model: 'gemma4:12b', cues, ...context, fetchFn,
    }), 'timeout')
  })

  it('rejects a cross-origin redirect without following it', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, {
      status: 307,
      headers: { location: 'http://attacker.test/api/generate' },
    }))

    await expectRejectedCode(planPassageWithOllama({
      endpoint: new URL('http://ollama.test'), model: 'gemma4:12b', cues, ...context, fetchFn,
    }), 'redirect_rejected')
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('follows a same-origin redirect manually while preserving the request contract', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 307,
        headers: { location: '/api/generate/' },
      }))
      .mockResolvedValueOnce(responseEnvelope(validOutput))

    await expect(planPassageWithOllama({
      endpoint: new URL('http://ollama.test'), model: 'gemma4:12b', cues, ...context, fetchFn,
    })).resolves.toHaveLength(2)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect((fetchFn.mock.calls[1][0] as URL).toString()).toBe('http://ollama.test/api/generate/')
    expect(fetchFn.mock.calls[1][1]).toMatchObject({ method: 'POST', redirect: 'manual' })
  })

  it('rejects an oversized response body before parsing it', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('x'.repeat(300_000)))
    await expectRejectedCode(planPassageWithOllama({
      endpoint: new URL('http://ollama.test'), model: 'gemma4:12b', cues, ...context, fetchFn,
    }), 'response_too_large')
  })

  it('maps HTTP and network failures without exposing provider details', async () => {
    const endpoint = 'http://private-ollama.test/SECRET-ENDPOINT'
    const secrets = [endpoint, cues[0].text, 'SECRET PROVIDER BODY', 'SECRET NETWORK FAILURE']
    const httpFetch = vi.fn().mockResolvedValue(new Response('SECRET PROVIDER BODY', { status: 503 }))
    await expectSanitized(planPassageWithOllama({
      endpoint: new URL(endpoint), model: 'gemma4:12b', cues, ...context, fetchFn: httpFetch,
    }), 'provider_unavailable', secrets)

    const networkFetch = vi.fn().mockRejectedValue(new Error('SECRET NETWORK FAILURE'))
    await expectSanitized(planPassageWithOllama({
      endpoint: new URL(endpoint), model: 'gemma4:12b', cues, ...context, fetchFn: networkFetch,
    }), 'provider_unavailable', secrets)
  })

  it('redacts raw model output and dialogue from validation failures', async () => {
    const rawPayload = `RAW SECRET ${cues[0].text}`
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ response: rawPayload })))

    await expectSanitized(planPassageWithOllama({
      endpoint: new URL('http://ollama.test'), model: 'gemma4:12b', cues, ...context, fetchFn,
    }), 'invalid_response', [rawPayload, cues[0].text, 'http://ollama.test'])
  })
})

function responseEnvelope(output: unknown): Response {
  return new Response(JSON.stringify({ response: JSON.stringify(output) }))
}

function expectPlanError(operation: () => unknown, code: string): void {
  try {
    operation()
    throw new Error('expected operation to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(OllamaPlanError)
    expect((error as OllamaPlanError).code).toBe(code)
  }
}

async function expectRejectedCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
    throw new Error('expected promise to reject')
  } catch (error) {
    expect(error).toBeInstanceOf(OllamaPlanError)
    expect((error as OllamaPlanError).code).toBe(code)
  }
}

async function expectSanitized(
  promise: Promise<unknown>,
  code: string,
  forbidden: readonly string[],
): Promise<void> {
  try {
    await promise
    throw new Error('expected promise to reject')
  } catch (error) {
    expect(error).toBeInstanceOf(OllamaPlanError)
    expect((error as OllamaPlanError).code).toBe(code)
    const rendered = String(error)
    for (const value of forbidden) {
      expect(rendered).not.toContain(value)
    }
  }
}
