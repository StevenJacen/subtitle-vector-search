import { describe, expect, it, vi } from 'vitest'
import {
  assertWorkbenchFixtureMode,
  createWorkbenchFixtureTaskService,
} from '../src/workbench/fixture-runtime.js'

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
})
