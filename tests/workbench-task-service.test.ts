import { describe, expect, it, vi } from 'vitest'
import type { CandidateReference, SceneCandidateState } from '../src/workbench/candidate-pool.js'
import type {
  WorkbenchManifest,
  WorkbenchOutput,
  WorkbenchReviewState,
  WorkbenchSource,
} from '../src/workbench/artifacts-v2.js'
import type { ConfirmedScene, VerifiedSceneSource } from '../src/workbench/download-manager.js'
import type { MediaProbe } from '../src/media-probe.js'
import { WorkbenchEventBus } from '../src/workbench/events.js'
import {
  WorkbenchTaskService,
  type WorkbenchTaskDependencies,
} from '../src/workbench/task-service.js'

const TASK_ID = '10000000-0000-4000-8000-000000000001'
const RUN_ID = '20000000-0000-4000-8000-000000000001'
const REQUEST_DIGEST = 'a'.repeat(64)

function passage(sceneCount = 5) {
  const cues = Array.from({ length: sceneCount }, (_, index) => ({
    trackId: 7,
    cueIndex: 30 + index,
    startMs: 10_000 + index * 3_000,
    endMs: 13_000 + index * 3_000,
    text: `Exact cue ${index + 1}.`,
    timestamp: `00:00:${String(10 + index * 3).padStart(2, '0')}.000 --> 00:00:${String(13 + index * 3).padStart(2, '0')}.000`,
  }))
  return {
    movie: { id: 9, title: 'Example Film', releaseYear: 1994 },
    trackId: 7,
    startCueIndex: 30,
    endCueIndex: 29 + sceneCount,
    totalDurationMs: sceneCount * 3_000,
    cues,
  }
}

function candidate(sceneIndex: number, page: number, offset: number): CandidateReference {
  return {
    provider: 'vecteezy',
    resourceId: sceneIndex * 1_000 + page * 100 + offset + 1,
    runId: `20000000-0000-4000-8000-${String(sceneIndex + 1).padStart(12, '0')}`,
    page,
    title: `Scene ${sceneIndex + 1} candidate ${offset + 1}`,
    previewId: `30000000-0000-4000-8000-${String(sceneIndex * 100 + page * 10 + offset + 1).padStart(12, '0')}`,
    orientation: 'landscape',
    licenseType: 'free',
    aiGenerated: false,
    score: 1 - offset / 100,
    suitabilityScore: 10,
    providerRank: offset + 1,
  }
}

function candidatePage(sceneIndex: number, page = 1) {
  const candidates = Array.from({ length: 8 }, (_, index) => candidate(sceneIndex, page, index))
  return {
    runId: candidates[0].runId,
    page,
    hasNextPage: true,
    candidates,
    recommended: { runId: candidates[0].runId, resourceId: candidates[0].resourceId },
  }
}

function fakeDependencies(overrides: Partial<WorkbenchTaskDependencies> = {}) {
  let manifest: WorkbenchManifest | undefined
  let review: WorkbenchReviewState | undefined
  const order: string[] = []
  const artifacts = {
    createTask: vi.fn(async (nextManifest: WorkbenchManifest, nextReview: WorkbenchReviewState) => {
      manifest = structuredClone(nextManifest)
      review = structuredClone(nextReview)
    }),
    readTask: vi.fn(async (_taskId: string) => structuredClone(manifest!)),
    listTasks: vi.fn(async () => manifest === undefined ? [] : [structuredClone(manifest)]),
    readReview: vi.fn(async () => structuredClone(review!)),
    updateTask: vi.fn(async (
      _taskId: string,
      updater: (value: WorkbenchManifest) => WorkbenchManifest | Promise<WorkbenchManifest>,
    ) => {
      manifest = await updater(structuredClone(manifest!))
      return structuredClone(manifest!)
    }),
    updateReview: vi.fn(async (
      _taskId: string,
      updater: (value: WorkbenchReviewState) => WorkbenchReviewState | Promise<WorkbenchReviewState>,
    ) => {
      review = await updater(structuredClone(review!))
      return structuredClone(review!)
    }),
    verifyReceipt: vi.fn(async () => true),
  }
  const output: WorkbenchOutput = {
    artifactKey: `video-runs/${TASK_ID}/final.mp4`,
    sha256: 'f'.repeat(64),
    sizeBytes: 50_000,
    durationMs: 15_000,
    width: 1920,
    height: 1080,
    frameRate: 30,
    videoCodec: 'h264',
    pixelFormat: 'yuv420p',
    audioCodec: null,
    ffmpegVersion: 'ffmpeg 7.1',
  }
  const dependencies: WorkbenchTaskDependencies = {
    createId: () => TASK_ID,
    now: () => new Date('2026-07-21T00:00:00.000Z'),
    requestDigest: vi.fn(() => REQUEST_DIGEST),
    selectPassage: vi.fn(async input => {
      order.push('passage')
      return passage(input.sceneCount)
    }),
    planPassage: vi.fn(async input => {
      order.push('ollama')
      return input.passage.cues.map((_cue: unknown, index: number) => ({
        captionZh: `台词${index + 1}`,
        visualConcept: `person walking through an open landscape ${index + 1}`,
      }))
    }),
    loadCandidatePage: vi.fn(async input => {
      order.push(`candidate:${input.sceneIndex}:${input.page}`)
      return candidatePage(input.sceneIndex, input.page)
    }),
    selectCandidate: vi.fn(async input => ({ selectionId: 500 + input.sceneIndex })),
    artifacts,
    preflightSelections: vi.fn(async input => {
      order.push('preflight')
      return input.scenes.map((scene: ConfirmedScene) => ({ sceneIndex: scene.index, selection: scene.confirmed, info: {
        resourceId: scene.confirmed.resourceId,
        sourceSizeBytes: 2_000,
        requiresAttribution: false,
        requiredAttributionUrl: null,
        quota: { limit: 100, remaining: 95 },
      } }))
    }),
    downloadConfirmedScenes: vi.fn(async input => {
      const verified: VerifiedSceneSource[] = []
      for (const scene of input.scenes) {
        const current = await artifacts.readTask(input.taskId)
        const existing = current.formalReservations.find(value => value.sceneIndex === scene.index)
        const reservationId = existing?.reservationId
          ?? `40000000-0000-4000-8000-${String(scene.index + 1).padStart(12, '0')}`
        const artifactKey = existing?.receipt?.artifactKey
          ?? `video-runs/${input.taskId}/sources/scene-${scene.index}.mp4`
        const sha256 = existing?.receipt?.sha256 ?? String(scene.index + 1).repeat(64).slice(0, 64)
        if (existing === undefined) {
          order.push(`formal:${scene.index}`)
          await artifacts.updateTask(input.taskId, latest => ({
            ...latest,
            formalReservations: [...latest.formalReservations, {
              sceneIndex: scene.index,
              reservationId,
              ...scene.confirmed,
              status: 'completed',
              receipt: { taskId: input.taskId, sceneIndex: scene.index, reservationId, artifactKey, sha256, sizeBytes: 2_000 },
            }],
            stage: 'downloading',
          }))
        }
        verified.push({
          sceneIndex: scene.index,
          reservationId,
          selectionId: scene.confirmed.selectionId,
          resourceId: scene.confirmed.resourceId,
          artifactKey,
          sourceSizeBytes: 2_000,
          sourceSha256: sha256,
          requiresAttribution: false,
          requiredAttributionUrl: null,
          quota: { limit: 100, remaining: 95 },
        })
      }
      return verified
    }),
    probeSource: vi.fn(async input => {
      order.push(`probe:${input.source.sceneIndex}`)
      const probe: MediaProbe = {
        durationMs: 30_000,
        sizeBytes: input.source.sourceSizeBytes,
        width: 1920,
        height: 1080,
        frameRate: 30,
        videoCodec: 'h264',
        audioCodec: null,
        pixelFormat: 'yuv420p',
        audioSampleRate: null,
        audioChannels: null,
      }
      return probe
    }),
    renderVideo: vi.fn(async input => {
      order.push('render')
      expect(input.timeline).toHaveLength(5)
      expect(input.assText).toContain('台词1')
      expect(input.assText).toContain('00:00:10.000')
      return output
    }),
    recoverOutput: vi.fn(async () => null),
    validateOutput: vi.fn(async () => { order.push('validate') }),
    manifestSha256: vi.fn(async () => 'e'.repeat(64)),
    production: {
      startV2: vi.fn(async () => {
        order.push('start')
        return { renderId: '50000000-0000-4000-8000-000000000001', status: 'planned' as const, isExisting: false }
      }),
      recordDownloadV2: vi.fn(async input => {
        order.push(`record:${input.selectionId - 500}`)
        return { renderId: input.renderId, downloadId: 900 + input.selectionId }
      }),
      beginRenderV2: vi.fn(async renderId => {
        order.push('begin')
        return { renderId, status: 'rendering' as const }
      }),
      completeV2: vi.fn(async input => {
        order.push('complete')
        return { renderId: input.renderId, status: 'completed' as const }
      }),
      failV2: vi.fn(async input => ({ renderId: input.renderId, status: 'failed' as const })),
      retryV2: vi.fn(async renderId => ({ renderId, status: 'planned' as const })),
    },
    ...overrides,
  }
  return { dependencies, order, manifest: () => manifest, review: () => review, output }
}

async function createConfirmedTask(service: WorkbenchTaskService, count = 5): Promise<void> {
  await service.create({ theme: 'Hope', aspectRatio: '16:9', sceneCount: count })
  for (let index = 0; index < count; index += 1) {
    await service.select(TASK_ID, index, candidatePage(index).candidates[0], true)
  }
}

async function seedStage(
  fake: ReturnType<typeof fakeDependencies>,
  stage: 'starting' | 'preflight' | 'downloading' | 'probing' | 'rendering' | 'validating' | 'completing' | 'failed',
): Promise<void> {
  await fake.dependencies.artifacts.updateTask(TASK_ID, current => {
    const allReservations = current.scenes.map((scene, index) => {
      const reservationId = `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
      const artifactKey = `video-runs/${TASK_ID}/sources/scene-${index}.mp4`
      const sha256 = String(index + 1).repeat(64).slice(0, 64)
      return {
        sceneIndex: index,
        reservationId,
        ...scene.confirmed!,
        status: 'completed' as const,
        receipt: { taskId: TASK_ID, sceneIndex: index, reservationId, artifactKey, sha256, sizeBytes: 2_000 },
      }
    })
    const allSources: WorkbenchSource[] = allReservations.map((reservation, index) => ({
      sceneIndex: index,
      reservationId: reservation.reservationId,
      selectionId: reservation.selectionId,
      downloadId: 1_400 + index,
      artifactKey: reservation.receipt.artifactKey,
      sha256: reservation.receipt.sha256,
      sizeBytes: reservation.receipt.sizeBytes,
      width: 1920,
      height: 1080,
      durationMs: 30_000,
      frameRate: 30,
      videoCodec: 'h264',
      audioCodec: null,
    }))
    const reservationCount = stage === 'downloading' ? 1
      : ['probing', 'rendering', 'validating', 'completing', 'failed'].includes(stage) ? current.sceneCount : 0
    const sourceCount = ['rendering', 'validating', 'completing', 'failed'].includes(stage) ? current.sceneCount : 0
    const hasOutput = stage === 'validating' || stage === 'completing'
    return {
      ...current,
      renderId: stage === 'starting' ? null : '50000000-0000-4000-8000-000000000001',
      formalReservations: allReservations.slice(0, reservationCount),
      sources: allSources.slice(0, sourceCount),
      ...(hasOutput ? { output: fake.output } : { output: undefined }),
      stage,
      ...(stage === 'failed'
        ? { failure: { code: 'render_failure', message: 'Video production failed', retryable: true } }
        : { failure: undefined }),
    }
  })
}

describe('workbench events', () => {
  it('publishes monotonic per-task events and replays from a sequence cursor', () => {
    const bus = new WorkbenchEventBus()
    const received: number[] = []
    const unsubscribe = bus.subscribe(TASK_ID, event => received.push(event.sequence), 1)

    expect(bus.publish(TASK_ID, 'planning', 'Planning passage').sequence).toBe(1)
    expect(bus.publish(TASK_ID, 'review', 'Review ready').sequence).toBe(2)
    unsubscribe()
    bus.publish(TASK_ID, 'review', 'Ignored live event')

    expect(received).toEqual([2])
    expect(bus.replay(TASK_ID, 1).map(event => event.sequence)).toEqual([2, 3])
  })

  it('isolates listener failures so one subscriber cannot interrupt publication', () => {
    const bus = new WorkbenchEventBus()
    const received: number[] = []
    bus.subscribe(TASK_ID, () => { throw new Error('listener failed') })
    bus.subscribe(TASK_ID, event => received.push(event.sequence))

    expect(() => bus.publish(TASK_ID, 'planning', 'Planning passage')).not.toThrow()
    expect(received).toEqual([1])
    expect(bus.replay(TASK_ID)).toHaveLength(1)
  })

  it('isolates replay listener failures and keeps the subscription active', () => {
    const bus = new WorkbenchEventBus()
    const received: number[] = []
    bus.publish(TASK_ID, 'planning', 'Planning passage')

    expect(() => bus.subscribe(TASK_ID, event => {
      received.push(event.sequence)
      throw new Error('replay listener failed')
    })).not.toThrow()
    expect(() => bus.publish(TASK_ID, 'review', 'Review ready')).not.toThrow()

    expect(received).toEqual([1, 2])
  })

  it('does not lose a reentrant publication while replaying history', () => {
    const bus = new WorkbenchEventBus()
    const received: number[] = []
    bus.publish(TASK_ID, 'planning', 'Planning passage')
    bus.publish(TASK_ID, 'planning', 'Planning scenes')

    bus.subscribe(TASK_ID, event => {
      received.push(event.sequence)
      if (event.sequence === 1) bus.publish(TASK_ID, 'review', 'Published during replay')
    })

    expect(received).toEqual([1, 2, 3])
    expect(bus.replay(TASK_ID).map(event => event.sequence)).toEqual([1, 2, 3])
  })
})

describe('workbench task creation and review', () => {
  it('validates and forwards an exact source anchor into passage selection and digesting', async () => {
    const fake = fakeDependencies()
    const service = new WorkbenchTaskService(fake.dependencies)
    const input = {
      theme: 'Hope after confinement',
      aspectRatio: '16:9' as const,
      sceneCount: 5,
      sourceAnchor: { trackId: 12, firstCueIndex: 40, lastCueIndex: 47 },
    }

    await service.create(input)

    expect(fake.dependencies.requestDigest).toHaveBeenCalledWith(input)
    expect(fake.dependencies.selectPassage).toHaveBeenCalledWith(input)
  })

  it.each([
    null,
    { trackId: 0, firstCueIndex: 40, lastCueIndex: 47 },
    { trackId: 12, firstCueIndex: -1, lastCueIndex: 47 },
    { trackId: 12, firstCueIndex: 48, lastCueIndex: 47 },
    { trackId: 12, firstCueIndex: 40.5, lastCueIndex: 47 },
  ])('rejects invalid exact source anchor %#', async sourceAnchor => {
    const fake = fakeDependencies()
    const service = new WorkbenchTaskService(fake.dependencies)

    await expect(service.create({
      theme: 'Hope',
      aspectRatio: '16:9',
      sceneCount: 5,
      sourceAnchor: sourceAnchor as never,
    })).rejects.toThrow('invalid_workbench_task_input')
    expect(fake.dependencies.selectPassage).not.toHaveBeenCalled()
  })

  it('creates passage, translations, and exactly eight initial candidates per scene in order', async () => {
    const fake = fakeDependencies()
    const service = new WorkbenchTaskService(fake.dependencies)

    const view = await service.create({ theme: 'Hope after confinement', aspectRatio: '16:9', sceneCount: 5 })

    expect(fake.order).toEqual(['passage', 'ollama', 'candidate:0:1', 'candidate:1:1', 'candidate:2:1', 'candidate:3:1', 'candidate:4:1'])
    expect(view.stage).toBe('review')
    expect(view.scenes).toHaveLength(5)
    expect(view.scenes.every(scene => scene.candidates.length === 8)).toBe(true)
    expect(fake.manifest()?.renderId).toBeNull()
    expect(fake.manifest()?.formalReservations).toEqual([])
  })

  it('keeps a controlled empty scene when one initial candidate request fails', async () => {
    const fake = fakeDependencies()
    vi.mocked(fake.dependencies.loadCandidatePage).mockImplementation(async input => {
      if (input.sceneIndex === 2) throw new Error('https://provider.invalid?token=secret')
      return candidatePage(input.sceneIndex, input.page)
    })
    const service = new WorkbenchTaskService(fake.dependencies)

    const view = await service.create({ theme: 'Hope', aspectRatio: '9:16', sceneCount: 5 })

    expect(view.stage).toBe('review')
    expect(view.scenes[2].candidates).toEqual([])
    expect(view.scenes[2].candidateStatus).toBe('unavailable')
    expect(JSON.stringify(view)).not.toContain('provider.invalid')
    expect(JSON.stringify(view)).not.toContain('secret')
  })

  it('loads the next owning page and appends candidates without replacing earlier choices', async () => {
    const fake = fakeDependencies()
    const service = new WorkbenchTaskService(fake.dependencies)
    await service.create({ theme: 'Hope', aspectRatio: '16:9', sceneCount: 5 })

    const view = await service.loadMore(TASK_ID, 0)

    expect(fake.dependencies.loadCandidatePage).toHaveBeenLastCalledWith(expect.objectContaining({
      sceneIndex: 0,
      page: 2,
      sourceRunId: candidatePage(0).runId,
    }))
    expect(view.scenes[0].candidates).toHaveLength(16)
  })

  it('persists provider selection and cancels confirmation when the candidate changes', async () => {
    const fake = fakeDependencies()
    const service = new WorkbenchTaskService(fake.dependencies)
    await service.create({ theme: 'Hope', aspectRatio: '16:9', sceneCount: 5 })
    const first = candidatePage(0).candidates[0]
    const second = candidatePage(0).candidates[1]

    let view = await service.select(TASK_ID, 0, first, true)
    expect(view.scenes[0].confirmed).toEqual({ runId: first.runId, resourceId: first.resourceId })

    view = await service.select(TASK_ID, 0, second, false)
    expect(view.scenes[0].selected).toEqual({ runId: second.runId, resourceId: second.resourceId })
    expect(view.scenes[0].confirmed).toBeNull()
    expect(fake.dependencies.selectCandidate).toHaveBeenCalledTimes(2)
    expect(fake.manifest()?.scenes[0].confirmed).toBeNull()
  })

  it('clears confirmation when the same selected candidate is explicitly unconfirmed', async () => {
    const fake = fakeDependencies()
    const service = new WorkbenchTaskService(fake.dependencies)
    await service.create({ theme: 'Hope', aspectRatio: '16:9', sceneCount: 5 })
    const first = candidatePage(0).candidates[0]
    await service.select(TASK_ID, 0, first, true)

    const view = await service.select(TASK_ID, 0, first, false)

    expect(view.scenes[0].selected).toEqual({ runId: first.runId, resourceId: first.resourceId })
    expect(view.scenes[0].confirmed).toBeNull()
    expect(fake.review()?.scenes[0].confirmed).toBeUndefined()
  })

  it('serializes task views without absolute paths, URLs, tokens, or raw payloads', async () => {
    const fake = fakeDependencies()
    const service = new WorkbenchTaskService(fake.dependencies)
    const view = await service.create({ theme: 'Hope', aspectRatio: '16:9', sceneCount: 5 })
    const serialized = JSON.stringify(view)

    expect(serialized).not.toMatch(/[A-Z]:\\/)
    expect(serialized).not.toContain('http://')
    expect(serialized).not.toContain('https://')
    expect(serialized).not.toMatch(/token|secret|rawPayload/i)
  })
})

describe('workbench production and recovery', () => {
  it('requires every scene to be confirmed before any remote production work', async () => {
    const fake = fakeDependencies()
    const service = new WorkbenchTaskService(fake.dependencies)
    await service.create({ theme: 'Hope', aspectRatio: '16:9', sceneCount: 5 })

    await expect(service.produce(TASK_ID)).rejects.toMatchObject({ code: 'selection_required' })

    expect(fake.dependencies.production.startV2).not.toHaveBeenCalled()
    expect(fake.dependencies.downloadConfirmedScenes).not.toHaveBeenCalled()
    expect(fake.manifest()?.stage).toBe('review')
  })

  it('runs start, read-only preflight, N downloads, probes, silent render, validation, and completion in order', async () => {
    const fake = fakeDependencies()
    const service = new WorkbenchTaskService(fake.dependencies)
    await createConfirmedTask(service)
    fake.order.length = 0

    await service.produce(TASK_ID)

    expect(fake.order).toEqual([
      'start', 'preflight',
      'formal:0', 'formal:1', 'formal:2', 'formal:3', 'formal:4',
      'probe:0', 'record:0', 'probe:1', 'record:1', 'probe:2', 'record:2',
      'probe:3', 'record:3', 'probe:4', 'record:4',
      'begin', 'render', 'validate', 'complete',
    ])
    expect(fake.dependencies.downloadConfirmedScenes).toHaveBeenCalledOnce()
    expect(fake.manifest()?.sources).toHaveLength(5)
    expect(fake.manifest()?.stage).toBe('completed')
    const view = await service.get(TASK_ID)
    expect(view.output).toEqual(expect.objectContaining({
      endpoint: `/api/tasks/${TASK_ID}/final`,
      basename: 'final.mp4',
      sha256: fake.output.sha256,
      audioCodec: null,
    }))
    expect(view.output).not.toHaveProperty('artifactKey')
    const completion = vi.mocked(fake.dependencies.production.completeV2).mock.calls[0][0]
    expect(completion.segments).toHaveLength(5)
    expect(completion.segments[0].sourceOutMs - completion.segments[0].sourceInMs).toBe(3_000)
    expect(completion.segments[0].sourceOutMs - completion.segments[0].sourceInMs)
      .not.toBe(completion.segments[0].timelineEndMs - completion.segments[0].timelineStartMs + 300)
  })

  it('serializes production across service instances', async () => {
    let active = 0
    let maximum = 0
    const first = fakeDependencies()
    const second = fakeDependencies({ createId: () => '10000000-0000-4000-8000-000000000002' })
    const delayedRender = async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 15))
      active -= 1
      return first.output
    }
    first.dependencies.renderVideo = vi.fn(delayedRender)
    second.dependencies.renderVideo = vi.fn(async () => delayedRender())
    const firstService = new WorkbenchTaskService(first.dependencies)
    const secondService = new WorkbenchTaskService(second.dependencies)
    await createConfirmedTask(firstService)
    await secondService.create({ theme: 'Hope', aspectRatio: '16:9', sceneCount: 5 })
    for (let index = 0; index < 5; index += 1) {
      await secondService.select('10000000-0000-4000-8000-000000000002', index, candidatePage(index).candidates[0], true)
    }

    await Promise.all([
      firstService.produce(TASK_ID),
      secondService.produce('10000000-0000-4000-8000-000000000002'),
    ])

    expect(maximum).toBe(1)
  })

  it('serializes select and produce for the same task across service instances', async () => {
    const fake = fakeDependencies()
    const first = new WorkbenchTaskService(fake.dependencies)
    const second = new WorkbenchTaskService(fake.dependencies)
    await createConfirmedTask(first)
    vi.mocked(fake.dependencies.selectCandidate).mockClear()
    let releaseRead!: () => void
    let reportBlocked!: () => void
    const blocked = new Promise<void>(resolve => { reportBlocked = resolve })
    const release = new Promise<void>(resolve => { releaseRead = resolve })
    let shouldBlock = true
    vi.mocked(fake.dependencies.artifacts.readReview).mockImplementation(async taskId => {
      if (shouldBlock) {
        shouldBlock = false
        reportBlocked()
        await release
      }
      expect(taskId).toBe(TASK_ID)
      return structuredClone(fake.review()!)
    })

    const producing = first.produce(TASK_ID)
    await blocked
    const selecting = second.select(TASK_ID, 0, candidatePage(0).candidates[1], false)
    await new Promise(resolve => setTimeout(resolve, 0))
    releaseRead()
    const [productionResult, selectionResult] = await Promise.allSettled([producing, selecting])

    expect(productionResult.status).toBe('fulfilled')
    expect(selectionResult).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'workbench_task_not_reviewable' }) })
    expect(fake.dependencies.selectCandidate).not.toHaveBeenCalled()
    expect(fake.manifest()?.stage).toBe('completed')
  })

  it('resumes validation without repeating verified downloads, probes, or render', async () => {
    const fake = fakeDependencies()
    let failOnce = true
    fake.dependencies.validateOutput = vi.fn(async () => {
      fake.order.push('validate')
      if (failOnce) {
        failOnce = false
        throw new Error('C:\\private\\final.mp4?token=secret')
      }
    })
    const service = new WorkbenchTaskService(fake.dependencies)
    await createConfirmedTask(service)
    fake.order.length = 0

    await expect(service.produce(TASK_ID)).rejects.toMatchObject({ code: 'render_failure' })
    expect(fake.manifest()?.failure).toEqual({
      code: 'render_failure',
      message: 'Video production failed',
      retryable: true,
    })
    await service.resume(TASK_ID)

    expect(fake.dependencies.downloadConfirmedScenes).toHaveBeenCalledTimes(1)
    expect(fake.dependencies.probeSource).toHaveBeenCalledTimes(5)
    expect(fake.dependencies.renderVideo).toHaveBeenCalledTimes(1)
    expect(fake.dependencies.validateOutput).toHaveBeenCalledTimes(2)
    expect(fake.dependencies.production.completeV2).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(fake.manifest())).not.toMatch(/private|token|secret/i)
  })

  it('re-enters remote rendering before completing after a validation failure marked the job failed', async () => {
    const fake = fakeDependencies()
    let failValidation = true
    let remoteStatus: 'planned' | 'rendering' | 'failed' | 'completed' = 'planned'
    const resumeOperations: string[] = []
    vi.mocked(fake.dependencies.validateOutput).mockImplementation(async () => {
      if (failValidation) {
        failValidation = false
        throw new Error('validation failed')
      }
    })
    vi.mocked(fake.dependencies.production.beginRenderV2).mockImplementation(async renderId => {
      resumeOperations.push('begin')
      remoteStatus = 'rendering'
      return { renderId, status: 'rendering' }
    })
    vi.mocked(fake.dependencies.production.failV2).mockImplementation(async input => {
      remoteStatus = 'failed'
      return { renderId: input.renderId, status: 'failed' }
    })
    vi.mocked(fake.dependencies.production.startV2).mockImplementation(async () => {
      resumeOperations.push(`start:${remoteStatus}`)
      return {
        renderId: '50000000-0000-4000-8000-000000000001',
        status: remoteStatus,
        isExisting: remoteStatus !== 'planned',
      }
    })
    vi.mocked(fake.dependencies.production.retryV2).mockImplementation(async renderId => {
      resumeOperations.push('retry')
      remoteStatus = 'planned'
      return { renderId, status: 'planned' }
    })
    vi.mocked(fake.dependencies.production.completeV2).mockImplementation(async input => {
      resumeOperations.push('complete')
      if (remoteStatus !== 'rendering') throw new Error('job is not rendering')
      remoteStatus = 'completed'
      return { renderId: input.renderId, status: 'completed' }
    })
    const service = new WorkbenchTaskService(fake.dependencies)
    await createConfirmedTask(service)

    await expect(service.produce(TASK_ID)).rejects.toMatchObject({ code: 'render_failure' })
    resumeOperations.length = 0
    await service.resume(TASK_ID)

    expect(resumeOperations).toEqual(['start:failed', 'retry', 'begin', 'complete'])
    expect(fake.manifest()?.stage).toBe('completed')
  })

  it('reconciles remote rendering when failV2 transport failed instead of retrying forever', async () => {
    const fake = fakeDependencies()
    let failCompletion = true
    let remoteStatus: 'planned' | 'downloading' | 'rendering' | 'completed' = 'planned'
    const resumeOperations: string[] = []
    vi.mocked(fake.dependencies.production.startV2).mockImplementation(async () => {
      resumeOperations.push(`start:${remoteStatus}`)
      return {
        renderId: '50000000-0000-4000-8000-000000000001',
        status: remoteStatus,
        isExisting: remoteStatus !== 'planned',
      }
    })
    vi.mocked(fake.dependencies.production.recordDownloadV2).mockImplementation(async input => {
      remoteStatus = 'downloading'
      return { renderId: input.renderId, downloadId: 900 + input.selectionId }
    })
    vi.mocked(fake.dependencies.production.beginRenderV2).mockImplementation(async renderId => {
      resumeOperations.push('begin')
      if (remoteStatus !== 'downloading') throw new Error('render is not ready to begin')
      remoteStatus = 'rendering'
      return { renderId, status: 'rendering' }
    })
    vi.mocked(fake.dependencies.production.retryV2).mockImplementation(async renderId => {
      resumeOperations.push('retry')
      if (remoteStatus !== 'completed') throw new Error('only failed renders can retry')
      return { renderId, status: 'planned' }
    })
    vi.mocked(fake.dependencies.production.failV2).mockRejectedValue(new Error('fail transport unavailable'))
    vi.mocked(fake.dependencies.production.completeV2).mockImplementation(async input => {
      resumeOperations.push('complete')
      if (remoteStatus !== 'rendering') throw new Error('render is not rendering')
      if (failCompletion) {
        failCompletion = false
        throw new Error('completion transport unavailable')
      }
      remoteStatus = 'completed'
      return { renderId: input.renderId, status: 'completed' }
    })
    const service = new WorkbenchTaskService(fake.dependencies)
    await createConfirmedTask(service)
    await expect(service.produce(TASK_ID)).rejects.toMatchObject({ code: 'metadata_failure' })
    expect(remoteStatus).toBe('rendering')
    resumeOperations.length = 0

    await service.resume(TASK_ID)

    expect(resumeOperations).toEqual(['start:rendering', 'complete'])
    expect(fake.dependencies.production.retryV2).not.toHaveBeenCalled()
    expect(fake.manifest()?.stage).toBe('completed')
  })

  it('resumes a rendering stage after beginRenderV2 committed without beginning twice', async () => {
    const fake = fakeDependencies()
    const service = new WorkbenchTaskService(fake.dependencies)
    await createConfirmedTask(service)
    await seedStage(fake, 'rendering')
    vi.mocked(fake.dependencies.production.startV2).mockResolvedValue({
      renderId: '50000000-0000-4000-8000-000000000001',
      status: 'rendering',
      isExisting: true,
    })
    vi.mocked(fake.dependencies.production.beginRenderV2).mockRejectedValue(new Error('render is not ready to begin'))
    vi.clearAllMocks()
    vi.mocked(fake.dependencies.production.startV2).mockResolvedValue({
      renderId: '50000000-0000-4000-8000-000000000001',
      status: 'rendering',
      isExisting: true,
    })
    vi.mocked(fake.dependencies.production.beginRenderV2).mockRejectedValue(new Error('render is not ready to begin'))

    await service.resume(TASK_ID)

    expect(fake.dependencies.production.startV2).toHaveBeenCalledOnce()
    expect(fake.dependencies.production.beginRenderV2).not.toHaveBeenCalled()
    expect(fake.dependencies.renderVideo).toHaveBeenCalledOnce()
    expect(fake.manifest()?.stage).toBe('completed')
  })

  it('does not repeat completion when the remote job completed before local persistence', async () => {
    const fake = fakeDependencies()
    let remoteCompleted = false
    vi.mocked(fake.dependencies.production.completeV2).mockImplementation(async input => {
      fake.order.push('complete')
      remoteCompleted = true
      throw new Error('connection reset after commit')
    })
    vi.mocked(fake.dependencies.production.startV2).mockImplementation(async () => ({
      renderId: '50000000-0000-4000-8000-000000000001',
      status: remoteCompleted ? 'completed' : 'planned',
      isExisting: remoteCompleted,
    }))
    const service = new WorkbenchTaskService(fake.dependencies)
    await createConfirmedTask(service)

    await expect(service.produce(TASK_ID)).rejects.toMatchObject({ code: 'metadata_failure' })
    await service.resume(TASK_ID)

    expect(fake.dependencies.production.completeV2).toHaveBeenCalledTimes(1)
    expect(fake.manifest()?.stage).toBe('completed')
  })

  it('recovers a remotely failed completion through retry, begin render, and one idempotent completion', async () => {
    const fake = fakeDependencies()
    let remoteStatus: 'planned' | 'rendering' | 'failed' | 'completed' = 'planned'
    let failFirstCompletion = true
    const operations: string[] = []
    vi.mocked(fake.dependencies.production.startV2).mockImplementation(async () => {
      operations.push(`start:${remoteStatus}`)
      return {
        renderId: '50000000-0000-4000-8000-000000000001',
        status: remoteStatus,
        isExisting: remoteStatus !== 'planned',
      }
    })
    vi.mocked(fake.dependencies.production.retryV2).mockImplementation(async renderId => {
      operations.push('retry')
      remoteStatus = 'planned'
      return { renderId, status: 'planned' }
    })
    vi.mocked(fake.dependencies.production.beginRenderV2).mockImplementation(async renderId => {
      operations.push('begin')
      remoteStatus = 'rendering'
      return { renderId, status: 'rendering' }
    })
    vi.mocked(fake.dependencies.production.completeV2).mockImplementation(async input => {
      operations.push('complete')
      if (remoteStatus !== 'rendering') throw new Error('job is not rendering')
      if (failFirstCompletion) {
        failFirstCompletion = false
        throw new Error('completion transport failed')
      }
      remoteStatus = 'completed'
      return { renderId: input.renderId, status: 'completed' }
    })
    vi.mocked(fake.dependencies.production.failV2).mockImplementation(async input => {
      operations.push('fail')
      remoteStatus = 'failed'
      return { renderId: input.renderId, status: 'failed' }
    })
    const service = new WorkbenchTaskService(fake.dependencies)
    await createConfirmedTask(service)

    await expect(service.produce(TASK_ID)).rejects.toMatchObject({ code: 'metadata_failure' })
    operations.length = 0
    await service.resume(TASK_ID)

    expect(operations).toEqual(['start:failed', 'retry', 'begin', 'complete'])
    expect(fake.manifest()?.stage).toBe('completed')
  })

  it('resumes planning by fetching only missing candidates without repeating passage or translation', async () => {
    const fake = fakeDependencies()
    const service = new WorkbenchTaskService(fake.dependencies)
    await service.create({ theme: 'Hope', aspectRatio: '16:9', sceneCount: 5 })
    await fake.dependencies.artifacts.updateReview(TASK_ID, current => ({
      ...current,
      scenes: current.scenes.map((scene, index) => index === 3 ? { pages: [], hasNextPage: true } : scene),
    }))
    await fake.dependencies.artifacts.updateTask(TASK_ID, current => ({ ...current, stage: 'planning' }))
    vi.clearAllMocks()

    await service.resume(TASK_ID)

    expect(fake.dependencies.selectPassage).not.toHaveBeenCalled()
    expect(fake.dependencies.planPassage).not.toHaveBeenCalled()
    expect(fake.dependencies.loadCandidatePage).toHaveBeenCalledOnce()
    expect(fake.dependencies.loadCandidatePage).toHaveBeenCalledWith(expect.objectContaining({ sceneIndex: 3, page: 1 }))
    expect(fake.manifest()?.stage).toBe('review')
  })

  it.each([
    ['starting', 5, 5, 1, 1, 1],
    ['preflight', 5, 5, 1, 1, 1],
    ['downloading', 4, 5, 1, 1, 1],
    ['probing', 0, 5, 1, 1, 1],
    ['rendering', 0, 0, 1, 1, 1],
    ['validating', 0, 0, 0, 1, 1],
    ['completing', 0, 0, 0, 0, 1],
    ['failed', 0, 0, 1, 1, 1],
  ] as const)('resumes %s idempotently', async (stage, formalCount, probeCount, renderCount, validateCount, completeCount) => {
    const fake = fakeDependencies()
    const service = new WorkbenchTaskService(fake.dependencies)
    await createConfirmedTask(service)
    await seedStage(fake, stage)
    fake.order.length = 0
    vi.clearAllMocks()

    await service.resume(TASK_ID)

    expect(fake.order.filter(value => value.startsWith('formal:'))).toHaveLength(formalCount)
    expect(fake.dependencies.probeSource).toHaveBeenCalledTimes(probeCount)
    expect(fake.dependencies.renderVideo).toHaveBeenCalledTimes(renderCount)
    expect(fake.dependencies.validateOutput).toHaveBeenCalledTimes(validateCount)
    expect(fake.dependencies.production.completeV2).toHaveBeenCalledTimes(completeCount)
    expect(fake.dependencies.selectPassage).not.toHaveBeenCalled()
    expect(fake.dependencies.planPassage).not.toHaveBeenCalled()
    expect(fake.dependencies.selectCandidate).not.toHaveBeenCalled()
    expect(fake.manifest()?.stage).toBe('completed')
  })

  it('recovers a completed local render before invoking FFmpeg again', async () => {
    const fake = fakeDependencies()
    const service = new WorkbenchTaskService(fake.dependencies)
    await createConfirmedTask(service)
    await seedStage(fake, 'rendering')
    vi.mocked(fake.dependencies.recoverOutput).mockResolvedValue(fake.output)
    vi.clearAllMocks()

    await service.resume(TASK_ID)

    expect(fake.dependencies.recoverOutput).toHaveBeenCalledOnce()
    expect(fake.dependencies.renderVideo).not.toHaveBeenCalled()
    expect(fake.manifest()?.stage).toBe('completed')
  })

  it('makes an uncertain formal outcome non-retryable and never issues another formal call', async () => {
    const fake = fakeDependencies()
    const uncertain = Object.assign(new Error('signed URL must stay private'), { code: 'formal_call_uncertain' })
    vi.mocked(fake.dependencies.downloadConfirmedScenes).mockRejectedValue(uncertain)
    const service = new WorkbenchTaskService(fake.dependencies)
    await createConfirmedTask(service)

    await expect(service.produce(TASK_ID)).rejects.toMatchObject({ code: 'formal_call_uncertain', retryable: false })
    await expect(service.resume(TASK_ID)).rejects.toMatchObject({ code: 'formal_call_uncertain', retryable: false })

    expect(fake.dependencies.downloadConfirmedScenes).toHaveBeenCalledOnce()
    expect(fake.manifest()?.failure).toEqual({
      code: 'formal_call_uncertain',
      message: 'Formal download outcome is uncertain',
      retryable: false,
    })
  })

  it('persists a probed source before remote metadata so recovery never probes it twice', async () => {
    const fake = fakeDependencies()
    let failOnce = true
    vi.mocked(fake.dependencies.production.recordDownloadV2).mockImplementation(async input => {
      fake.order.push(`record:${input.selectionId - 500}`)
      if (input.selectionId === 502 && failOnce) {
        failOnce = false
        throw new Error('remote metadata unavailable')
      }
      return { renderId: input.renderId, downloadId: 900 + input.selectionId }
    })
    const service = new WorkbenchTaskService(fake.dependencies)
    await createConfirmedTask(service)

    await expect(service.produce(TASK_ID)).rejects.toMatchObject({ code: 'source_validation_failure' })
    expect(fake.manifest()?.sources.map(source => source.sceneIndex)).toEqual([0, 1, 2])
    await service.resume(TASK_ID)

    expect(fake.dependencies.probeSource).toHaveBeenCalledTimes(5)
    expect(fake.manifest()?.sources.every(source => source.downloadId !== undefined)).toBe(true)
    expect(fake.manifest()?.stage).toBe('completed')
  })

  it('routes a deterministic source probe failure to replaceable selection state', async () => {
    const fake = fakeDependencies()
    vi.mocked(fake.dependencies.probeSource).mockImplementation(async input => {
      if (input.source.sceneIndex === 2) {
        throw Object.assign(new Error('invalid media probe'), { code: 'invalid_media_probe' })
      }
      return {
        durationMs: 30_000,
        sizeBytes: input.source.sourceSizeBytes,
        width: 1920,
        height: 1080,
        frameRate: 30,
        videoCodec: 'h264',
        audioCodec: null,
        pixelFormat: 'yuv420p',
        audioSampleRate: null,
        audioChannels: null,
      }
    })
    const service = new WorkbenchTaskService(fake.dependencies)
    await createConfirmedTask(service)

    await expect(service.produce(TASK_ID)).rejects.toMatchObject({ code: 'selection_required', retryable: true })
    expect(fake.manifest()?.failure).toEqual({
      code: 'selection_required',
      message: 'Selected source must be replaced',
      retryable: true,
    })
    const replacement = candidatePage(2).candidates[1]
    const view = await service.select(TASK_ID, 2, replacement, false)
    expect(view.stage).toBe('review')
    expect(fake.manifest()?.renderId).toBeNull()
    expect(fake.manifest()?.formalReservations.map(value => value.sceneIndex)).toEqual([0, 1, 3, 4])
    expect(fake.manifest()?.sources.map(value => value.sceneIndex)).toEqual([0, 1])
  })

  it('discards a rejected output and renders again instead of validating the same file forever', async () => {
    const fake = fakeDependencies()
    const replacementOutput = { ...fake.output, sha256: '9'.repeat(64) }
    vi.mocked(fake.dependencies.renderVideo)
      .mockResolvedValueOnce(fake.output)
      .mockResolvedValueOnce(replacementOutput)
    vi.mocked(fake.dependencies.recoverOutput).mockResolvedValue(null)
    vi.mocked(fake.dependencies.validateOutput).mockImplementation(async input => {
      if (input.output.sha256 === fake.output.sha256) {
        throw Object.assign(new Error('invalid final media'), { code: 'invalid_final_media' })
      }
    })
    const service = new WorkbenchTaskService(fake.dependencies)
    await createConfirmedTask(service)

    await expect(service.produce(TASK_ID)).rejects.toMatchObject({ code: 'output_validation_failed', retryable: true })
    expect(fake.manifest()?.output?.sha256).toBe(fake.output.sha256)
    vi.mocked(fake.dependencies.recoverOutput).mockClear()
    vi.mocked(fake.dependencies.recoverOutput).mockResolvedValue(fake.output)
    const resumeError = await service.resume(TASK_ID).catch(error => error)

    expect(fake.dependencies.recoverOutput).not.toHaveBeenCalled()
    expect(fake.dependencies.renderVideo).toHaveBeenCalledTimes(2)
    expect(fake.dependencies.validateOutput).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fake.dependencies.validateOutput).mock.calls.map(call => call[0].output.sha256))
      .toEqual([fake.output.sha256, replacementOutput.sha256])
    expect(resumeError).toBeUndefined()
    expect(fake.manifest()?.output?.sha256).toBe(replacementOutput.sha256)
    expect(fake.manifest()?.stage).toBe('completed')
  })

  it('hashes the persisted completing manifest immediately before the atomic remote completion call', async () => {
    const fake = fakeDependencies()
    const order: string[] = []
    vi.mocked(fake.dependencies.manifestSha256).mockImplementation(async () => {
      order.push(`hash:${fake.manifest()?.stage}`)
      return 'e'.repeat(64)
    })
    vi.mocked(fake.dependencies.production.completeV2).mockImplementation(async input => {
      order.push(`complete:${fake.manifest()?.stage}`)
      expect(input.output.manifestSha256).toBe('e'.repeat(64))
      return { renderId: input.renderId, status: 'completed' }
    })
    const service = new WorkbenchTaskService(fake.dependencies)
    await createConfirmedTask(service)

    await service.produce(TASK_ID)

    expect(order).toEqual(['hash:completing', 'complete:completing'])
  })

  it('returns a read-only preflight rejection to replaceable review state', async () => {
    const fake = fakeDependencies()
    const rejected = Object.assign(new Error('oversized provider file at https://private.invalid'), {
      code: 'file_size_limit_exceeded',
    })
    vi.mocked(fake.dependencies.preflightSelections).mockRejectedValue(rejected)
    const service = new WorkbenchTaskService(fake.dependencies)
    await createConfirmedTask(service)

    await expect(service.produce(TASK_ID)).rejects.toMatchObject({ code: 'selection_required', retryable: true })
    expect(fake.manifest()).toEqual(expect.objectContaining({
      stage: 'failed',
      failure: {
        code: 'selection_required',
        message: 'Selected source must be replaced',
        retryable: true,
      },
    }))

    const replacement = candidatePage(0).candidates[1]
    const view = await service.select(TASK_ID, 0, replacement, false)
    expect(view.stage).toBe('review')
    expect(fake.manifest()?.renderId).toBeNull()
    expect(fake.manifest()?.failure).toBeUndefined()
    expect(JSON.stringify(view)).not.toContain('private.invalid')
  })

  it('retries an existing failed remote job after replacing a preflight-rejected candidate', async () => {
    const fake = fakeDependencies()
    let remoteStatus: 'planned' | 'failed' = 'planned'
    let rejectPreflight = true
    vi.mocked(fake.dependencies.preflightSelections).mockImplementation(async input => {
      if (rejectPreflight) {
        rejectPreflight = false
        throw Object.assign(new Error('too large'), { code: 'file_size_limit_exceeded' })
      }
      return input.scenes.map(scene => ({ sceneIndex: scene.index, selection: scene.confirmed, info: {
        resourceId: scene.confirmed.resourceId,
        sourceSizeBytes: 2_000,
        requiresAttribution: false,
        requiredAttributionUrl: null,
        quota: { limit: 100, remaining: 95 },
      } }))
    })
    vi.mocked(fake.dependencies.production.startV2).mockImplementation(async () => ({
      renderId: '50000000-0000-4000-8000-000000000001',
      status: remoteStatus,
      isExisting: remoteStatus === 'failed',
    }))
    vi.mocked(fake.dependencies.production.failV2).mockImplementation(async input => {
      remoteStatus = 'failed'
      return { renderId: input.renderId, status: 'failed' }
    })
    vi.mocked(fake.dependencies.production.retryV2).mockImplementation(async renderId => {
      remoteStatus = 'planned'
      return { renderId, status: 'planned' }
    })
    const service = new WorkbenchTaskService(fake.dependencies)
    await createConfirmedTask(service)
    await expect(service.produce(TASK_ID)).rejects.toMatchObject({ code: 'selection_required' })
    const replacement = candidatePage(0).candidates[1]
    await service.select(TASK_ID, 0, replacement, true)
    vi.mocked(fake.dependencies.production.retryV2).mockClear()

    await service.produce(TASK_ID)

    expect(fake.dependencies.production.retryV2).toHaveBeenCalledOnce()
    expect(fake.manifest()?.stage).toBe('completed')
  })
})
