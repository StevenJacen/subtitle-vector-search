import type {
  CandidateKey,
  CreateTaskInput,
  WorkbenchApi,
  WorkbenchHealthReport,
  WorkbenchTask,
  WorkbenchTaskEvent,
} from './types.js'

interface WorkbenchApiOptions {
  fetcher?: typeof fetch
  eventSourceFactory?: (url: string) => EventSource
  reconnectMs?: number
}

interface ApiErrorBody {
  error?: {
    code?: string
    message?: string
  }
}

export class WorkbenchApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'WorkbenchApiError'
  }
}

export function createWorkbenchApi(options: WorkbenchApiOptions = {}): WorkbenchApi {
  const fetcher = options.fetcher ?? fetch
  const eventSourceFactory = options.eventSourceFactory ?? (url => new EventSource(url))
  const reconnectMs = options.reconnectMs ?? 1_000

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetcher(path, init)
    const payload = await response.json().catch(() => ({})) as T & ApiErrorBody
    if (!response.ok) {
      throw new WorkbenchApiError(
        payload.error?.code ?? 'request_failed',
        response.status,
        payload.error?.message ?? '请求失败',
      )
    }
    return payload
  }

  async function mutate<T>(path: string, method: 'POST' | 'PUT', body: unknown): Promise<T> {
    return request<T>(path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-workbench-session': sessionToken(),
      },
      body: JSON.stringify(body),
    })
  }

  return {
    async health() {
      return request<WorkbenchHealthReport>('/api/health')
    },
    async listTasks() {
      return (await request<{ tasks: WorkbenchTask[] }>('/api/tasks')).tasks
    },
    async createTask(input: CreateTaskInput) {
      return (await mutate<{ task: WorkbenchTask }>('/api/tasks', 'POST', input)).task
    },
    async getTask(taskId: string) {
      return (await request<{ task: WorkbenchTask }>(`/api/tasks/${taskId}`)).task
    },
    async loadMore(taskId: string, sceneIndex: number) {
      return (await mutate<{ task: WorkbenchTask }>(
        `/api/tasks/${taskId}/scenes/${sceneIndex}/candidates`,
        'POST',
        {},
      )).task
    },
    async selectCandidate(taskId: string, sceneIndex: number, candidate: CandidateKey, confirmed: boolean) {
      return (await mutate<{ task: WorkbenchTask }>(
        `/api/tasks/${taskId}/scenes/${sceneIndex}/selection`,
        'PUT',
        { runId: candidate.runId, resourceId: candidate.resourceId, confirmed },
      )).task
    },
    async produce(taskId: string) {
      await mutate(`/api/tasks/${taskId}/produce`, 'POST', {})
    },
    async resume(taskId: string) {
      await mutate(`/api/tasks/${taskId}/resume`, 'POST', {})
    },
    subscribe(taskId: string, listener: (event: WorkbenchTaskEvent) => void) {
      let source: EventSource | undefined
      let reconnect: ReturnType<typeof setTimeout> | undefined
      let stopped = false
      let lastSequence = 0

      const connect = () => {
        if (stopped) return
        source = eventSourceFactory(`/api/tasks/${taskId}/events`)
        source.addEventListener('progress', rawEvent => {
          const event = parseEvent(rawEvent)
          if (event === null || event.taskId !== taskId || event.sequence <= lastSequence) return
          lastSequence = event.sequence
          listener(event)
        })
        source.onerror = () => {
          source?.close()
          source = undefined
          if (!stopped && reconnect === undefined) {
            reconnect = setTimeout(() => {
              reconnect = undefined
              connect()
            }, reconnectMs)
          }
        }
      }

      connect()
      return () => {
        stopped = true
        if (reconnect !== undefined) clearTimeout(reconnect)
        source?.close()
      }
    },
  }
}

function sessionToken(): string {
  const value = document.querySelector<HTMLMetaElement>('meta[name="workbench-session"]')?.content
  if (value === undefined || value.length < 1) throw new Error('workbench_session_missing')
  return value
}

function parseEvent(rawEvent: Event): WorkbenchTaskEvent | null {
  if (!(rawEvent instanceof MessageEvent) || typeof rawEvent.data !== 'string') return null
  try {
    const value = JSON.parse(rawEvent.data) as Partial<WorkbenchTaskEvent>
    if (typeof value.sequence !== 'number'
      || typeof value.taskId !== 'string'
      || typeof value.stage !== 'string'
      || typeof value.message !== 'string') return null
    return value as WorkbenchTaskEvent
  } catch {
    return null
  }
}
