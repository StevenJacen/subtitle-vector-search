import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { request as httpRequest } from 'node:http'
import { createServer as createNodeServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchEventBus } from '../src/workbench/events.js'
import { SubtitleApiError } from '../src/supabase-api.js'
import { SubtitleSyncEventBus, type SubtitleSyncSnapshot } from '../src/workbench/subtitle-sync.js'
import {
  createWorkbenchHttpServer,
  listenWorkbenchServer,
  type WorkbenchHttpTaskService,
} from '../src/workbench/http-server.js'
import { WorkbenchTaskError, type WorkbenchTaskView } from '../src/workbench/task-service.js'

const TASK_ID = '10000000-0000-4000-8000-000000000001'
const PREVIEW_ID = '20000000-0000-4000-8000-000000000001'
const RUN_ID = '30000000-0000-4000-8000-000000000001'
const SESSION_TOKEN = 'test-session-token-with-enough-entropy'
const roots: string[] = []
const servers: Array<ReturnType<typeof createWorkbenchHttpServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function taskView(overrides: Partial<WorkbenchTaskView> = {}): WorkbenchTaskView {
  return {
    taskId: TASK_ID,
    theme: 'hope',
    aspectRatio: '16:9',
    width: 1920,
    height: 1080,
    sceneCount: 5,
    stage: 'review',
    passage: { movie: { id: 1, title: 'Classic', releaseYear: 1994 }, trackId: 7, startCueIndex: 2, endCueIndex: 6, totalDurationMs: 15_000, cues: [] },
    scenes: [],
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  }
}

function fakeTaskService(): WorkbenchHttpTaskService & { [key: string]: unknown } {
  return {
    events: new WorkbenchEventBus(),
    list: vi.fn(async () => [taskView()]),
    create: vi.fn(async input => taskView(input)),
    get: vi.fn(async () => taskView()),
    loadMore: vi.fn(async () => taskView()),
    select: vi.fn(async () => taskView()),
    produce: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
  }
}

async function start(overrides: Partial<Parameters<typeof createWorkbenchHttpServer>[0]> = {}) {
  const taskService = fakeTaskService()
  const server = createWorkbenchHttpServer({
    taskService,
    sessionToken: SESSION_TOKEN,
    health: async () => ({ status: 'ok', checks: [] }),
    previewRegistry: { resolve: () => undefined },
    resolveFinalPath: async () => null,
    lookupHost: async () => ['93.184.216.34'],
    ...overrides,
  })
  servers.push(server)
  const address = await listenWorkbenchServer(server, { port: 0 })
  return { server, taskService, origin: address.url }
}

function mutationHeaders(origin: string): Record<string, string> {
  return {
    origin,
    'content-type': 'application/json',
    'x-workbench-session': SESSION_TOKEN,
  }
}

function subtitleSearchResult() {
  return {
    originalQuery: 'hope',
    normalizedQuery: 'hope',
    warning: null,
    results: [{
      similarity: 0.91,
      rrfScore: 0.05,
      semanticRank: 1,
      fullTextRank: null,
      movie: { id: 7, title: 'Classic', releaseYear: 1994 },
      trackId: 12,
      chunkIndex: 3,
      startMs: 1_000,
      endMs: 2_000,
      timestamp: '00:00:01.000 --> 00:00:02.000',
      text: 'Hope is a good thing.',
      cues: [{ index: 4, startMs: 1_000, endMs: 2_000, text: 'Hope is a good thing.' }],
    }],
  }
}

function subtitleSyncSnapshot(overrides: Partial<SubtitleSyncSnapshot> = {}): SubtitleSyncSnapshot {
  return {
    jobId: null,
    mode: null,
    status: 'idle',
    currentMovie: null,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    message: 'Idle',
    startedAt: null,
    updatedAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  }
}

function fakeSubtitleServices() {
  const events = new SubtitleSyncEventBus()
  const subtitleLibrary = {
    search: vi.fn(async () => subtitleSearchResult()),
    summary: vi.fn(async () => ({ readyTracks: 12, readyMovies: 5 })),
  }
  const subtitleSync = {
    events,
    start: vi.fn(async () => subtitleSyncSnapshot({
      jobId: 'job-1', mode: 'automatic', status: 'running', message: 'Synchronizing subtitles', startedAt: '2026-07-21T00:00:00.000Z',
    })),
    stop: vi.fn(() => subtitleSyncSnapshot({
      jobId: 'job-1', mode: 'automatic', status: 'running', message: 'Synchronizing subtitles', startedAt: '2026-07-21T00:00:00.000Z',
    })),
    snapshot: vi.fn(() => subtitleSyncSnapshot()),
  }
  return { subtitleLibrary, subtitleSync }
}

describe('workbench HTTP security boundary', () => {
  it('binds only to loopback and injects the boot session without exposing it through health', async () => {
    const { server, origin } = await start()
    const address = server.address() as AddressInfo

    expect(address.address).toBe('127.0.0.1')
    const html = await fetch(`${origin}/`).then(response => response.text())
    expect(html).toContain(`<meta name="workbench-session" content="${SESSION_TOKEN}">`)
    const health = await fetch(`${origin}/api/health`).then(response => response.text())
    expect(health).not.toContain(SESSION_TOKEN)
  })

  it('uses the next loopback port when the requested port is already occupied', async () => {
    const blocker = createNodeServer()
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', resolve)
    })
    try {
      const occupied = (blocker.address() as AddressInfo).port
      const taskService = fakeTaskService()
      const server = createWorkbenchHttpServer({
        taskService,
        sessionToken: SESSION_TOKEN,
        health: async () => ({ status: 'ok', checks: [] }),
        previewRegistry: { resolve: () => undefined },
        resolveFinalPath: async () => null,
      })
      servers.push(server)

      const address = await listenWorkbenchServer(server, { port: occupied, maxPortAttempts: 2 })

      expect(address.port).toBe(occupied + 1)
      expect((server.address() as AddressInfo).address).toBe('127.0.0.1')
    } finally {
      await new Promise<void>(resolve => blocker.close(() => resolve()))
    }
  })

  it('serves a production frontend from the configured root without arbitrary file access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-static-'))
    roots.push(root)
    await writeFile(join(root, 'index.html'), '<!doctype html><html><head></head><body><script src="/assets/app.js"></script></body></html>')
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'assets', 'app.js'), 'globalThis.workbenchLoaded = true')
    const { origin } = await start({ staticRoot: root })

    const html = await fetch(`${origin}/`).then(response => response.text())
    const asset = await fetch(`${origin}/assets/app.js`)
    const traversal = await fetch(`${origin}/assets/%2e%2e/package.json`)

    expect(html).toContain(`content="${SESSION_TOKEN}"`)
    expect(asset.headers.get('content-type')).toContain('text/javascript')
    expect(await asset.text()).toContain('workbenchLoaded')
    expect(traversal.status).toBe(404)
  })

  it('delegates development module requests to an injected frontend middleware', async () => {
    const frontendMiddleware = vi.fn(async (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/javascript' })
      response.end('export const ready = true')
      return true
    })
    const { origin } = await start({
      renderHtml: async () => '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
      frontendMiddleware,
    })

    const html = await fetch(`${origin}/`).then(response => response.text())
    const module = await fetch(`${origin}/workbench/src/main.tsx?v=abc123`)

    expect(html).toContain(`content="${SESSION_TOKEN}"`)
    expect(await module.text()).toContain('ready')
    expect(frontendMiddleware).toHaveBeenCalledOnce()
  })

  it('rejects foreign hosts, cross-origin mutations, and missing session tokens', async () => {
    const { origin, taskService } = await start()
    const body = JSON.stringify({ theme: 'hope', aspectRatio: '16:9', sceneCount: 5 })

    const address = new URL(origin)
    const foreignHost = await rawStatus(Number(address.port), '/api/tasks', { host: 'attacker.example' })
    const foreignOrigin = await fetch(`${origin}/api/tasks`, {
      method: 'POST',
      headers: mutationHeaders('http://attacker.example'),
      body,
    })
    const missingToken = await fetch(`${origin}/api/tasks`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body,
    })

    expect(foreignHost).toBe(403)
    expect(foreignOrigin.status).toBe(403)
    expect(missingToken.status).toBe(403)
    expect(taskService.create).not.toHaveBeenCalled()
  })

  it('rejects foreign-origin health probes and caches local readiness checks', async () => {
    const health = vi.fn(async () => ({ status: 'ok', checks: [] }))
    const { origin } = await start({ health, healthCacheMs: 30_000 })

    const foreign = await fetch(`${origin}/api/health`, { headers: { origin: 'http://attacker.example' } })
    const first = await fetch(`${origin}/api/health`)
    const second = await fetch(`${origin}/api/health`)

    expect(foreign.status).toBe(403)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(health).toHaveBeenCalledOnce()
  })

  it('accepts exact task payloads and rejects extra keys, wrong content types, and oversized bodies', async () => {
    const { origin, taskService } = await start()
    const valid = await fetch(`${origin}/api/tasks`, {
      method: 'POST',
      headers: mutationHeaders(origin),
      body: JSON.stringify({
        theme: 'hope',
        aspectRatio: '9:16',
        sceneCount: 6,
        sourceAnchor: { trackId: 12, firstCueIndex: 40, lastCueIndex: 47 },
      }),
    })
    const extra = await fetch(`${origin}/api/tasks`, {
      method: 'POST',
      headers: mutationHeaders(origin),
      body: JSON.stringify({ theme: 'hope', aspectRatio: '9:16', sceneCount: 6, url: 'https://example.com' }),
    })
    const wrongType = await fetch(`${origin}/api/tasks`, {
      method: 'POST',
      headers: { ...mutationHeaders(origin), 'content-type': 'text/plain' },
      body: '{}',
    })
    const oversized = await fetch(`${origin}/api/tasks`, {
      method: 'POST',
      headers: mutationHeaders(origin),
      body: JSON.stringify({ theme: 'x'.repeat(40_000), aspectRatio: '16:9', sceneCount: 5 }),
    })

    expect(valid.status).toBe(201)
    expect(extra.status).toBe(400)
    expect(wrongType.status).toBe(415)
    expect(oversized.status).toBe(413)
    expect(taskService.create).toHaveBeenCalledOnce()
    expect(taskService.create).toHaveBeenCalledWith({
      theme: 'hope',
      aspectRatio: '9:16',
      sceneCount: 6,
      sourceAnchor: { trackId: 12, firstCueIndex: 40, lastCueIndex: 47 },
    })
  })

  it('routes bounded scene actions and starts production asynchronously', async () => {
    let release!: () => void
    const producing = new Promise<void>(resolve => { release = resolve })
    const taskService = fakeTaskService()
    taskService.produce = vi.fn(() => producing)
    const started = await start({ taskService })
    const { origin } = started

    const selection = await fetch(`${origin}/api/tasks/${TASK_ID}/scenes/2/selection`, {
      method: 'PUT',
      headers: mutationHeaders(origin),
      body: JSON.stringify({ runId: RUN_ID, resourceId: 42, confirmed: true }),
    })
    const loadMore = await fetch(`${origin}/api/tasks/${TASK_ID}/scenes/10/candidates`, {
      method: 'POST',
      headers: mutationHeaders(origin),
      body: '{}',
    })
    const produce = await fetch(`${origin}/api/tasks/${TASK_ID}/produce`, {
      method: 'POST',
      headers: mutationHeaders(origin),
      body: '{}',
    })

    expect(selection.status).toBe(200)
    expect(taskService.select).toHaveBeenCalledWith(TASK_ID, 2, { runId: RUN_ID, resourceId: 42 }, true)
    expect(loadMore.status).toBe(400)
    expect(produce.status).toBe(202)
    release()
  })

  it('returns controlled errors and rejects unknown routes or methods', async () => {
    const taskService = fakeTaskService()
    taskService.get = vi.fn(async () => { throw new Error('C:\\private\\secret?token=value') })
    const { origin } = await start({ taskService })

    const failed = await fetch(`${origin}/api/tasks/${TASK_ID}`)
    const unknown = await fetch(`${origin}/api/not-real`)
    const method = await fetch(`${origin}/api/tasks`, { method: 'DELETE' })

    expect(failed.status).toBe(500)
    expect(await failed.text()).not.toMatch(/private|secret|token|C:\\/i)
    expect(unknown.status).toBe(404)
    expect(method.status).toBe(405)
  })

  it('never publishes upstream error messages and maps controlled task conflicts', async () => {
    const upstream = fakeTaskService()
    upstream.get = vi.fn(async () => {
      throw new SubtitleApiError('C:\\private\\secret?token=value', 502, 'provider_failed')
    })
    const first = await start({ taskService: upstream })
    const leaked = await fetch(`${first.origin}/api/tasks/${TASK_ID}`)

    const controlled = fakeTaskService()
    controlled.get = vi.fn(async () => {
      throw new WorkbenchTaskError('selection_required', 'Scene selection is required', true)
    })
    const second = await start({ taskService: controlled })
    const conflict = await fetch(`${second.origin}/api/tasks/${TASK_ID}`)

    expect(leaked.status).toBe(500)
    expect(await leaked.text()).not.toMatch(/private|secret|token|provider_failed/i)
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({
      error: { code: 'selection_required', message: 'Scene selection is required' },
    })
  })

  it('maps missing subtitle source anchors to a stable sanitized 404', async () => {
    const taskService = fakeTaskService()
    taskService.create = vi.fn(async () => {
      throw new WorkbenchTaskError(
        'source_anchor_not_found',
        'C:\\private\\subtitle-track.json?token=secret',
        false,
      )
    })
    const { origin } = await start({ taskService })

    const response = await fetch(`${origin}/api/tasks`, {
      method: 'POST',
      headers: mutationHeaders(origin),
      body: JSON.stringify({
        theme: 'hope',
        aspectRatio: '16:9',
        sceneCount: 5,
        sourceAnchor: { trackId: 4_101, firstCueIndex: 812, lastCueIndex: 814 },
      }),
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: 'source_anchor_not_found', message: 'Subtitle source anchor not found' },
    })
  })
})

describe('subtitle library workbench API', () => {
  it('keeps subtitle search protected, bounded, and provider-safe', async () => {
    const { subtitleLibrary, subtitleSync } = fakeSubtitleServices()
    const { origin } = await start({ subtitleLibrary, subtitleSync })

    const unauthorized = await fetch(`${origin}/api/subtitles/search`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'hope', limit: 20 }),
    })
    const valid = await fetch(`${origin}/api/subtitles/search`, {
      method: 'POST', headers: mutationHeaders(origin), body: JSON.stringify({ query: 'hope', limit: 20 }),
    })
    const invalid = await fetch(`${origin}/api/subtitles/search`, {
      method: 'POST', headers: mutationHeaders(origin), body: JSON.stringify({ query: 'hope', limit: 20, providerUrl: 'https://private.example' }),
    })
    const queried = await fetch(`${origin}/api/subtitles/search?query=hope`, { method: 'POST', headers: mutationHeaders(origin), body: '{}' })
    const wrongMethod = await fetch(`${origin}/api/subtitles/search`)
    subtitleLibrary.search.mockRejectedValueOnce(new Error('provider token=secret https://private.example/path'))
    const failed = await fetch(`${origin}/api/subtitles/search`, {
      method: 'POST', headers: mutationHeaders(origin), body: JSON.stringify({ query: 'hope', limit: 20 }),
    })

    expect(unauthorized.status).toBe(403)
    expect(valid.status).toBe(200)
    expect(await valid.json()).toEqual(subtitleSearchResult())
    expect(subtitleLibrary.search).toHaveBeenCalledWith({ query: 'hope', limit: 20 })
    expect(invalid.status).toBe(400)
    expect(queried.status).toBe(400)
    expect(wrongMethod.status).toBe(405)
    expect(failed.status).toBe(500)
    expect(await failed.text()).not.toMatch(/secret|private|provider|https/i)
  })

  it('exposes sanitized subtitle reads and controlled synchronization mutations', async () => {
    const { subtitleLibrary, subtitleSync } = fakeSubtitleServices()
    const { origin } = await start({ subtitleLibrary, subtitleSync })

    const summary = await fetch(`${origin}/api/subtitles/library`)
    const snapshot = await fetch(`${origin}/api/subtitles/sync`)
    const summaryMutation = await fetch(`${origin}/api/subtitles/library`, { method: 'POST', headers: mutationHeaders(origin), body: '{}' })
    const unauthorized = await fetch(`${origin}/api/subtitles/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'automatic' }) })
    const automatic = await fetch(`${origin}/api/subtitles/sync`, { method: 'POST', headers: mutationHeaders(origin), body: JSON.stringify({ mode: 'automatic' }) })
    const manualInvalid = await fetch(`${origin}/api/subtitles/sync`, { method: 'POST', headers: mutationHeaders(origin), body: JSON.stringify({ mode: 'manual', movie: { imdbId: 'not-imdb', title: '', releaseYear: 1700 } }) })
    const stop = await fetch(`${origin}/api/subtitles/sync/stop`, { method: 'POST', headers: mutationHeaders(origin), body: '{}' })
    subtitleSync.start.mockImplementationOnce(() => { throw new Error('subtitle_sync_already_running') })
    const conflict = await fetch(`${origin}/api/subtitles/sync`, { method: 'POST', headers: mutationHeaders(origin), body: JSON.stringify({ mode: 'automatic' }) })

    expect(await summary.json()).toEqual({ readyTracks: 12, readyMovies: 5 })
    expect(await snapshot.json()).toEqual(subtitleSyncSnapshot())
    expect(summaryMutation.status).toBe(405)
    expect(unauthorized.status).toBe(403)
    expect(automatic.status).toBe(202)
    expect(subtitleSync.start).toHaveBeenCalledWith({ mode: 'automatic' })
    expect(manualInvalid.status).toBe(400)
    expect(stop.status).toBe(202)
    expect(subtitleSync.stop).toHaveBeenCalledOnce()
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ error: { code: 'subtitle_sync_already_running', message: 'Subtitle synchronization is already running' } })
  })

  it('replays sanitized subtitle snapshots after Last-Event-ID with heartbeat cleanup', async () => {
    const { subtitleLibrary, subtitleSync } = fakeSubtitleServices()
    const unsubscribe = vi.spyOn(subtitleSync.events, 'subscribe')
    const { origin } = await start({ subtitleLibrary, subtitleSync, heartbeatMs: 20 })
    subtitleSync.events.publish(subtitleSyncSnapshot())
    subtitleSync.events.publish(subtitleSyncSnapshot({
      jobId: 'job-1', mode: 'manual', status: 'running', message: 'Importing subtitle', startedAt: '2026-07-21T00:00:00.000Z',
    }))
    const controller = new AbortController()
    const response = await fetch(`${origin}/api/subtitles/sync/events`, {
      headers: { 'last-event-id': '1' },
      signal: controller.signal,
    })
    const reader = response.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    const heartbeat = new TextDecoder().decode((await reader.read()).value)
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(first).toContain('id: 2')
    expect(first).toContain('event: progress')
    expect(first).toContain('"status":"running"')
    expect(first).not.toMatch(/secret|provider|https|[A-Z]:\\/i)
    expect(heartbeat).toContain(': heartbeat')
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})

function rawStatus(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, headers }, response => {
      response.resume()
      response.once('end', () => resolve(response.statusCode ?? 0))
    })
    request.once('error', reject)
    request.end()
  })
}

describe('workbench events and media', () => {
  it('replays SSE events after Last-Event-ID and disconnects cleanly', async () => {
    const taskService = fakeTaskService()
    taskService.events.publish(TASK_ID, 'planning', 'first')
    taskService.events.publish(TASK_ID, 'review', 'second')
    const { origin } = await start({ taskService, heartbeatMs: 20 })
    const controller = new AbortController()
    const response = await fetch(`${origin}/api/tasks/${TASK_ID}/events`, {
      headers: { 'last-event-id': '1' },
      signal: controller.signal,
    })
    const reader = response.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    controller.abort()

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(first).toContain('id: 2')
    expect(first).toContain('"message":"second"')
    expect(first).not.toContain('"message":"first"')
  })

  it('serves completed video with a single validated byte range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-http-'))
    roots.push(root)
    const finalPath = join(root, 'final.mp4')
    await writeFile(finalPath, Buffer.from('0123456789'))
    const { origin } = await start({ resolveFinalPath: async () => finalPath })

    const ranged = await fetch(`${origin}/api/tasks/${TASK_ID}/final`, { headers: { range: 'bytes=2-5' } })
    const clipped = await fetch(`${origin}/api/tasks/${TASK_ID}/final`, { headers: { range: 'bytes=8-20' } })
    const invalid = await fetch(`${origin}/api/tasks/${TASK_ID}/final`, { headers: { range: 'bytes=0-1,4-5' } })

    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await ranged.text()).toBe('2345')
    expect(clipped.status).toBe(206)
    expect(clipped.headers.get('content-range')).toBe('bytes 8-9/10')
    expect(await clipped.text()).toBe('89')
    expect(invalid.status).toBe(416)
    expect(invalid.headers.get('content-range')).toBe('bytes */10')
  })

  it('proxies only registered Vecteezy previews and revalidates every redirect DNS target', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://cdn.vecteezy.com/video.mp4' } }))
      .mockResolvedValueOnce(new Response('preview', { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '7' } }))
    const lookupHost = vi.fn(async (hostname: string) => hostname === 'cdn.vecteezy.com'
      ? ['93.184.216.35']
      : ['93.184.216.34'])
    const { origin } = await start({
      previewRegistry: { resolve: id => id === PREVIEW_ID ? 'https://www.vecteezy.com/preview' : undefined },
      fetcher,
      lookupHost,
    })

    const response = await fetch(`${origin}/api/previews/${PREVIEW_ID}`)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('preview')
    expect(lookupHost).toHaveBeenCalledTimes(2)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('blocks private redirect targets, unregistered IDs, invalid MIME, and oversized previews', async () => {
    const privateRedirect = vi.fn()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://cdn.vecteezy.com/video.mp4' } }))
    const { origin } = await start({
      previewRegistry: { resolve: id => id === PREVIEW_ID ? 'https://www.vecteezy.com/preview' : undefined },
      fetcher: privateRedirect,
      lookupHost: async hostname => hostname === 'cdn.vecteezy.com' ? ['127.0.0.1'] : ['93.184.216.34'],
    })

    const blocked = await fetch(`${origin}/api/previews/${PREVIEW_ID}`)
    const missing = await fetch(`${origin}/api/previews/40000000-0000-4000-8000-000000000001`)

    expect(blocked.status).toBe(502)
    expect(missing.status).toBe(404)

    const invalidMime = await start({
      previewRegistry: { resolve: () => 'https://www.vecteezy.com/preview' },
      fetcher: async () => new Response('html', { headers: { 'content-type': 'text/html', 'content-length': '4' } }),
    })
    const badMime = await fetch(`${invalidMime.origin}/api/previews/${PREVIEW_ID}`)
    expect(badMime.status).toBe(502)

    const oversized = await start({
      previewRegistry: { resolve: () => 'https://www.vecteezy.com/preview' },
      fetcher: async () => new Response('x', { headers: { 'content-type': 'video/mp4', 'content-length': `${65 * 1024 * 1024}` } }),
    })
    const tooLarge = await fetch(`${oversized.origin}/api/previews/${PREVIEW_ID}`)
    expect(tooLarge.status).toBe(502)
  })
})
