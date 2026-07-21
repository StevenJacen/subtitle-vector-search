import type { CandidatePageResult } from './vecteezy-candidates.js'
import { buildDynamicAssSubtitles } from '../ass-subtitles.js'
import type { MediaProbe } from '../media-probe.js'
import type { CompleteRenderV2Request, VideoProductionApi } from '../video-production-api.js'
import { FormalDownloadBudget } from '../vecteezy-download.js'
import {
  appendCandidatePage,
  confirmSceneCandidate,
  selectSceneCandidate,
  type CandidateKey,
  type CandidateReference,
  type SceneCandidateState,
} from './candidate-pool.js'
import type { PlannedCue } from './ollama.js'
import type { PassageSourceAnchor, SelectedPassage } from './passage-selection.js'
import {
  buildDynamicTimeline,
  type DynamicRenderConfiguration,
  type TimelineScene,
} from './render-plan.js'
import type {
  ConfirmedScene,
  PreflightResult,
  VerifiedSceneSource,
} from './download-manager.js'
import {
  type WorkbenchDownloadReceipt,
  type WorkbenchManifest,
  type WorkbenchOutput,
  type WorkbenchReviewState,
  type WorkbenchSource,
  type WorkbenchStage,
} from './artifacts-v2.js'
import { WorkbenchEventBus } from './events.js'

export interface CreateTaskInput {
  theme: string
  aspectRatio: '9:16' | '16:9'
  sceneCount: number
  sourceAnchor?: PassageSourceAnchor
}

export interface CandidateIdentity {
  runId: string
  resourceId: number
}

export interface WorkbenchTaskStore {
  createTask(manifest: WorkbenchManifest, review: WorkbenchReviewState): Promise<void>
  readTask(taskId: string): Promise<WorkbenchManifest>
  listTasks(): Promise<WorkbenchManifest[]>
  readReview(taskId: string): Promise<WorkbenchReviewState>
  updateTask(
    taskId: string,
    updater: (manifest: WorkbenchManifest) => WorkbenchManifest | Promise<WorkbenchManifest>,
  ): Promise<WorkbenchManifest>
  updateReview(
    taskId: string,
    updater: (review: WorkbenchReviewState) => WorkbenchReviewState | Promise<WorkbenchReviewState>,
  ): Promise<WorkbenchReviewState>
  verifyReceipt(receipt: WorkbenchDownloadReceipt): Promise<boolean>
}

export interface WorkbenchTaskDependencies {
  createId(): string
  now(): Date
  requestDigest(input: CreateTaskInput): string
  selectPassage(input: CreateTaskInput): Promise<SelectedPassage>
  planPassage(input: { theme: string; passage: SelectedPassage }): Promise<PlannedCue[]>
  loadCandidatePage(input: {
    taskId: string
    sceneIndex: number
    theme: string
    aspectRatio: CreateTaskInput['aspectRatio']
    page: number
    sourceRunId?: string
  }): Promise<CandidatePageResult>
  selectCandidate(input: {
    taskId: string
    sceneIndex: number
    candidate: CandidateReference
    note: string
  }): Promise<{ selectionId: number }>
  artifacts: WorkbenchTaskStore
  preflightSelections(input: {
    taskId: string
    scenes: readonly ConfirmedScene[]
  }): Promise<PreflightResult[]>
  downloadConfirmedScenes(input: {
    taskId: string
    scenes: readonly ConfirmedScene[]
    budget: FormalDownloadBudget
  }): Promise<VerifiedSceneSource[]>
  probeSource(input: { taskId: string; source: VerifiedSceneSource }): Promise<MediaProbe>
  renderVideo(input: {
    taskId: string
    renderId: string
    sources: readonly WorkbenchSource[]
    timeline: readonly TimelineScene[]
    assText: string
    width: number
    height: number
    frameRate: 30
  }): Promise<WorkbenchOutput>
  recoverOutput(taskId: string): Promise<WorkbenchOutput | null>
  validateOutput(input: { taskId: string; output: WorkbenchOutput }): Promise<void>
  manifestSha256(taskId: string): Promise<string>
  production: Pick<VideoProductionApi,
    'startV2' | 'recordDownloadV2' | 'beginRenderV2' | 'completeV2' | 'failV2' | 'retryV2'>
  events?: WorkbenchEventBus
}

export interface WorkbenchSceneView {
  index: number
  cueIndex: number
  durationMs: number
  captionEn: string
  captionZh: string
  visualConcept: string
  candidates: CandidateReference[]
  candidateStatus: 'ready' | 'unavailable' | 'exhausted'
  hasNextPage: boolean
  selected: CandidateKey | null
  confirmed: CandidateKey | null
  recommended: CandidateKey | null
}

export interface WorkbenchOutputView {
  endpoint: string
  basename: 'final.mp4'
  sha256: string
  sizeBytes: number
  durationMs: number
  width: number
  height: number
  frameRate: 30
  videoCodec: 'h264'
  pixelFormat: 'yuv420p'
  audioCodec: null
}

export interface WorkbenchTaskView {
  taskId: string
  theme: string
  aspectRatio: CreateTaskInput['aspectRatio']
  width: number
  height: number
  sceneCount: number
  stage: WorkbenchStage
  passage: SelectedPassage
  scenes: WorkbenchSceneView[]
  failure?: { code: string; message: string; retryable: boolean }
  output?: WorkbenchOutputView
  createdAt: string
  updatedAt: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/
let productionTail: Promise<void> = Promise.resolve()
const processTaskLocks = new Map<string, Promise<void>>()

export class WorkbenchTaskError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'WorkbenchTaskError'
  }
}

export class WorkbenchTaskService {
  readonly events: WorkbenchEventBus

  constructor(private readonly dependencies: WorkbenchTaskDependencies) {
    this.events = dependencies.events ?? new WorkbenchEventBus()
  }

  async create(input: CreateTaskInput): Promise<WorkbenchTaskView> {
    validateCreateInput(input)
    const taskId = this.dependencies.createId().toLowerCase()
    if (!UUID.test(taskId)) throw new Error('invalid_workbench_task_id')
    const requestDigest = this.dependencies.requestDigest(input)
    if (!SHA256.test(requestDigest)) throw new Error('invalid_workbench_request_digest')
    this.events.publish(taskId, 'planning', 'Selecting subtitle passage')
    const selected = await this.dependencies.selectPassage({ ...input, theme: input.theme.trim() })
    this.events.publish(taskId, 'planning', 'Planning bilingual scenes')
    const plans = await this.dependencies.planPassage({ theme: input.theme.trim(), passage: selected })
    if (plans.length !== input.sceneCount) throw new Error('invalid_workbench_scene_plan')

    const createdAt = this.dependencies.now().toISOString()
    const dimensions = input.aspectRatio === '16:9'
      ? { width: 1920 as const, height: 1080 as const }
      : { width: 1080 as const, height: 1920 as const }
    const manifest: WorkbenchManifest = {
      version: 2,
      taskId,
      renderId: null,
      requestDigest,
      theme: input.theme.trim(),
      aspectRatio: input.aspectRatio,
      ...dimensions,
      sceneCount: input.sceneCount,
      passage: selected,
      scenes: selected.cues.map((cue, index) => ({
        index,
        cueIndex: cue.cueIndex,
        durationMs: cue.endMs - cue.startMs,
        captionEn: cue.text,
        plan: plans[index],
        selected: null,
        confirmed: null,
      })),
      formalReservations: [],
      sources: [],
      stage: 'planning',
      createdAt,
      updatedAt: createdAt,
    }
    const review: WorkbenchReviewState = {
      version: 1,
      taskId,
      scenes: Array.from({ length: input.sceneCount }, emptyCandidateState),
    }
    await this.dependencies.artifacts.createTask(manifest, review)

    for (let sceneIndex = 0; sceneIndex < input.sceneCount; sceneIndex += 1) {
      try {
        await this.loadInitialPage(taskId, sceneIndex, manifest)
        this.events.publish(taskId, 'planning', 'Scene candidates ready', sceneIndex)
      } catch {
        this.events.publish(taskId, 'planning', 'Scene candidates unavailable', sceneIndex)
      }
    }
    await this.dependencies.artifacts.updateTask(taskId, current => ({ ...current, stage: 'review' }))
    this.events.publish(taskId, 'review', 'Task ready for review')
    return this.view(taskId)
  }

  loadMore(taskId: string, sceneIndex: number): Promise<WorkbenchTaskView> {
    return this.withTaskLock(taskId, async () => {
      const [manifest, review] = await Promise.all([
        this.dependencies.artifacts.readTask(taskId),
        this.dependencies.artifacts.readReview(taskId),
      ])
      assertReviewable(manifest, sceneIndex)
      const state = review.scenes[sceneIndex]
      const page = state.pages.length + 1
      const sourceRunId = state.pages[0]?.[0]?.runId
      const result = await this.dependencies.loadCandidatePage({
        taskId,
        sceneIndex,
        theme: manifest.scenes[sceneIndex].plan.visualConcept,
        aspectRatio: manifest.aspectRatio,
        page,
        ...(sourceRunId === undefined ? {} : { sourceRunId }),
      })
      await this.dependencies.artifacts.updateReview(taskId, current => ({
        ...current,
        scenes: replaceAt(current.scenes, sceneIndex, appendCandidatePage(
          current.scenes[sceneIndex], result.candidates, result.hasNextPage,
        )),
      }))
      this.events.publish(taskId, 'review', 'More scene candidates ready', sceneIndex)
      return this.view(taskId)
    })
  }

  select(
    taskId: string,
    sceneIndex: number,
    candidateIdentity: CandidateIdentity,
    confirmed: boolean,
  ): Promise<WorkbenchTaskView> {
    return this.withTaskLock(taskId, async () => {
      const [manifest, review] = await Promise.all([
        this.dependencies.artifacts.readTask(taskId),
        this.dependencies.artifacts.readReview(taskId),
      ])
      assertReviewable(manifest, sceneIndex)
      const state = review.scenes[sceneIndex]
      const candidate = state.pages.flat().find(value => value.runId === candidateIdentity.runId
        && value.resourceId === candidateIdentity.resourceId)
      if (candidate === undefined) throw new Error('candidate_not_found')
      const identity: CandidateIdentity = {
        runId: candidate.runId,
        resourceId: candidate.resourceId,
      }
      let nextState = selectSceneCandidate(state, identity)
      if (confirmed) {
        nextState = confirmSceneCandidate(nextState)
      } else {
        nextState = { ...nextState, confirmed: undefined }
      }
      const selection = await this.dependencies.selectCandidate({
        taskId,
        sceneIndex,
        candidate,
        note: `workbench scene ${sceneIndex + 1}`,
      })
      const persistedSelection = {
        runId: candidate.runId,
        resourceId: candidate.resourceId,
        selectionId: selection.selectionId,
      }
      await this.dependencies.artifacts.updateReview(taskId, current => ({
        ...current,
        scenes: replaceAt(current.scenes, sceneIndex, nextState),
      }))
      await this.dependencies.artifacts.updateTask(taskId, current => ({
        ...current,
        ...(current.stage === 'failed' && current.failure?.code === 'selection_required'
          ? {
              renderId: null,
              formalReservations: current.formalReservations.filter(value => value.sceneIndex !== sceneIndex),
              sources: current.sources.filter(value => value.sceneIndex !== sceneIndex),
              output: undefined,
            }
          : {}),
        scenes: replaceAt(current.scenes, sceneIndex, {
          ...current.scenes[sceneIndex],
          selected: persistedSelection,
          confirmed: confirmed ? { ...persistedSelection } : null,
        }),
        stage: 'review',
        failure: undefined,
      }))
      this.events.publish(taskId, 'review', confirmed ? 'Scene selection confirmed' : 'Scene selection changed', sceneIndex)
      return this.view(taskId)
    })
  }

  async get(taskId: string): Promise<WorkbenchTaskView> {
    return this.view(taskId)
  }

  async list(): Promise<WorkbenchTaskView[]> {
    const tasks = await this.dependencies.artifacts.listTasks()
    return Promise.all(tasks.map(task => this.view(task.taskId)))
  }

  produce(taskId: string): Promise<void> {
    return withProductionLock(() => this.withTaskLock(taskId, async () => {
      const manifest = await this.dependencies.artifacts.readTask(taskId)
      if (manifest.stage === 'completed') return
      const scenes = await this.confirmedScenes(manifest)
      if (scenes === null) {
        this.events.publish(taskId, 'review', 'All scene selections must be confirmed')
        throw new WorkbenchTaskError('selection_required', 'Scene selection is required', true)
      }
      if (manifest.stage !== 'review') throw new WorkbenchTaskError('task_not_ready', 'Task is not ready', false)
      await this.dependencies.artifacts.updateTask(taskId, current => ({
        ...current,
        stage: 'starting',
        failure: undefined,
      }))
      this.events.publish(taskId, 'starting', 'Starting video production')
      await this.runProduction(taskId, scenes)
    }))
  }

  async resume(taskId: string): Promise<void> {
    const initial = await this.dependencies.artifacts.readTask(taskId)
    if (initial.stage === 'completed') return
    if (initial.stage === 'planning' || initial.stage === 'review') {
      await this.withTaskLock(taskId, () => this.resumeReview(initial))
      return
    }
    await withProductionLock(() => this.withTaskLock(taskId, async () => {
      let manifest = await this.dependencies.artifacts.readTask(taskId)
      let skipRecoveredOutput = false
      if (manifest.stage === 'failed') {
        if (manifest.failure?.retryable !== true) {
          throw new WorkbenchTaskError(
            manifest.failure?.code ?? 'task_failed',
            manifest.failure?.message ?? 'Task cannot be resumed',
            false,
          )
        }
        const recoveredStage = recoverStage(manifest)
        skipRecoveredOutput = manifest.failure.code === 'output_validation_failed'
        manifest = await this.dependencies.artifacts.updateTask(taskId, current => ({
          ...current,
          stage: recoveredStage,
          failure: undefined,
          ...(skipRecoveredOutput ? { output: undefined } : {}),
        }))
        this.events.publish(taskId, recoveredStage, 'Resuming video production')
      }

      let remoteStatus: RemoteRenderStatus | null = null
      if (manifest.renderId !== null) {
        const remote = await this.dependencies.production.startV2(startRequest(manifest))
        if (remote.renderId !== manifest.renderId) throw new WorkbenchTaskError('metadata_failure', 'Video production metadata failed', true)
        remoteStatus = remote.status
        if (remoteStatus === 'completed') {
          if (manifest.output === undefined) throw new WorkbenchTaskError('metadata_failure', 'Completed output is unavailable', false)
          await this.dependencies.artifacts.updateTask(taskId, current => ({ ...current, stage: 'completed' }))
          this.events.publish(taskId, 'completed', 'Video completed')
          return
        }
        if (remoteStatus === 'failed') {
          remoteStatus = (await this.dependencies.production.retryV2(manifest.renderId)).status
        }
      }
      const scenes = await this.confirmedScenes(manifest)
      if (scenes === null) {
        await this.dependencies.artifacts.updateTask(taskId, current => ({
          ...current,
          stage: 'review',
          failure: undefined,
        }))
        throw new WorkbenchTaskError('selection_required', 'Scene selection is required', true)
      }
      let remoteRendering = remoteStatus === 'rendering'
      if ((manifest.stage === 'validating' || manifest.stage === 'completing') && !remoteRendering) {
        const downloadIds = new Map<number, number>()
        await this.ensureDownloadIds(manifest, scenes, downloadIds)
        await this.dependencies.production.beginRenderV2(requiredRenderId(manifest))
        remoteRendering = true
      }
      await this.runProduction(taskId, scenes, { remoteRendering, skipRecoveredOutput })
    }))
  }

  private async loadInitialPage(taskId: string, sceneIndex: number, manifest: WorkbenchManifest): Promise<void> {
    const result = await this.dependencies.loadCandidatePage({
      taskId,
      sceneIndex,
      theme: manifest.scenes[sceneIndex].plan.visualConcept,
      aspectRatio: manifest.aspectRatio,
      page: 1,
    })
    await this.dependencies.artifacts.updateReview(taskId, current => ({
      ...current,
      scenes: replaceAt(current.scenes, sceneIndex, appendCandidatePage(
        current.scenes[sceneIndex], result.candidates, result.hasNextPage,
      )),
    }))
  }

  private async resumeReview(initial: WorkbenchManifest): Promise<void> {
    const review = await this.dependencies.artifacts.readReview(initial.taskId)
    for (let sceneIndex = 0; sceneIndex < initial.sceneCount; sceneIndex += 1) {
      if (review.scenes[sceneIndex].pages.length > 0) continue
      try {
        await this.loadInitialPage(initial.taskId, sceneIndex, initial)
        this.events.publish(initial.taskId, 'planning', 'Scene candidates ready', sceneIndex)
      } catch {
        this.events.publish(initial.taskId, 'planning', 'Scene candidates unavailable', sceneIndex)
      }
    }
    if (initial.stage === 'planning') {
      await this.dependencies.artifacts.updateTask(initial.taskId, current => ({ ...current, stage: 'review' }))
      this.events.publish(initial.taskId, 'review', 'Task ready for review')
    }
  }

  private async runProduction(
    taskId: string,
    scenes: readonly ConfirmedScene[],
    options: { remoteRendering?: boolean; skipRecoveredOutput?: boolean } = {},
  ): Promise<void> {
    const downloadIds = new Map<number, number>()
    let verifiedSources: VerifiedSceneSource[] | undefined
    let remoteRendering = options.remoteRendering ?? false
    try {
      let manifest = await this.dependencies.artifacts.readTask(taskId)
      for (const source of manifest.sources) {
        if (source.downloadId !== undefined) downloadIds.set(source.sceneIndex, source.downloadId)
      }
      if (manifest.stage === 'starting') {
        if (manifest.renderId === null) {
          const started = await this.dependencies.production.startV2(startRequest(manifest))
          if (started.status === 'failed') await this.dependencies.production.retryV2(started.renderId)
          manifest = await this.dependencies.artifacts.updateTask(taskId, current => ({
            ...current,
            renderId: started.renderId,
            stage: started.status === 'completed' && current.output !== undefined ? 'completed' : 'preflight',
          }))
        } else {
          manifest = await this.dependencies.artifacts.updateTask(taskId, current => ({ ...current, stage: 'preflight' }))
        }
        this.events.publish(taskId, manifest.stage, manifest.stage === 'completed' ? 'Video completed' : 'Checking source downloads')
        if (manifest.stage === 'completed') return
      }

      if (manifest.stage === 'preflight') {
        await this.dependencies.preflightSelections({ taskId, scenes })
        this.events.publish(taskId, 'preflight', 'Source preflight passed')
        verifiedSources = await this.dependencies.downloadConfirmedScenes({
          taskId,
          scenes,
          budget: new FormalDownloadBudget(10, taskId),
        })
        manifest = await this.dependencies.artifacts.updateTask(taskId, current => ({ ...current, stage: 'probing' }))
        this.events.publish(taskId, 'probing', 'Source downloads verified')
      }

      if (manifest.stage === 'downloading') {
        verifiedSources = await this.dependencies.downloadConfirmedScenes({
          taskId,
          scenes,
          budget: new FormalDownloadBudget(10, taskId),
        })
        manifest = await this.dependencies.artifacts.updateTask(taskId, current => ({ ...current, stage: 'probing' }))
        this.events.publish(taskId, 'probing', 'Source downloads verified')
      }

      if (manifest.stage === 'probing') {
        verifiedSources ??= await this.dependencies.downloadConfirmedScenes({
          taskId,
          scenes,
          budget: new FormalDownloadBudget(10, taskId),
        })
        for (const verified of verifiedSources) {
          const current = await this.dependencies.artifacts.readTask(taskId)
          if (current.sources.some(source => source.sceneIndex === verified.sceneIndex)) continue
          let probe: MediaProbe
          let source: WorkbenchSource
          try {
            probe = await this.dependencies.probeSource({ taskId, source: verified })
            source = sourceFromProbe(verified, probe)
          } catch (error) {
            if (DETERMINISTIC_SOURCE_ERRORS.has(errorCode(error) ?? '')) {
              throw new WorkbenchTaskError('selection_required', 'Selected source must be replaced', true)
            }
            throw error
          }
          manifest = await this.dependencies.artifacts.updateTask(taskId, latest => ({
            ...latest,
            sources: [...latest.sources, source].sort((left, right) => left.sceneIndex - right.sceneIndex),
            stage: 'probing',
          }))
          const renderId = requiredRenderId(current)
          const recorded = await this.dependencies.production.recordDownloadV2(recordDownloadRequest(renderId, verified, probe))
          downloadIds.set(verified.sceneIndex, recorded.downloadId)
          manifest = await this.dependencies.artifacts.updateTask(taskId, latest => ({
            ...latest,
            sources: latest.sources.map(value => value.sceneIndex === verified.sceneIndex
              ? { ...value, downloadId: recorded.downloadId }
              : value),
            stage: 'probing',
          }))
          this.events.publish(taskId, 'probing', 'Source media verified', verified.sceneIndex)
        }
        manifest = await this.dependencies.artifacts.readTask(taskId)
        await this.ensureDownloadIds(manifest, scenes, downloadIds, verifiedSources)
        manifest = await this.dependencies.artifacts.updateTask(taskId, current => ({ ...current, stage: 'rendering' }))
        this.events.publish(taskId, 'rendering', 'Rendering silent video')
      }

      if (manifest.stage === 'rendering') {
        const recovered = options.skipRecoveredOutput ? null : await this.dependencies.recoverOutput(taskId)
        if (recovered !== null && !remoteRendering) {
          await this.ensureDownloadIds(manifest, scenes, downloadIds)
          await this.dependencies.production.beginRenderV2(requiredRenderId(manifest))
          remoteRendering = true
        }
        const output = recovered ?? await this.render(manifest, remoteRendering)
        remoteRendering = true
        manifest = await this.dependencies.artifacts.updateTask(taskId, current => ({
          ...current,
          output,
          stage: 'validating',
        }))
        this.events.publish(taskId, 'validating', recovered === null ? 'Validating rendered video' : 'Recovered rendered video')
      }

      if (manifest.stage === 'validating') {
        if (manifest.output === undefined) throw new Error('rendered output is unavailable')
        try {
          await this.dependencies.validateOutput({ taskId, output: manifest.output })
        } catch (error) {
          if (DETERMINISTIC_OUTPUT_ERRORS.has(errorCode(error) ?? '')) {
            throw new WorkbenchTaskError('output_validation_failed', 'Rendered video validation failed', true)
          }
          throw error
        }
        manifest = await this.dependencies.artifacts.updateTask(taskId, current => ({ ...current, stage: 'completing' }))
        this.events.publish(taskId, 'completing', 'Recording completion metadata')
      }

      if (manifest.stage === 'completing') {
        if (manifest.output === undefined) throw new Error('rendered output is unavailable')
        await this.ensureDownloadIds(manifest, scenes, downloadIds)
        const timeline = timelineFor(manifest)
        await this.dependencies.production.completeV2({
          renderId: requiredRenderId(manifest),
          segments: timeline.map((scene, index) => ({
            segmentIndex: index,
            downloadId: requiredDownloadId(downloadIds, index),
            timelineStartMs: scene.startMs,
            timelineEndMs: scene.endMs,
            sourceInMs: scene.sourceInMs,
            sourceOutMs: scene.sourceInMs + scene.durationMs,
            captionEn: scene.captionEn,
            captionZh: scene.captionZh,
            sourceTrackId: manifest.passage.trackId,
            sourceCueIndex: manifest.scenes[index].cueIndex,
          })),
          // This is the hash of the persisted, pre-request `completing` manifest. The remote
          // transaction stores it atomically with completion; hashing a later local state would race it.
          output: completionOutput(manifest.output, await this.dependencies.manifestSha256(taskId)),
        })
        await this.dependencies.artifacts.updateTask(taskId, current => ({ ...current, stage: 'completed' }))
        this.events.publish(taskId, 'completed', 'Video completed')
      }
    } catch (error) {
      await this.persistFailure(taskId, error)
      throw classifiedError(error, await this.dependencies.artifacts.readTask(taskId))
    }
  }

  private async render(manifest: WorkbenchManifest, remoteRendering = false): Promise<WorkbenchOutput> {
    const timeline = timelineFor(manifest)
    const releaseYear = manifest.passage.movie.releaseYear
    if (!Number.isSafeInteger(releaseYear)) throw new Error('movie release year is unavailable')
    const assText = buildDynamicAssSubtitles(
      dynamicScenes(manifest),
      timeline,
      renderConfiguration(manifest),
      {
        movieTitle: manifest.passage.movie.title,
        releaseYear: releaseYear as number,
        cueTimestamps: manifest.passage.cues.map(cue => cue.timestamp),
      },
    )
    const renderId = requiredRenderId(manifest)
    if (!remoteRendering) await this.dependencies.production.beginRenderV2(renderId)
    return this.dependencies.renderVideo({
      taskId: manifest.taskId,
      renderId,
      sources: manifest.sources,
      timeline,
      assText,
      width: manifest.width,
      height: manifest.height,
      frameRate: 30,
    })
  }

  private async ensureDownloadIds(
    manifest: WorkbenchManifest,
    scenes: readonly ConfirmedScene[],
    downloadIds: Map<number, number>,
    knownVerified?: readonly VerifiedSceneSource[],
  ): Promise<void> {
    for (const source of manifest.sources) {
      if (source.downloadId !== undefined) downloadIds.set(source.sceneIndex, source.downloadId)
    }
    const missing = manifest.sources.filter(source => !downloadIds.has(source.sceneIndex))
    if (missing.length === 0) return
    const verified = knownVerified ?? await this.dependencies.downloadConfirmedScenes({
        taskId: manifest.taskId,
        scenes,
        budget: new FormalDownloadBudget(10, manifest.taskId),
      })
    for (const source of missing) {
      const metadata = verified.find(value => value.sceneIndex === source.sceneIndex)
      if (metadata === undefined) throw new Error('source metadata is unavailable')
      const recorded = await this.dependencies.production.recordDownloadV2(recordDownloadRequest(
        requiredRenderId(manifest),
        metadata,
        probeFromSource(source),
      ))
      downloadIds.set(source.sceneIndex, recorded.downloadId)
      await this.dependencies.artifacts.updateTask(manifest.taskId, current => ({
        ...current,
        sources: current.sources.map(value => value.sceneIndex === source.sceneIndex
          ? { ...value, downloadId: recorded.downloadId }
          : value),
      }))
    }
  }

  private async confirmedScenes(manifest: WorkbenchManifest): Promise<ConfirmedScene[] | null> {
    const review = await this.dependencies.artifacts.readReview(manifest.taskId)
    const result: ConfirmedScene[] = []
    for (let index = 0; index < manifest.sceneCount; index += 1) {
      const scene = manifest.scenes[index]
      const candidates = review.scenes[index]
      if (scene.selected === null || scene.confirmed === null
        || candidates.selected === undefined || candidates.confirmed === undefined
        || !sameCandidate(scene.selected, scene.confirmed)
        || !sameCandidate(scene.selected, candidates.selected)
        || !sameCandidate(scene.confirmed, candidates.confirmed)) return null
      result.push({ index, selected: scene.selected, confirmed: scene.confirmed, candidates })
    }
    return result
  }

  private async persistFailure(taskId: string, error: unknown): Promise<void> {
    const current = await this.dependencies.artifacts.readTask(taskId)
    if (current.stage === 'failed' && current.failure?.retryable === false) return
    const failure = classifyFailure(error, current.stage)
    const failed = await this.dependencies.artifacts.updateTask(taskId, manifest => ({
      ...manifest,
      stage: 'failed',
      failure,
    })).catch(() => undefined)
    if (failed?.renderId !== null && failed?.renderId !== undefined) {
      await this.dependencies.production.failV2({
        renderId: failed.renderId,
        failureCode: remoteFailureCode(failure.code),
        failureMessage: failure.message,
      }).catch(() => undefined)
    }
    this.events.publish(taskId, 'failed', failure.message)
  }

  private async view(taskId: string): Promise<WorkbenchTaskView> {
    const [manifest, review] = await Promise.all([
      this.dependencies.artifacts.readTask(taskId),
      this.dependencies.artifacts.readReview(taskId),
    ])
    return {
      taskId: manifest.taskId,
      theme: manifest.theme,
      aspectRatio: manifest.aspectRatio,
      width: manifest.width,
      height: manifest.height,
      sceneCount: manifest.sceneCount,
      stage: manifest.stage,
      passage: structuredClone(manifest.passage),
      scenes: manifest.scenes.map((scene, index) => {
        const candidates = review.scenes[index]
        return {
          index,
          cueIndex: scene.cueIndex,
          durationMs: scene.durationMs,
          captionEn: scene.captionEn,
          captionZh: scene.plan.captionZh,
          visualConcept: scene.plan.visualConcept,
          candidates: structuredClone(candidates.pages.flat()),
          candidateStatus: candidates.pages.length === 0
            ? 'unavailable'
            : candidates.hasNextPage ? 'ready' : 'exhausted',
          hasNextPage: candidates.hasNextPage,
          selected: candidates.selected === undefined ? null : { ...candidates.selected },
          confirmed: candidates.confirmed === undefined ? null : { ...candidates.confirmed },
          recommended: candidates.recommended === undefined ? null : { ...candidates.recommended },
        }
      }),
      ...(manifest.failure === undefined ? {} : { failure: { ...manifest.failure } }),
      ...(manifest.output === undefined ? {} : {
        output: {
          endpoint: `/api/tasks/${manifest.taskId}/final`,
          basename: 'final.mp4' as const,
          sha256: manifest.output.sha256,
          sizeBytes: manifest.output.sizeBytes,
          durationMs: manifest.output.durationMs,
          width: manifest.output.width,
          height: manifest.output.height,
          frameRate: manifest.output.frameRate,
          videoCodec: manifest.output.videoCodec,
          pixelFormat: manifest.output.pixelFormat,
          audioCodec: null,
        },
      }),
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
    }
  }

  private withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    if (!UUID.test(taskId)) return Promise.reject(new Error('invalid_workbench_task_id'))
    const lockKey = taskId.toLowerCase()
    const previous = processTaskLocks.get(lockKey) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const settled = result.then(() => undefined, () => undefined)
    processTaskLocks.set(lockKey, settled)
    return result.finally(() => {
      if (processTaskLocks.get(lockKey) === settled) processTaskLocks.delete(lockKey)
    })
  }
}

function emptyCandidateState(): SceneCandidateState {
  return { pages: [], hasNextPage: true }
}

function replaceAt<T>(values: readonly T[], index: number, value: T): T[] {
  return values.map((current, currentIndex) => currentIndex === index ? value : current)
}

function validateCreateInput(input: CreateTaskInput): void {
  if (typeof input.theme !== 'string'
    || input.theme.trim() === ''
    || input.theme.trim().length > 300
    || (input.aspectRatio !== '9:16' && input.aspectRatio !== '16:9')
    || !Number.isSafeInteger(input.sceneCount)
    || input.sceneCount < 5
    || input.sceneCount > 10
    || (input.sourceAnchor !== undefined && !validSourceAnchor(input.sourceAnchor))) {
    throw new Error('invalid_workbench_task_input')
  }
}

function validSourceAnchor(value: unknown): value is PassageSourceAnchor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const anchor = value as Record<string, unknown>
  const keys = Object.keys(anchor).sort()
  return keys.length === 3
    && keys[0] === 'firstCueIndex'
    && keys[1] === 'lastCueIndex'
    && keys[2] === 'trackId'
    && Number.isSafeInteger(anchor.trackId)
    && (anchor.trackId as number) > 0
    && Number.isSafeInteger(anchor.firstCueIndex)
    && (anchor.firstCueIndex as number) >= 0
    && Number.isSafeInteger(anchor.lastCueIndex)
    && (anchor.lastCueIndex as number) >= (anchor.firstCueIndex as number)
}

function assertReviewable(manifest: WorkbenchManifest, sceneIndex: number): void {
  if (manifest.stage !== 'review' && !(manifest.stage === 'failed' && manifest.failure?.code === 'selection_required')) {
    throw new Error('workbench_task_not_reviewable')
  }
  if (!Number.isSafeInteger(sceneIndex) || sceneIndex < 0 || sceneIndex >= manifest.sceneCount) {
    throw new Error('invalid_workbench_scene_index')
  }
}

function withProductionLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = productionTail.catch(() => undefined).then(operation)
  productionTail = result.then(() => undefined, () => undefined)
  return result
}

function startRequest(manifest: WorkbenchManifest) {
  return {
    requestDigest: manifest.requestDigest,
    theme: manifest.theme,
    aspectRatio: manifest.aspectRatio,
    width: manifest.width,
    height: manifest.height,
    sceneCount: manifest.sceneCount,
    sourceTrackId: manifest.passage.trackId,
    sourceStartCueIndex: manifest.passage.startCueIndex,
    sourceEndCueIndex: manifest.passage.endCueIndex,
    expectedDurationMs: manifest.passage.totalDurationMs,
  }
}

function sourceFromProbe(source: VerifiedSceneSource, probe: MediaProbe): WorkbenchSource {
  if (probe.sizeBytes !== source.sourceSizeBytes) {
    throw Object.assign(new Error('source size changed after download'), { code: 'source_size_mismatch' })
  }
  return {
    sceneIndex: source.sceneIndex,
    reservationId: source.reservationId,
    selectionId: source.selectionId,
    artifactKey: source.artifactKey,
    sha256: source.sourceSha256,
    sizeBytes: source.sourceSizeBytes,
    width: probe.width,
    height: probe.height,
    durationMs: probe.durationMs,
    frameRate: probe.frameRate,
    videoCodec: probe.videoCodec,
    audioCodec: probe.audioCodec,
  }
}

function probeFromSource(source: WorkbenchSource): MediaProbe {
  return {
    durationMs: source.durationMs,
    sizeBytes: source.sizeBytes,
    width: source.width,
    height: source.height,
    frameRate: source.frameRate,
    videoCodec: source.videoCodec,
    audioCodec: source.audioCodec,
    pixelFormat: 'yuv420p',
    audioSampleRate: null,
    audioChannels: null,
  }
}

function recordDownloadRequest(renderId: string, source: VerifiedSceneSource, probe: MediaProbe) {
  return {
    renderId,
    selectionId: source.selectionId,
    reservationId: source.reservationId,
    artifactKey: source.artifactKey,
    fileType: 'mp4' as const,
    sourceSizeBytes: source.sourceSizeBytes,
    sourceSha256: source.sourceSha256,
    width: probe.width,
    height: probe.height,
    durationMs: probe.durationMs,
    frameRate: probe.frameRate,
    videoCodec: probe.videoCodec,
    audioCodec: probe.audioCodec,
    requiresAttribution: source.requiresAttribution,
    requiredAttributionUrl: source.requiredAttributionUrl,
    quotaLimit: source.quota.limit,
    quotaRemaining: source.quota.remaining,
  }
}

function renderConfiguration(manifest: WorkbenchManifest): DynamicRenderConfiguration {
  return {
    width: manifest.width as 1080 | 1920,
    height: manifest.height as 1080 | 1920,
    frameRate: 30 as const,
    transitionMs: 300,
  }
}

function dynamicScenes(manifest: WorkbenchManifest) {
  return manifest.scenes.map(scene => ({
    index: scene.index,
    durationMs: scene.durationMs,
    captionEn: scene.captionEn,
    captionZh: scene.plan.captionZh,
    sourceInMs: 0,
  }))
}

function timelineFor(manifest: WorkbenchManifest): TimelineScene[] {
  return buildDynamicTimeline(dynamicScenes(manifest), renderConfiguration(manifest))
}

function completionOutput(
  output: WorkbenchOutput,
  manifestSha256: string,
): CompleteRenderV2Request['output'] {
  if (!SHA256.test(manifestSha256)) throw new Error('invalid workbench manifest hash')
  return {
    artifactKey: output.artifactKey,
    outputSha256: output.sha256,
    outputSizeBytes: output.sizeBytes,
    outputDurationMs: output.durationMs,
    width: output.width,
    height: output.height,
    videoCodec: output.videoCodec,
    audioCodec: null,
    pixelFormat: output.pixelFormat,
    ffmpegVersion: output.ffmpegVersion,
    manifestSha256,
  }
}

function requiredRenderId(manifest: WorkbenchManifest): string {
  if (manifest.renderId === null) throw new Error('render ownership is unavailable')
  return manifest.renderId
}

function requiredDownloadId(values: ReadonlyMap<number, number>, sceneIndex: number): number {
  const value = values.get(sceneIndex)
  if (!Number.isSafeInteger(value) || value === undefined || value <= 0) throw new Error('download metadata is unavailable')
  return value
}

function sameCandidate(
  left: { runId: string; resourceId: number },
  right: { runId: string; resourceId: number },
): boolean {
  return left.runId === right.runId && left.resourceId === right.resourceId
}

function recoverStage(manifest: WorkbenchManifest): WorkbenchStage {
  if (manifest.renderId === null) return 'starting'
  if (manifest.formalReservations.length < manifest.sceneCount) {
    return manifest.formalReservations.length === 0 ? 'preflight' : 'downloading'
  }
  if (manifest.sources.length < manifest.sceneCount) return 'probing'
  if (manifest.failure?.code === 'output_validation_failed') return 'rendering'
  if (manifest.output === undefined) return 'rendering'
  return manifest.failure?.code === 'render_failure' ? 'validating' : 'completing'
}

function classifyFailure(error: unknown, stage: WorkbenchStage) {
  if (error instanceof WorkbenchTaskError) {
    return { code: error.code, message: error.message, retryable: error.retryable }
  }
  if (stage === 'failed') {
    return { code: 'task_failed', message: 'Video production failed', retryable: false }
  }
  if (stage === 'starting' || stage === 'completing') {
    return { code: 'metadata_failure', message: 'Video production metadata failed', retryable: true }
  }
  if (stage === 'preflight' || stage === 'downloading') {
    const code = errorCode(error)
    if (code === 'formal_call_uncertain') {
      return { code, message: 'Formal download outcome is uncertain', retryable: false }
    }
    if (stage === 'preflight' && SELECTION_REQUIRED_CODES.has(code ?? '')) {
      return { code: 'selection_required', message: 'Selected source must be replaced', retryable: true }
    }
    return { code: 'download_failure', message: 'Video source download failed', retryable: true }
  }
  if (stage === 'probing') {
    return { code: 'source_validation_failure', message: 'Video source validation failed', retryable: true }
  }
  return { code: 'render_failure', message: 'Video production failed', retryable: true }
}

function classifiedError(error: unknown, manifest: WorkbenchManifest): WorkbenchTaskError {
  if (error instanceof WorkbenchTaskError) return error
  const failure = manifest.failure ?? classifyFailure(error, manifest.stage)
  return new WorkbenchTaskError(failure.code, failure.message, failure.retryable)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function remoteFailureCode(code: string): 'download_failure' | 'source_validation_failure' | 'render_failure' | 'metadata_failure' {
  if (code === 'download_failure' || code === 'source_validation_failure' || code === 'metadata_failure') return code
  if (code === 'selection_required') return 'download_failure'
  return 'render_failure'
}

const SELECTION_REQUIRED_CODES = new Set([
  'file_size_limit_exceeded',
  'aggregate_size_limit_exceeded',
  'resource_changed',
])

const DETERMINISTIC_SOURCE_ERRORS = new Set([
  'invalid_media_probe',
  'source_size_mismatch',
  'unsupported_source_media',
])

const DETERMINISTIC_OUTPUT_ERRORS = new Set([
  'invalid_final_media',
  'output_hash_mismatch',
  'output_file_mismatch',
])

type RemoteRenderStatus = 'planned' | 'downloading' | 'rendering' | 'completed' | 'failed'
