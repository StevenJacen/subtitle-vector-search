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
})
