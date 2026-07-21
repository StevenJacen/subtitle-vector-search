// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkbenchApi } from './api.js'

const TASK_ID = '10000000-0000-4000-8000-000000000001'

class FakeEventSource {
  static instances: FakeEventSource[] = []

  readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>()
  onerror: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(name: string, listener: EventListener): void {
    const listeners = this.listeners.get(name) ?? []
    listeners.push(listener as (event: MessageEvent<string>) => void)
    this.listeners.set(name, listeners)
  }

  emit(name: string, value: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) {
      listener(new MessageEvent(name, { data: JSON.stringify(value) }))
    }
  }

  close(): void {
    this.closed = true
  }
}

beforeEach(() => {
  document.head.innerHTML = '<meta name="workbench-session" content="local-session-token">'
  FakeEventSource.instances = []
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('createWorkbenchApi', () => {
  it('reads the boot token only for exact same-origin mutation requests', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ tasks: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const api = createWorkbenchApi({ fetcher })

    await api.createTask({ theme: '希望', aspectRatio: '9:16', sceneCount: 5 })

    const [path, init] = fetcher.mock.calls[0]
    expect(path).toBe('/api/tasks')
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      'x-workbench-session': 'local-session-token',
    })
    expect(init?.body).toBe(JSON.stringify({ theme: '希望', aspectRatio: '9:16', sceneCount: 5 }))
  })

  it('reconnects SSE, deduplicates replayed sequences, and closes cleanly', () => {
    vi.useFakeTimers()
    const listener = vi.fn()
    const api = createWorkbenchApi({
      fetcher: vi.fn(),
      eventSourceFactory: url => new FakeEventSource(url) as unknown as EventSource,
      reconnectMs: 500,
    })

    const unsubscribe = api.subscribe(TASK_ID, listener)
    const first = FakeEventSource.instances[0]
    expect(first.url).toBe(`/api/tasks/${TASK_ID}/events`)
    first.emit('progress', { taskId: TASK_ID, sequence: 1, stage: 'planning', message: 'Planning' })
    first.onerror?.()
    expect(first.closed).toBe(true)
    vi.advanceTimersByTime(500)

    const second = FakeEventSource.instances[1]
    second.emit('progress', { taskId: TASK_ID, sequence: 1, stage: 'planning', message: 'Planning' })
    second.emit('progress', { taskId: TASK_ID, sequence: 2, stage: 'review', message: 'Ready' })
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    expect(second.closed).toBe(true)
    vi.advanceTimersByTime(1_000)
    expect(FakeEventSource.instances).toHaveLength(2)
  })

  it('uses protected mutations and sanitized subtitle reads on their exact routes', async () => {
    const fetcher = vi.fn<typeof fetch>(async (path) => new Response(JSON.stringify(
      path === '/api/subtitles/search'
        ? { originalQuery: 'hope', normalizedQuery: 'hope', warning: null, results: [] }
        : path === '/api/subtitles/summary'
          ? { readyTracks: 12, readyMovies: 5 }
          : { jobId: null, mode: null, status: 'idle', currentMovie: null, attempted: 0, succeeded: 0, failed: 0, message: 'Idle', startedAt: null, updatedAt: '2026-07-21T00:00:00.000Z' },
    ), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = createWorkbenchApi({ fetcher })

    await api.searchSubtitles({ query: 'hope', limit: 20 })
    await api.subtitleLibrary()
    await api.subtitleSync()
    await api.startSubtitleSync({ mode: 'automatic' })
    await api.stopSubtitleSync()

    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      '/api/subtitles/search',
      '/api/subtitles/summary',
      '/api/subtitles/sync',
      '/api/subtitles/sync',
      '/api/subtitles/sync/stop',
    ])
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: expect.objectContaining({ 'x-workbench-session': 'local-session-token' }), body: JSON.stringify({ query: 'hope', limit: 20 }) })
    expect(fetcher.mock.calls[1][1]).toBeUndefined()
    expect(fetcher.mock.calls[2][1]).toBeUndefined()
    expect(fetcher.mock.calls[3][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ mode: 'automatic' }) })
    expect(fetcher.mock.calls[4][1]).toMatchObject({ method: 'POST', body: '{}' })
  })

  it('keeps subtitle synchronization events open after transient errors and closes on unsubscribe', () => {
    vi.useFakeTimers()
    const listener = vi.fn()
    const api = createWorkbenchApi({
      fetcher: vi.fn(),
      eventSourceFactory: url => new FakeEventSource(url) as unknown as EventSource,
      reconnectMs: 500,
    })

    const unsubscribe = api.subscribeSubtitleSync(listener)
    const first = FakeEventSource.instances[0]
    expect(first.url).toBe('/api/subtitles/sync/events')
    first.emit('progress', { sequence: 1, snapshot: { jobId: null, mode: null, status: 'idle', currentMovie: null, attempted: 0, succeeded: 0, failed: 0, message: 'Idle', startedAt: null, updatedAt: '2026-07-21T00:00:00.000Z' } })
    expect(listener).toHaveBeenCalledTimes(1)
    first.onerror?.()
    vi.advanceTimersByTime(500)

    expect(first.closed).toBe(false)
    expect(FakeEventSource.instances).toHaveLength(1)
    unsubscribe()
    expect(first.closed).toBe(true)
  })
})
