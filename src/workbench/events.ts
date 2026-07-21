import type { WorkbenchStage } from './artifacts-v2.js'

export interface WorkbenchEvent {
  sequence: number
  taskId: string
  stage: WorkbenchStage
  message: string
  sceneIndex?: number
}

type Listener = (event: WorkbenchEvent) => void

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class WorkbenchEventBus {
  private readonly events = new Map<string, WorkbenchEvent[]>()
  private readonly listeners = new Map<string, Set<Listener>>()

  publish(taskId: string, stage: WorkbenchStage, message: string, sceneIndex?: number): WorkbenchEvent {
    assertTaskId(taskId)
    if (typeof message !== 'string' || message.trim() === '' || message.length > 500) {
      throw new Error('invalid_workbench_event')
    }
    if (sceneIndex !== undefined && (!Number.isSafeInteger(sceneIndex) || sceneIndex < 0 || sceneIndex > 9)) {
      throw new Error('invalid_workbench_event')
    }

    const history = this.events.get(taskId) ?? []
    const event: WorkbenchEvent = {
      sequence: history.length + 1,
      taskId,
      stage,
      message: message.trim(),
      ...(sceneIndex === undefined ? {} : { sceneIndex }),
    }
    history.push(event)
    this.events.set(taskId, history)
    for (const listener of this.listeners.get(taskId) ?? []) {
      try {
        listener({ ...event })
      } catch {
        // Event consumers are observational and must never interrupt task work.
      }
    }
    return { ...event }
  }

  replay(taskId: string, afterSequence = 0): WorkbenchEvent[] {
    assertTaskId(taskId)
    assertSequence(afterSequence)
    return (this.events.get(taskId) ?? [])
      .filter(event => event.sequence > afterSequence)
      .map(event => ({ ...event }))
  }

  subscribe(taskId: string, listener: Listener, afterSequence = 0): () => void {
    assertTaskId(taskId)
    assertSequence(afterSequence)
    let cursor = afterSequence
    let replaying = true
    const pending: WorkbenchEvent[] = []
    const deliver: Listener = event => {
      if (event.sequence <= cursor) return
      cursor = event.sequence
      try {
        listener({ ...event })
      } catch {
        // Replay and live listeners are observational and isolated alike.
      }
    }
    const guarded: Listener = event => {
      if (replaying) {
        pending.push({ ...event })
        return
      }
      deliver(event)
    }
    const listeners = this.listeners.get(taskId) ?? new Set<Listener>()
    listeners.add(guarded)
    this.listeners.set(taskId, listeners)
    for (const event of this.replay(taskId, cursor)) deliver(event)
    replaying = false
    for (const event of pending) deliver(event)
    return () => {
      listeners.delete(guarded)
      if (listeners.size === 0) this.listeners.delete(taskId)
    }
  }
}

function assertTaskId(taskId: string): void {
  if (!UUID.test(taskId)) throw new Error('invalid_workbench_task_id')
}

function assertSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_workbench_event_sequence')
}
