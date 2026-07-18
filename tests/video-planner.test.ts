import { describe, expect, it, vi } from 'vitest'
import {
  seedVisualConcepts,
  VISUAL_CONCEPT_SEEDS,
} from '../supabase/functions/_shared/visual-concept-seeds.js'
import {
  buildPlannerPrompt,
  createPlannerTransport,
  fallbackVisualPlan,
  planVisualSearch,
} from '../supabase/functions/_shared/video-planner.js'
import { VideoAssetError } from '../supabase/functions/_shared/video-assets.js'

const validPlan = {
  visualIntent: {
    subject: 'a solitary adult',
    action: 'opening curtains',
    setting: 'a quiet room',
    mood: 'renewed hope',
    lighting: 'soft sunrise',
    shot: 'medium cinematic shot',
  },
  queries: [
    { kind: 'literal' as const, term: 'solitary person opening curtains sunrise quiet room video' },
    { kind: 'action' as const, term: 'person stepping into morning light hopeful fresh start video' },
    { kind: 'metaphor' as const, term: 'green sprout emerging after rain sunrise renewal macro video' },
  ],
}

const plannerInput = {
  sourceText: 'A person finds hope after isolation.',
  contextText: 'The room has been quiet for a long time.',
  theme: 'renewal',
  movieTitle: 'Synthetic Night Walk',
  forbiddenTerms: ['Synthetic Night Walk'],
}

function environment(values: Record<string, string | undefined>) {
  return { get: (name: string) => values[name] }
}

describe('visual planner prompt and repair', () => {
  it('specifies the complete constrained JSON contract and supplied context', () => {
    const prompt = buildPlannerPrompt(plannerInput)

    for (const key of ['subject', 'action', 'setting', 'mood', 'lighting', 'shot']) {
      expect(prompt).toContain(key)
    }
    for (const kind of ['literal', 'action', 'metaphor']) {
      expect(prompt).toContain(kind)
    }
    expect(prompt).toMatch(/JSON only/i)
    expect(prompt).toMatch(/English-only search terms/i)
    expect(prompt).toMatch(/no dialogue, movie, or brand references/i)
    expect(prompt).toMatch(/do not invent protected traits/i)
    for (const supplied of [
      plannerInput.sourceText,
      plannerInput.contextText,
      plannerInput.theme,
      plannerInput.movieTitle,
    ]) {
      expect(prompt).toContain(supplied)
    }
  })

  it('accepts a valid first response without repair or fallback', async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify(validPlan))
    const fallback = vi.fn()

    await expect(planVisualSearch(plannerInput, { generate, fallback })).resolves.toEqual({
      plan: validPlan,
      fallbackUsed: false,
    })
    expect(generate).toHaveBeenCalledTimes(1)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('repairs malformed JSON exactly once', async () => {
    const outputs = ['not-json', JSON.stringify(validPlan)]
    const generate = vi.fn().mockImplementation(async () => outputs.shift() as string)

    const result = await planVisualSearch(plannerInput, { generate, fallback: vi.fn() })

    expect(result).toEqual({ plan: validPlan, fallbackUsed: false })
    expect(generate).toHaveBeenCalledTimes(2)
    expect(generate.mock.calls[1][0]).toContain('invalid JSON')
  })

  it('grounds a non-JSON repair in the complete original contract and context', async () => {
    const malformedOutput = 'not-json'
    const outputs = [malformedOutput, JSON.stringify(validPlan)]
    const generate = vi.fn().mockImplementation(async () => outputs.shift() as string)

    await planVisualSearch(plannerInput, { generate, fallback: vi.fn() })

    expect(generate).toHaveBeenCalledTimes(2)
    const repairPrompt = generate.mock.calls[1][0]
    expect(repairPrompt).toContain(buildPlannerPrompt(plannerInput))
    for (const groundedValue of [
      plannerInput.sourceText,
      plannerInput.contextText,
      plannerInput.theme,
      plannerInput.movieTitle,
    ]) {
      expect(repairPrompt).toContain(groundedValue)
    }
    expect(repairPrompt).toContain('Validation errors: invalid JSON')
    expect(repairPrompt).toContain(`Malformed structured object: ${JSON.stringify(malformedOutput)}`)
  })

  it('repairs duplicate query kinds with validation details and the malformed object', async () => {
    const duplicatePlan = {
      ...validPlan,
      queries: [validPlan.queries[0], validPlan.queries[0], validPlan.queries[2]],
    }
    const outputs = [JSON.stringify(duplicatePlan), JSON.stringify(validPlan)]
    const generate = vi.fn().mockImplementation(async () => outputs.shift() as string)

    const result = await planVisualSearch(plannerInput, { generate, fallback: vi.fn() })

    expect(result.plan).toEqual(validPlan)
    expect(generate).toHaveBeenCalledTimes(2)
    expect(generate.mock.calls[1][0]).toContain('duplicate query kind')
    expect(generate.mock.calls[1][0]).toContain(JSON.stringify(duplicatePlan))
  })

  it('treats the supplied movie title as forbidden validation context', async () => {
    const titlePlan = {
      ...validPlan,
      queries: [
        { kind: 'literal' as const, term: 'Synthetic Night Walk sunrise scene video' },
        validPlan.queries[1],
        validPlan.queries[2],
      ],
    }
    const outputs = [JSON.stringify(titlePlan), JSON.stringify(validPlan)]
    const generate = vi.fn().mockImplementation(async () => outputs.shift() as string)

    const result = await planVisualSearch(
      { ...plannerInput, forbiddenTerms: [] },
      { generate, fallback: vi.fn() },
    )

    expect(result.plan).toEqual(validPlan)
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('falls back once after two invalid responses', async () => {
    const outputs = ['not-json', JSON.stringify({ ...validPlan, queries: [] })]
    const generate = vi.fn().mockImplementation(async () => outputs.shift() as string)
    const fallback = vi.fn().mockResolvedValue(validPlan)

    await expect(planVisualSearch(plannerInput, { generate, fallback })).resolves.toEqual({
      plan: validPlan,
      fallbackUsed: true,
    })
    expect(generate).toHaveBeenCalledTimes(2)
    expect(fallback).toHaveBeenCalledOnce()
    expect(fallback).toHaveBeenCalledWith(plannerInput)
  })

  it('turns planner and fallback failures into one controlled error', async () => {
    const secretSource = 'SECRET SOURCE BODY'
    const generate = vi.fn().mockRejectedValue(new Error(`provider leaked ${secretSource}`))
    const fallback = vi.fn().mockRejectedValue(new Error(`fallback leaked ${secretSource}`))

    const promise = planVisualSearch(
      { sourceText: secretSource, forbiddenTerms: [] },
      { generate, fallback },
    )

    await expect(promise).rejects.toMatchObject({
      status: 502,
      code: 'planner_unavailable',
      message: 'visual planner unavailable',
    })
    await expect(promise).rejects.not.toThrow(secretSource)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(fallback).toHaveBeenCalledOnce()
  })
})

describe('planner transports', () => {
  it('requires the explicit Supabase AI security confirmation before creating a session', () => {
    const sessionFactory = vi.fn()

    expect(() => createPlannerTransport(
      environment({ VIDEO_PLANNER_TRANSPORT: 'supabase-ai' }),
      { sessionFactory },
    )).toThrow('visual planner is not configured')
    expect(sessionFactory).not.toHaveBeenCalled()
  })

  it('uses gemma4:12b through Supabase AI with the 20-second model timeout', async () => {
    const run = vi.fn().mockResolvedValue('structured output')
    const sessionFactory = vi.fn().mockReturnValue({ run })
    const generate = createPlannerTransport(environment({
      VIDEO_PLANNER_TRANSPORT: 'supabase-ai',
      OLLAMA_GATEWAY_SECURITY_CONFIRMED: 'true',
    }), { sessionFactory })

    await expect(generate('planner prompt')).resolves.toBe('structured output')
    expect(sessionFactory).toHaveBeenCalledWith('gemma4:12b')
    expect(run).toHaveBeenCalledWith('planner prompt', { stream: false, timeout: 20 })
  })

  it('requires a bearer token for direct Ollama without exposing configuration', () => {
    const host = 'https://private-host.example'

    expect(() => createPlannerTransport(environment({
      VIDEO_PLANNER_TRANSPORT: 'ollama-http',
      AI_INFERENCE_API_HOST: host,
      OLLAMA_MODEL: 'gemma4:12b',
    }))).toThrow('visual planner is not configured')
    try {
      createPlannerTransport(environment({
        VIDEO_PLANNER_TRANSPORT: 'ollama-http',
        AI_INFERENCE_API_HOST: host,
        OLLAMA_MODEL: 'gemma4:12b',
      }))
    } catch (error) {
      expect(String(error)).not.toContain(host)
    }
  })

  it('calls authenticated Ollama JSON chat with bounded output and a 20-second timeout', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: { content: 'structured output' },
    }), { status: 200 }))
    const timeoutSignal = vi.fn().mockReturnValue(new AbortController().signal)
    const generate = createPlannerTransport(environment({
      VIDEO_PLANNER_TRANSPORT: 'ollama-http',
      AI_INFERENCE_API_HOST: 'https://ollama.example/base',
      OLLAMA_AUTH_TOKEN: 'bearer-secret',
      OLLAMA_MODEL: 'gemma4:12b',
    }), { fetch, timeoutSignal })

    await expect(generate('planner prompt')).resolves.toBe('structured output')
    expect(timeoutSignal).toHaveBeenCalledWith(20_000)
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://ollama.example/api/chat')
    expect(init.headers).toEqual({
      authorization: 'Bearer bearer-secret',
      'content-type': 'application/json',
    })
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'gemma4:12b',
      messages: [{ role: 'user', content: 'planner prompt' }],
      stream: false,
      format: 'json',
      options: { temperature: 0.2, num_predict: 600 },
    })
  })

  it('sanitizes prompt and provider response details from transport errors', async () => {
    const prompt = 'SECRET PROMPT BODY'
    const providerBody = 'SECRET PROVIDER BODY'
    const fetch = vi.fn().mockResolvedValue(new Response(providerBody, { status: 503 }))
    const generate = createPlannerTransport(environment({
      VIDEO_PLANNER_TRANSPORT: 'ollama-http',
      AI_INFERENCE_API_HOST: 'https://ollama.example',
      OLLAMA_AUTH_TOKEN: 'bearer-secret',
      OLLAMA_MODEL: 'gemma4:12b',
    }), { fetch })

    const promise = generate(prompt)
    await expect(promise).rejects.toThrow('visual planner unavailable')
    await expect(promise).rejects.not.toThrow(prompt)
    await expect(promise).rejects.not.toThrow(providerBody)
    await expect(promise).rejects.not.toThrow('bearer-secret')
  })
})

describe('visual concept fallback and seeding', () => {
  it('defines exactly 24 unique concrete concepts', () => {
    expect(VISUAL_CONCEPT_SEEDS).toHaveLength(24)
    expect(new Set(VISUAL_CONCEPT_SEEDS.map(seed => seed.conceptKey)).size).toBe(24)
    expect(VISUAL_CONCEPT_SEEDS.map(seed => seed.conceptKey)).toEqual([
      'isolation', 'reunion', 'escape', 'loss', 'hope', 'conflict', 'discovery', 'time',
      'memory', 'transformation', 'love', 'courage', 'fear', 'freedom', 'regret',
      'resilience', 'betrayal', 'friendship', 'ambition', 'sacrifice', 'justice',
      'grief', 'wonder', 'homecoming',
    ])
    for (const seed of VISUAL_CONCEPT_SEEDS) {
      expect(seed.description).toMatch(/^[\x20-\x7E]+\.$/)
      for (const query of [seed.literalQuery, seed.actionQuery, seed.metaphorQuery]) {
        expect(query.trim().length).toBeGreaterThan(0)
        expect(query.length).toBeLessThan(180)
      }
    }
  })

  it('rejects non-English fallback input before inference or RPC work', async () => {
    const session = { run: vi.fn() }
    const client = { rpc: vi.fn() }

    await expect(fallbackVisualPlan(
      { sourceText: 'A person finds 希望.', theme: 'renewal', forbiddenTerms: [] },
      { session, client },
    )).rejects.toThrow('visual planner unavailable')
    expect(session.run).not.toHaveBeenCalled()
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it.each([
    'An English source with\na control character.',
    '12345 !!!',
  ])('rejects non-printable or letterless fallback input before inference: %s', async sourceText => {
    const session = { run: vi.fn() }
    const client = { rpc: vi.fn() }

    await expect(fallbackVisualPlan(
      { sourceText, forbiddenTerms: [] },
      { session, client },
    )).rejects.toThrow('visual planner unavailable')
    expect(session.run).not.toHaveBeenCalled()
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('embeds English source plus theme and maps the nearest concept RPC row', async () => {
    const embedding = Array.from({ length: 384 }, (_, index) => index / 384)
    const session = { run: vi.fn().mockResolvedValue(embedding) }
    const conceptRow = {
      concept_key: 'hope',
      description: 'A difficult moment opens toward a credible better future.',
      literal_query: 'person opening curtains warm sunrise hopeful interior video',
      action_query: 'person walking from shadow into sunlight renewed purpose video',
      metaphor_query: 'seedling emerging after rain in morning light macro video',
      similarity: 0.91,
    }
    const client = { rpc: vi.fn().mockResolvedValue({ data: [conceptRow], error: null }) }

    const plan = await fallbackVisualPlan(
      { sourceText: 'A person finds hope after isolation.', theme: 'renewal', forbiddenTerms: [] },
      { session, client },
    )

    expect(session.run).toHaveBeenCalledWith(
      'A person finds hope after isolation.\nTheme: renewal',
      { mean_pool: true, normalize: true },
    )
    expect(client.rpc).toHaveBeenCalledWith('match_visual_concept', {
      query_embedding: embedding,
    })
    expect(plan.queries).toEqual([
      { kind: 'literal', term: conceptRow.literal_query },
      { kind: 'action', term: conceptRow.action_query },
      { kind: 'metaphor', term: conceptRow.metaphor_query },
    ])
  })

  it('validates fallback embeddings before the concept RPC', async () => {
    const client = { rpc: vi.fn() }

    await expect(fallbackVisualPlan(
      { sourceText: 'An English source.', forbiddenTerms: [] },
      { session: { run: vi.fn().mockResolvedValue([1, 2, 3]) }, client },
    )).rejects.toThrow('visual planner unavailable')
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('embeds seed descriptions with at most four workers and upserts Task 3 rows', async () => {
    let active = 0
    let maximumActive = 0
    const session = {
      run: vi.fn().mockImplementation(async () => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise(resolve => setTimeout(resolve, 1))
        active -= 1
        return Array(384).fill(0.25)
      }),
    }
    const client = { rpc: vi.fn().mockResolvedValue({ data: 24, error: null }) }

    await expect(seedVisualConcepts({ session, client })).resolves.toEqual({
      seeded: 24,
      model: 'gte-small',
    })
    expect(maximumActive).toBeLessThanOrEqual(4)
    expect(session.run).toHaveBeenCalledTimes(24)
    expect(session.run).toHaveBeenCalledWith(
      VISUAL_CONCEPT_SEEDS[0].description,
      { mean_pool: true, normalize: true },
    )
    expect(client.rpc).toHaveBeenCalledOnce()
    const [rpcName, rpcArguments] = client.rpc.mock.calls[0]
    expect(rpcName).toBe('upsert_visual_concepts')
    expect(rpcArguments.p_concepts).toHaveLength(24)
    expect(rpcArguments.p_concepts[0]).toEqual({
      concept_key: VISUAL_CONCEPT_SEEDS[0].conceptKey,
      description: VISUAL_CONCEPT_SEEDS[0].description,
      literal_query: VISUAL_CONCEPT_SEEDS[0].literalQuery,
      action_query: VISUAL_CONCEPT_SEEDS[0].actionQuery,
      metaphor_query: VISUAL_CONCEPT_SEEDS[0].metaphorQuery,
      embedding: Array(384).fill(0.25),
      enabled: true,
    })
  })
})
