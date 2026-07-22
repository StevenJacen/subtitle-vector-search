import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  assertWorkbenchFixtureMode,
  createWorkbenchFixtureRuntime,
  createWorkbenchFixtureTaskService,
} from '../src/workbench/fixture-runtime.js'
import { createWorkbenchHttpServer, listenWorkbenchServer } from '../src/workbench/http-server.js'
import type { SubtitleSyncSnapshot } from '../src/workbench/subtitle-sync.js'

const SESSION_TOKEN = 'fixture-session-token-with-enough-entropy'

describe('workbench fixture mode', () => {
  it('is disabled by default and can only be enabled in the test environment', () => {
    expect(assertWorkbenchFixtureMode({})).toBe(false)
    expect(assertWorkbenchFixtureMode({ WORKBENCH_FIXTURE_MODE: '1', NODE_ENV: 'test' })).toBe(true)
    expect(() => assertWorkbenchFixtureMode({
      WORKBENCH_FIXTURE_MODE: '1',
      NODE_ENV: 'production',
    })).toThrow('workbench fixture mode requires NODE_ENV=test')
  })

  it.each([5, 10])('creates a %i-scene task with eight candidates per scene', async sceneCount => {
    const service = createWorkbenchFixtureTaskService({ productionDelayMs: 0 })
    const task = await service.create({ theme: '穿过黑暗迎向黎明', aspectRatio: '9:16', sceneCount })

    expect(task.stage).toBe('review')
    expect(task.passage.cues).toHaveLength(sceneCount)
    expect(task.scenes).toHaveLength(sceneCount)
    expect(task.scenes.every(scene => scene.candidates.length === 8)).toBe(true)
    expect(task.scenes.every(scene => scene.recommended?.resourceId === scene.candidates[0].resourceId)).toBe(true)
  })

  it('appends a deduplicated page and requires an explicit second click to confirm', async () => {
    const service = createWorkbenchFixtureTaskService({ productionDelayMs: 0 })
    const created = await service.create({ theme: '继续前进', aspectRatio: '16:9', sceneCount: 5 })
    const expanded = await service.loadMore(created.taskId, 0)

    expect(expanded.scenes[0].candidates).toHaveLength(16)
    expect(new Set(expanded.scenes[0].candidates.map(candidate => candidate.resourceId)).size).toBe(16)

    const candidate = expanded.scenes[0].candidates[3]
    const selected = await service.select(created.taskId, 0, candidate, false)
    expect(selected.scenes[0].selected).toEqual({ runId: candidate.runId, resourceId: candidate.resourceId })
    expect(selected.scenes[0].confirmed).toBeNull()

    const confirmed = await service.select(created.taskId, 0, candidate, true)
    expect(confirmed.scenes[0].confirmed).toEqual({ runId: candidate.runId, resourceId: candidate.resourceId })
  })

  it('publishes fixed production stages and completes with a silent output', async () => {
    vi.useFakeTimers()
    try {
      const service = createWorkbenchFixtureTaskService({ productionDelayMs: 5 })
      let task = await service.create({ theme: '时间与希望', aspectRatio: '16:9', sceneCount: 5 })
      for (const scene of task.scenes) {
        const candidate = scene.candidates[0]
        await service.select(task.taskId, scene.index, candidate, false)
        task = await service.select(task.taskId, scene.index, candidate, true)
      }
      const stages: string[] = []
      const unsubscribe = service.events.subscribe(task.taskId, event => stages.push(event.stage))

      await service.produce(task.taskId)
      await vi.runAllTimersAsync()
      unsubscribe()

      const completed = await service.get(task.taskId)
      expect(stages).toEqual([
        'starting', 'preflight', 'downloading', 'probing', 'rendering', 'validating', 'completing', 'completed',
      ])
      expect(completed.stage).toBe('completed')
      expect(completed.output).toMatchObject({
        endpoint: `/api/tasks/${task.taskId}/final`,
        basename: 'final.mp4',
        audioCodec: null,
        videoCodec: 'h264',
        pixelFormat: 'yuv420p',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('exposes a retryable fixture failure and resumes it to completion', async () => {
    vi.useFakeTimers()
    try {
      const service = createWorkbenchFixtureTaskService({ productionDelayMs: 5 })
      let task = await service.create({ theme: '失败恢复测试', aspectRatio: '9:16', sceneCount: 5 })
      for (const scene of task.scenes) {
        const candidate = scene.candidates[0]
        await service.select(task.taskId, scene.index, candidate, false)
        task = await service.select(task.taskId, scene.index, candidate, true)
      }

      await service.produce(task.taskId)
      await vi.runAllTimersAsync()
      expect(await service.get(task.taskId)).toMatchObject({
        stage: 'failed',
        failure: { code: 'fixture_render_interrupted', retryable: true },
      })

      await service.resume(task.taskId)
      await vi.runAllTimersAsync()
      expect(await service.get(task.taskId)).toMatchObject({ stage: 'completed', failure: undefined })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an exact-result task on the selected movie and track around the anchor midpoint', async () => {
    const service = createWorkbenchFixtureTaskService({ productionDelayMs: 0 })
    const task = await service.create({
      theme: 'Hope is a good thing, maybe the best of things.',
      aspectRatio: '16:9',
      sceneCount: 5,
      sourceAnchor: { trackId: 4_101, firstCueIndex: 812, lastCueIndex: 814 },
    })

    expect(task.passage.movie).toEqual({ id: 1, title: 'The Shawshank Redemption', releaseYear: 1994 })
    expect(task.passage.trackId).toBe(4_101)
    expect(task.passage.cues.map(cue => cue.cueIndex)).toEqual([811, 812, 813, 814, 815])
    expect(task.passage.cues.every(cue => cue.trackId === 4_101)).toBe(true)
    expect(task.passage.cues).toContainEqual(expect.objectContaining({ cueIndex: 813 }))
  })
})

describe('subtitle fixture HTTP runtime', () => {
  type ServerOptions = Parameters<typeof createWorkbenchHttpServer>[0]
  type FixtureWithSubtitles = Awaited<ReturnType<typeof createWorkbenchFixtureRuntime>> & {
    subtitleLibrary: NonNullable<ServerOptions['subtitleLibrary']>
    subtitleSync: NonNullable<ServerOptions['subtitleSync']>
  }

  let root: string
  let origin: string
  let fixture: FixtureWithSubtitles
  let server: ReturnType<typeof createWorkbenchHttpServer>

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'subtitle-workbench-fixture-'))
    fixture = await createWorkbenchFixtureRuntime(root) as FixtureWithSubtitles
    server = createWorkbenchHttpServer({
      taskService: fixture.taskService,
      subtitleLibrary: fixture.subtitleLibrary,
      subtitleSync: fixture.subtitleSync,
      health: fixture.health,
      previewRegistry: fixture.previews,
      resolveFinalPath: fixture.resolveFinalPath,
      sessionToken: SESSION_TOKEN,
      heartbeatMs: 20,
    })
    origin = (await listenWorkbenchServer(server, { port: 0 })).url
  }, 30_000)

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  })

  it('serves positive counts plus ranked English and normalized Chinese searches', async () => {
    const summary = await fetch(`${origin}/api/subtitles/summary`)
    const english = await post('/api/subtitles/search', { query: 'hope is a good thing', limit: 10 })
    const chinese = await post('/api/subtitles/search', { query: '\u5e0c\u671b\u4e0e\u81ea\u7531', limit: 10 })

    expect(summary.status).toBe(200)
    expect(await summary.json()).toEqual({ readyTracks: 4, readyMovies: 3 })
    expect(english.status).toBe(200)
    const englishBody = await english.json() as {
      originalQuery: string
      normalizedQuery: string
      warning: string | null
      results: Array<Record<string, unknown>>
    }
    expect(englishBody).toMatchObject({
      originalQuery: 'hope is a good thing',
      normalizedQuery: 'hope is a good thing',
      warning: null,
    })
    expect(englishBody.results).toHaveLength(3)
    expect(englishBody.results[0]).toMatchObject({
      movie: { id: 1, title: 'The Shawshank Redemption', releaseYear: 1994 },
      trackId: 4_101,
      chunkIndex: 27,
      startMs: 372_000,
      endMs: 380_400,
      timestamp: '00:06:12.000 --> 00:06:20.400',
      semanticRank: 1,
      fullTextRank: 2,
      cues: [
        { index: 812, startMs: 372_000, endMs: 374_800 },
        { index: 813, startMs: 374_800, endMs: 377_600 },
        { index: 814, startMs: 377_600, endMs: 380_400 },
      ],
    })
    expect(chinese.status).toBe(200)
    expect(await chinese.json()).toMatchObject({
      originalQuery: '\u5e0c\u671b\u4e0e\u81ea\u7531',
      normalizedQuery: 'hope and freedom',
      warning: null,
    })
  })

  it('delivers automatic progress and replays snapshots before reaching quota', async () => {
    const started = await post('/api/subtitles/sync', { mode: 'automatic' })
    expect(started.status).toBe(202)
    expect(await started.json()).toMatchObject({ mode: 'automatic', status: 'running' })

    await waitForSnapshot(snapshot => snapshot.status === 'running' && snapshot.attempted >= 1)
    const controller = new AbortController()
    const events = await fetch(`${origin}/api/subtitles/sync/events`, {
      headers: { 'last-event-id': '1' },
      signal: controller.signal,
    })
    const reader = events.body!.getReader()
    const replay = new TextDecoder().decode((await reader.read()).value)
    controller.abort()

    expect(events.headers.get('content-type')).toContain('text/event-stream')
    expect(replay).toContain('id: 2')
    expect(replay).toContain('event: progress')
    expect(replay).toContain('The Matrix')
    await expect.poll(async () => (await snapshot()).status).toBe('quota_reached')
    expect(await snapshot()).toMatchObject({
      status: 'quota_reached', attempted: 2, succeeded: 1, failed: 0,
      message: 'Provider quota reached; rerun later',
    })
  })

  it('validates manual metadata and completes one deterministic import', async () => {
    const invalid = await post('/api/subtitles/sync', {
      mode: 'manual', movie: { imdbId: 'the-matrix', title: '', releaseYear: 1800 },
    })
    expect(invalid.status).toBe(400)

    const started = await post('/api/subtitles/sync', {
      mode: 'manual',
      movie: { imdbId: 'tt0133093', title: 'The Matrix', releaseYear: 1999 },
    })
    expect(started.status).toBe(202)
    await expect.poll(async () => (await snapshot()).status).toBe('completed')
    expect(await snapshot()).toMatchObject({
      mode: 'manual', status: 'completed', attempted: 1, succeeded: 1, failed: 0,
      message: 'Synchronization completed',
    })
  })

  it('cooperatively stops an active automatic fixture job', async () => {
    const started = await post('/api/subtitles/sync', { mode: 'automatic' })
    expect(started.status).toBe(202)
    await waitForSnapshot(value => value.status === 'running' && value.attempted >= 1)

    const stopping = await post('/api/subtitles/sync/stop', {})
    expect(stopping.status).toBe(202)
    expect(await stopping.json()).toMatchObject({ status: 'running' })
    await expect.poll(async () => (await snapshot()).status).toBe('stopped')
    expect(await snapshot()).toMatchObject({ status: 'stopped', message: 'Stopped by operator' })
  })

  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-workbench-session': SESSION_TOKEN,
      },
      body: JSON.stringify(body),
    })
  }

  async function snapshot(): Promise<SubtitleSyncSnapshot> {
    return fetch(`${origin}/api/subtitles/sync`).then(response => response.json()) as Promise<SubtitleSyncSnapshot>
  }

  async function waitForSnapshot(predicate: (value: SubtitleSyncSnapshot) => boolean): Promise<void> {
    await expect.poll(async () => predicate(await snapshot())).toBe(true)
  }
})
