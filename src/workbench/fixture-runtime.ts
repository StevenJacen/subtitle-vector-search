import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { WorkbenchHealthReport } from './health.js'
import { WorkbenchEventBus } from './events.js'
import type { WorkbenchHttpTaskService } from './http-server.js'
import type {
  HybridSubtitleSearchResult,
  SubtitleLibrarySummary,
  SubtitleSearchRequest,
  SubtitleSearchResponse,
} from './subtitle-library.js'
import {
  SubtitleSyncEventBus,
  type SubtitleSyncInput,
  type SubtitleSyncSnapshot,
  type SubtitleSyncStatus,
} from './subtitle-sync.js'
import { WorkbenchTaskError, type CandidateIdentity, type CreateTaskInput, type WorkbenchTaskView } from './task-service.js'

interface FixtureTaskServiceOptions {
  productionDelayMs?: number
  outputMetadata?: (aspectRatio: CreateTaskInput['aspectRatio']) => Promise<{
    sha256: string
    sizeBytes: number
    durationMs: number
  }>
}

interface FixtureRuntime {
  taskService: WorkbenchHttpTaskService
  previews: { resolve(previewId: string): string | undefined }
  health(): Promise<WorkbenchHealthReport>
  resolveFinalPath(taskId: string): Promise<string | null>
  subtitleLibrary: FixtureSubtitleLibraryService
  subtitleSync: FixtureSubtitleSyncController
  previewFetcher: typeof fetch
  lookupPreviewHost(hostname: string): Promise<string[]>
}

interface FixtureSubtitleLibraryService {
  search(input: SubtitleSearchRequest): Promise<SubtitleSearchResponse>
  summary(): Promise<SubtitleLibrarySummary>
}

interface FixtureSubtitleTrack {
  trackId: number
  movie: { id: number; title: string; releaseYear: number | null }
  firstCueIndex: number
  lastCueIndex: number
  firstCueStartMs: number
  cueDurationMs: number
}

const PRODUCTION_STAGES = [
  'preflight',
  'downloading',
  'probing',
  'rendering',
  'validating',
  'completing',
] as const

const FIXTURE_SUBTITLE_RESULTS: HybridSubtitleSearchResult[] = [
  {
    similarity: 0.94,
    rrfScore: 0.061,
    semanticRank: 1,
    fullTextRank: 2,
    movie: { id: 1, title: 'The Shawshank Redemption', releaseYear: 1994 },
    trackId: 4_101,
    chunkIndex: 27,
    startMs: 372_000,
    endMs: 380_400,
    timestamp: '00:06:12.000 --> 00:06:20.400',
    text: 'Hope is a good thing, maybe the best of things.',
    cues: [
      { index: 812, startMs: 372_000, endMs: 374_800, text: 'Hope is a good thing,' },
      { index: 813, startMs: 374_800, endMs: 377_600, text: 'maybe the best of things,' },
      { index: 814, startMs: 377_600, endMs: 380_400, text: 'and no good thing ever dies.' },
    ],
  },
  {
    similarity: 0.89,
    rrfScore: 0.048,
    semanticRank: 2,
    fullTextRank: 1,
    movie: { id: 2, title: 'Dead Poets Society', releaseYear: 1989 },
    trackId: 4_201,
    chunkIndex: 11,
    startMs: 541_000,
    endMs: 549_400,
    timestamp: '00:09:01.000 --> 00:09:09.400',
    text: 'Carpe diem. Seize the day, boys.',
    cues: [
      { index: 232, startMs: 541_000, endMs: 543_800, text: 'Carpe diem.' },
      { index: 233, startMs: 543_800, endMs: 546_600, text: 'Seize the day, boys.' },
      { index: 234, startMs: 546_600, endMs: 549_400, text: 'Make your lives extraordinary.' },
    ],
  },
  {
    similarity: 0.83,
    rrfScore: 0.037,
    semanticRank: 3,
    fullTextRank: null,
    movie: { id: 3, title: 'Casablanca', releaseYear: 1942 },
    trackId: 4_301,
    chunkIndex: 8,
    startMs: 684_000,
    endMs: 692_400,
    timestamp: '00:11:24.000 --> 00:11:32.400',
    text: 'We will always have Paris.',
    cues: [
      { index: 0, startMs: 684_000, endMs: 686_800, text: 'We will always have Paris.' },
      { index: 1, startMs: 686_800, endMs: 689_600, text: 'This is the beginning' },
      { index: 2, startMs: 689_600, endMs: 692_400, text: 'of a beautiful friendship.' },
    ],
  },
]

const FIXTURE_SUBTITLE_TRACKS: FixtureSubtitleTrack[] = [
  {
    trackId: 4_101,
    movie: { id: 1, title: 'The Shawshank Redemption', releaseYear: 1994 },
    firstCueIndex: 800,
    lastCueIndex: 1_000,
    firstCueStartMs: 338_400,
    cueDurationMs: 2_800,
  },
  {
    trackId: 4_102,
    movie: { id: 1, title: 'The Shawshank Redemption', releaseYear: 1994 },
    firstCueIndex: 0,
    lastCueIndex: 600,
    firstCueStartMs: 0,
    cueDurationMs: 2_800,
  },
  {
    trackId: 4_201,
    movie: { id: 2, title: 'Dead Poets Society', releaseYear: 1989 },
    firstCueIndex: 200,
    lastCueIndex: 400,
    firstCueStartMs: 451_400,
    cueDurationMs: 2_800,
  },
  {
    trackId: 4_301,
    movie: { id: 3, title: 'Casablanca', releaseYear: 1942 },
    firstCueIndex: 0,
    lastCueIndex: 500,
    firstCueStartMs: 684_000,
    cueDurationMs: 2_800,
  },
]

export function assertWorkbenchFixtureMode(
  environment: Record<string, string | undefined>,
): boolean {
  if (environment.WORKBENCH_FIXTURE_MODE !== '1') return false
  if (environment.NODE_ENV !== 'test') {
    throw new Error('workbench fixture mode requires NODE_ENV=test')
  }
  return true
}

export function createWorkbenchFixtureTaskService(
  options: FixtureTaskServiceOptions = {},
): WorkbenchHttpTaskService {
  const events = new WorkbenchEventBus()
  const tasks = new Map<string, WorkbenchTaskView>()
  const failedOnce = new Set<string>()
  const delayMs = options.productionDelayMs ?? 80
  let clock = Date.now()

  const timestamp = (): string => new Date(clock += 1).toISOString()
  const requiredTask = (taskId: string): WorkbenchTaskView => {
    const task = tasks.get(taskId)
    if (task === undefined) throw new WorkbenchTaskError('task_not_found', 'Task not found', false)
    return task
  }
  const store = (task: WorkbenchTaskView): WorkbenchTaskView => {
    const next = structuredClone({ ...task, updatedAt: timestamp() })
    tasks.set(task.taskId, next)
    return structuredClone(next)
  }
  const setStage = (taskId: string, stage: WorkbenchTaskView['stage'], message: string): void => {
    const task = requiredTask(taskId)
    tasks.set(taskId, structuredClone({ ...task, stage, failure: undefined, updatedAt: timestamp() }))
    events.publish(taskId, stage, message)
  }
  const finishProduction = async (taskId: string, resumed: boolean): Promise<void> => {
    for (const stage of PRODUCTION_STAGES) {
      await delay(delayMs)
      setStage(taskId, stage, `Fixture ${stage}`)
      const task = requiredTask(taskId)
      if (stage === 'rendering' && !resumed && shouldFailOnce(task.theme) && !failedOnce.has(taskId)) {
        failedOnce.add(taskId)
        const failed = store({
          ...task,
          stage: 'failed',
          failure: {
            code: 'fixture_render_interrupted',
            message: '测试渲染已中断，可从当前阶段恢复',
            retryable: true,
          },
        })
        events.publish(taskId, 'failed', failed.failure?.message ?? 'Fixture failed')
        return
      }
    }
    const task = requiredTask(taskId)
    const metadata = await (options.outputMetadata?.(task.aspectRatio) ?? Promise.resolve({
      sha256: createHash('sha256').update(`fixture:${task.aspectRatio}`).digest('hex'),
      sizeBytes: 1_048_576,
      durationMs: 1_000,
    }))
    const completed = store({
      ...task,
      stage: 'completed',
      failure: undefined,
      output: {
        endpoint: `/api/tasks/${taskId}/final`,
        basename: 'final.mp4',
        sha256: metadata.sha256,
        sizeBytes: metadata.sizeBytes,
        durationMs: metadata.durationMs,
        width: task.width,
        height: task.height,
        frameRate: 30,
        videoCodec: 'h264',
        pixelFormat: 'yuv420p',
        audioCodec: null,
      },
    })
    events.publish(taskId, completed.stage, 'Fixture video completed')
  }

  return {
    events,
    async list() {
      return [...tasks.values()]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(task => structuredClone(task))
    },
    async create(input) {
      validateCreateInput(input)
      const taskId = randomUUID()
      const createdAt = timestamp()
      const passage = fixturePassage(input)
      const cues = passage.cues
      const task: WorkbenchTaskView = {
        taskId,
        theme: input.theme.trim(),
        aspectRatio: input.aspectRatio,
        ...(input.aspectRatio === '16:9'
          ? { width: 1920, height: 1080 }
          : { width: 1080, height: 1920 }),
        sceneCount: input.sceneCount,
        stage: 'review',
        passage,
        scenes: cues.map((cue, index) => ({
          index,
          cueIndex: cue.cueIndex,
          durationMs: cue.endMs - cue.startMs,
          captionEn: cue.text,
          captionZh: fixtureTranslation(index),
          visualConcept: fixtureConcept(index),
          candidates: fixtureCandidates(index, 1),
          candidateStatus: 'ready' as const,
          hasNextPage: true,
          selected: null,
          confirmed: null,
          recommended: null,
        })).map(scene => ({
          ...scene,
          recommended: {
            runId: scene.candidates[0].runId,
            resourceId: scene.candidates[0].resourceId,
          },
        })),
        createdAt,
        updatedAt: createdAt,
      }
      tasks.set(taskId, structuredClone(task))
      return structuredClone(task)
    },
    async get(taskId) {
      return structuredClone(requiredTask(taskId))
    },
    async loadMore(taskId, sceneIndex) {
      const task = requiredTask(taskId)
      const scene = task.scenes[sceneIndex]
      if (scene === undefined || task.stage !== 'review') {
        throw new WorkbenchTaskError('task_not_reviewable', 'Task is not reviewable', false)
      }
      const page = Math.floor(scene.candidates.length / 8) + 1
      if (page > 3) return structuredClone(task)
      const scenes = task.scenes.map(value => value.index === sceneIndex
        ? {
            ...value,
            candidates: deduplicate([...value.candidates, ...fixtureCandidates(sceneIndex, page)]),
            hasNextPage: page < 3,
            candidateStatus: page < 3 ? 'ready' as const : 'exhausted' as const,
          }
        : value)
      return store({ ...task, scenes })
    },
    async select(taskId, sceneIndex, candidate: CandidateIdentity, confirmed) {
      const task = requiredTask(taskId)
      const scene = task.scenes[sceneIndex]
      if (scene === undefined || task.stage !== 'review') {
        throw new WorkbenchTaskError('task_not_reviewable', 'Task is not reviewable', false)
      }
      const known = scene.candidates.find(value => sameCandidate(value, candidate))
      if (known === undefined) throw new WorkbenchTaskError('candidate_not_found', 'Candidate not found', false)
      const selected = { runId: known.runId, resourceId: known.resourceId }
      const scenes = task.scenes.map(value => value.index === sceneIndex
        ? { ...value, selected, confirmed: confirmed ? selected : null }
        : value)
      return store({ ...task, scenes })
    },
    async produce(taskId) {
      const task = requiredTask(taskId)
      if (task.stage === 'completed') return
      if (task.stage !== 'review') throw new WorkbenchTaskError('task_not_ready', 'Task is not ready', false)
      if (!allConfirmed(task)) throw new WorkbenchTaskError('selection_required', 'Scene selection is required', true)
      setStage(taskId, 'starting', 'Fixture production started')
      void finishProduction(taskId, false)
    },
    async resume(taskId) {
      const task = requiredTask(taskId)
      if (task.stage === 'completed') return
      if (task.stage !== 'failed' || task.failure?.retryable !== true) {
        throw new WorkbenchTaskError('task_not_resumable', 'Task cannot be resumed', false)
      }
      setStage(taskId, 'starting', 'Fixture production resumed')
      void finishProduction(taskId, true)
    },
  }
}

export async function createWorkbenchFixtureRuntime(artifactRoot: string): Promise<FixtureRuntime> {
  const root = resolve(artifactRoot, '.workbench-fixtures')
  const finalPaths = {
    '9:16': resolve(root, 'portrait', 'final.mp4'),
    '16:9': resolve(root, 'landscape', 'final.mp4'),
  } as const
  await Promise.all([
    ensureSilentFixtureVideo(finalPaths['9:16'], 1080, 1920),
    ensureSilentFixtureVideo(finalPaths['16:9'], 1920, 1080),
  ])
  const metadata = new Map<CreateTaskInput['aspectRatio'], Awaited<ReturnType<typeof mediaMetadata>>>()
  for (const aspectRatio of ['9:16', '16:9'] as const) {
    metadata.set(aspectRatio, await mediaMetadata(finalPaths[aspectRatio]))
  }
  const taskService = createWorkbenchFixtureTaskService({
    outputMetadata: async aspectRatio => requiredMapValue(metadata, aspectRatio),
  })
  const previewIds = new Set<string>()
  const originalCreate = taskService.create.bind(taskService)
  taskService.create = async input => {
    const task = await originalCreate(input)
    for (const candidate of task.scenes.flatMap(scene => scene.candidates)) {
      if (candidate.previewId !== null) previewIds.add(candidate.previewId)
    }
    return task
  }
  const originalLoadMore = taskService.loadMore.bind(taskService)
  taskService.loadMore = async (taskId, sceneIndex) => {
    const task = await originalLoadMore(taskId, sceneIndex)
    for (const candidate of task.scenes[sceneIndex]?.candidates ?? []) {
      if (candidate.previewId !== null) previewIds.add(candidate.previewId)
    }
    return task
  }
  const subtitleLibrary = createFixtureSubtitleLibraryService()
  const subtitleSync = new FixtureSubtitleSyncController()

  return {
    taskService,
    subtitleLibrary,
    subtitleSync,
    previews: {
      resolve(previewId) {
        return previewIds.has(previewId) ? 'https://media.vecteezy.com/fixture-preview.mp4' : undefined
      },
    },
    async health() {
      return {
        status: 'ok',
        checks: [
          { id: 'supabase', status: 'ok', message: 'Fixture Supabase ready' },
          { id: 'ollama', status: 'ok', message: 'Fixture Ollama ready', details: { model: 'fixture-model' } },
          { id: 'vecteezy', status: 'ok', message: 'Fixture Vecteezy ready', details: { quotaLimit: 200, quotaRemaining: 200 } },
          { id: 'ffmpeg', status: 'ok', message: 'FFmpeg ready' },
          { id: 'ffprobe', status: 'ok', message: 'ffprobe ready' },
          { id: 'font', status: 'ok', message: 'Fixture font ready' },
          { id: 'disk', status: 'ok', message: 'Fixture disk ready', details: { freeBytes: 10_000_000_000 } },
        ],
        warnings: [{ code: 'ollama_plaintext_dialogue', message: 'Fixture plaintext warning' }],
      }
    },
    async resolveFinalPath(taskId) {
      const task = await taskService.get(taskId).catch(() => null)
      return task?.stage === 'completed' ? finalPaths[task.aspectRatio] : null
    },
    async previewFetcher(_input, init) {
      const body = await readFile(finalPaths['16:9'])
      const range = typeof init?.headers === 'object' && init.headers !== null && !Array.isArray(init.headers)
        ? (init.headers as Record<string, string>).range
        : undefined
      const selected = fixtureRange(body, range)
      return new Response(Uint8Array.from(selected.body).buffer, {
        status: selected.status,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(selected.body.length),
          'accept-ranges': 'bytes',
          ...(selected.contentRange === undefined ? {} : { 'content-range': selected.contentRange }),
        },
      })
    },
    async lookupPreviewHost() {
      return ['8.8.8.8']
    },
  }
}

function createFixtureSubtitleLibraryService(): FixtureSubtitleLibraryService {
  return {
    async summary() {
      return { readyTracks: 4, readyMovies: 3 }
    },
    async search(input) {
      const query = typeof input.query === 'string' ? input.query.trim() : ''
      if (query.length === 0 || query.length > 500
        || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50) {
        throw new Error('invalid subtitle library fixture search')
      }
      return structuredClone({
        originalQuery: query,
        normalizedQuery: /\p{Script=Han}/u.test(query) ? 'hope and freedom' : query,
        warning: null,
        results: FIXTURE_SUBTITLE_RESULTS.slice(0, input.limit),
      })
    },
  }
}

class FixtureSubtitleSyncController {
  readonly events = new SubtitleSyncEventBus()

  private current = fixtureIdleSyncSnapshot('2026-07-22T00:00:00.000Z')
  private running: Promise<void> | null = null
  private stopRequested = false
  private jobNumber = 0
  private clock = Date.parse('2026-07-22T00:00:00.000Z')

  start(input: SubtitleSyncInput): Promise<SubtitleSyncSnapshot> {
    if (this.running !== null) throw new Error('subtitle_sync_already_running')
    assertFixtureSyncInput(input)
    this.stopRequested = false
    const startedAt = this.timestamp()
    this.current = {
      jobId: `fixture-sync-${++this.jobNumber}`,
      mode: input.mode,
      status: 'running',
      currentMovie: null,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      message: 'Synchronizing subtitles',
      startedAt,
      updatedAt: startedAt,
    }
    this.events.publish(this.current)
    this.running = this.run(input).finally(() => { this.running = null })
    return Promise.resolve(this.snapshot())
  }

  stop(): SubtitleSyncSnapshot {
    if (this.running !== null) this.stopRequested = true
    return this.snapshot()
  }

  snapshot(): SubtitleSyncSnapshot {
    return copySyncSnapshot(this.current)
  }

  private async run(input: SubtitleSyncInput): Promise<void> {
    if (input.mode === 'manual') {
      await this.runManual(input.movie)
      return
    }
    await this.runAutomatic()
  }

  private async runAutomatic(): Promise<void> {
    await delay(240)
    if (this.stopRequested) return this.finish('stopped')
    this.transition({
      attempted: 1,
      currentMovie: { imdbId: 'tt0133093', title: 'The Matrix', releaseYear: 1999 },
      message: 'Importing subtitle',
    })

    await delay(240)
    this.transition({ succeeded: 1, message: 'Movie imported' })
    if (this.stopRequested) return this.finish('stopped')

    await delay(240)
    if (this.stopRequested) return this.finish('stopped')
    this.transition({
      attempted: 2,
      currentMovie: { imdbId: 'tt0034583', title: 'Casablanca', releaseYear: 1942 },
      message: 'Importing subtitle',
    })

    await delay(240)
    if (this.stopRequested) return this.finish('stopped')
    this.finish('quota_reached')
  }

  private async runManual(movie: Extract<SubtitleSyncInput, { mode: 'manual' }>['movie']): Promise<void> {
    await delay(240)
    if (this.stopRequested) return this.finish('stopped')
    this.transition({
      attempted: 1,
      currentMovie: { ...movie },
      message: 'Importing subtitle',
    })

    await delay(240)
    this.transition({ succeeded: 1, message: 'Movie imported' })
    this.finish(this.stopRequested ? 'stopped' : 'completed')
  }

  private finish(status: Extract<SubtitleSyncStatus, 'completed' | 'quota_reached' | 'stopped'>): void {
    this.transition({
      status,
      currentMovie: null,
      message: status === 'completed' ? 'Synchronization completed'
        : status === 'quota_reached' ? 'Provider quota reached; rerun later'
          : 'Stopped by operator',
    })
  }

  private transition(change: Partial<SubtitleSyncSnapshot>): void {
    this.current = { ...this.current, ...change, updatedAt: this.timestamp() }
    this.events.publish(this.current)
  }

  private timestamp(): string {
    this.clock += 1
    return new Date(this.clock).toISOString()
  }
}

function fixturePassage(input: CreateTaskInput): WorkbenchTaskView['passage'] {
  if (input.sourceAnchor === undefined) {
    const cues = Array.from({ length: input.sceneCount }, (_, index) => fixtureCue(index))
    return {
      movie: { id: 1, title: 'The Shawshank Redemption', releaseYear: 1994 },
      trackId: 101,
      startCueIndex: 400,
      endCueIndex: 399 + input.sceneCount,
      totalDurationMs: cues.reduce((sum, cue) => sum + cue.endMs - cue.startMs, 0),
      cues,
    }
  }

  const track = FIXTURE_SUBTITLE_TRACKS.find(value => value.trackId === input.sourceAnchor?.trackId)
  if (track === undefined
    || input.sourceAnchor.firstCueIndex < track.firstCueIndex
    || input.sourceAnchor.lastCueIndex > track.lastCueIndex
    || track.lastCueIndex - track.firstCueIndex + 1 < input.sceneCount) {
    throw new WorkbenchTaskError('source_anchor_not_found', 'Fixture source anchor not found', false)
  }
  const midpoint = Math.floor((input.sourceAnchor.firstCueIndex + input.sourceAnchor.lastCueIndex) / 2)
  const latestStartCueIndex = track.lastCueIndex - input.sceneCount + 1
  const startCueIndex = Math.max(
    track.firstCueIndex,
    Math.min(midpoint - Math.floor(input.sceneCount / 2), latestStartCueIndex),
  )
  const cues = Array.from({ length: input.sceneCount }, (_, index) => (
    fixtureAnchoredCue(track, startCueIndex + index)
  ))
  return {
    movie: structuredClone(track.movie),
    trackId: track.trackId,
    startCueIndex,
    endCueIndex: startCueIndex + input.sceneCount - 1,
    totalDurationMs: cues.reduce((sum, cue) => sum + cue.endMs - cue.startMs, 0),
    cues,
  }
}

function fixtureAnchoredCue(track: FixtureSubtitleTrack, cueIndex: number) {
  const startMs = track.firstCueStartMs + (cueIndex - track.firstCueIndex) * track.cueDurationMs
  const endMs = startMs + track.cueDurationMs
  const exact = FIXTURE_SUBTITLE_RESULTS
    .find(result => result.trackId === track.trackId)
    ?.cues.find(cue => cue.index === cueIndex)
  return {
    trackId: track.trackId,
    cueIndex,
    startMs,
    endMs,
    timestamp: `${formatTime(startMs)} --> ${formatTime(endMs)}`,
    text: exact?.text ?? fixtureDialogue(((cueIndex % 10) + 10) % 10),
  }
}

function fixtureIdleSyncSnapshot(updatedAt: string): SubtitleSyncSnapshot {
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
    updatedAt,
  }
}

function copySyncSnapshot(snapshot: SubtitleSyncSnapshot): SubtitleSyncSnapshot {
  return {
    ...snapshot,
    currentMovie: snapshot.currentMovie === null ? null : { ...snapshot.currentMovie },
  }
}

function assertFixtureSyncInput(input: SubtitleSyncInput): void {
  if (typeof input !== 'object' || input === null || (input.mode !== 'automatic' && input.mode !== 'manual')) {
    throw new Error('invalid_subtitle_sync_input')
  }
  if (input.mode === 'manual' && (!/^tt\d+$/.test(input.movie.imdbId)
    || input.movie.title.trim().length === 0
    || !Number.isSafeInteger(input.movie.releaseYear)
    || input.movie.releaseYear < 1888 || input.movie.releaseYear > 3000)) {
    throw new Error('invalid_subtitle_sync_input')
  }
}

function validateCreateInput(input: CreateTaskInput): void {
  if (input.theme.trim() === '' || input.theme.trim().length > 300
    || (input.aspectRatio !== '9:16' && input.aspectRatio !== '16:9')
    || !Number.isSafeInteger(input.sceneCount) || input.sceneCount < 5 || input.sceneCount > 10
    || (input.sourceAnchor !== undefined && (!Number.isSafeInteger(input.sourceAnchor.trackId)
      || input.sourceAnchor.trackId < 1 || !Number.isSafeInteger(input.sourceAnchor.firstCueIndex)
      || input.sourceAnchor.firstCueIndex < 0 || !Number.isSafeInteger(input.sourceAnchor.lastCueIndex)
      || input.sourceAnchor.lastCueIndex < input.sourceAnchor.firstCueIndex))) {
    throw new WorkbenchTaskError('invalid_task', 'Invalid task', false)
  }
}

function fixtureCue(index: number) {
  const startMs = 42_000 + index * 3_200
  const endMs = startMs + 3_200
  return {
    trackId: 101,
    cueIndex: 400 + index,
    startMs,
    endMs,
    timestamp: `${formatTime(startMs)} --> ${formatTime(endMs)}`,
    text: fixtureDialogue(index),
  }
}

function fixtureDialogue(index: number): string {
  const lines = [
    'A quiet choice can change the road ahead.',
    'We keep moving even when the way is uncertain.',
    'Time reveals what courage has already begun.',
    'The smallest light can guide a long journey.',
    'Hope grows when it is carried together.',
    'A new horizon waits beyond the last wall.',
    'Memory gives the present a deeper meaning.',
    'Every step leaves room for another beginning.',
    'Patience turns distance into direction.',
    'We arrive by refusing to stand still.',
  ]
  return lines[index]
}

function fixtureTranslation(index: number): string {
  const lines = [
    '一个安静的选择，也能改变前方的道路。',
    '即使方向未明，我们仍继续向前。',
    '时间会显露勇气早已开始的事情。',
    '最微小的光，也能指引漫长旅程。',
    '希望会在彼此托举中生长。',
    '最后一道墙外，新的地平线正在等待。',
    '记忆让此刻拥有更深的意义。',
    '每一步都为下一次开始留出空间。',
    '耐心让距离逐渐成为方向。',
    '我们因拒绝停步而终于抵达。',
  ]
  return lines[index]
}

function fixtureConcept(index: number): string {
  return [
    'lone traveler choosing a sunlit road',
    'steady footsteps through morning fog',
    'old clock beside an open doorway',
    'small lantern across a dark landscape',
    'friends lifting a sail in strong wind',
    'wide horizon beyond a concrete passage',
    'hands turning pages in warm window light',
    'path opening through a green valley',
    'slow river pointing toward distant mountains',
    'travelers reaching a bright overlook',
  ][index]
}

function fixtureCandidates(sceneIndex: number, page: number) {
  const runId = deterministicUuid(`run:${sceneIndex}:${page}`)
  return Array.from({ length: 8 }, (_, offset) => {
    const providerRank = (page - 1) * 8 + offset + 1
    return {
      provider: 'vecteezy' as const,
      resourceId: 100_000 + sceneIndex * 1_000 + providerRank,
      runId,
      page,
      title: `${fixtureConcept(sceneIndex)} · ${String(providerRank).padStart(2, '0')}`,
      previewId: deterministicUuid(`preview:${sceneIndex}:${providerRank}`),
      orientation: sceneIndex % 2 === 0 ? 'landscape' : 'portrait',
      licenseType: 'Pro',
      aiGenerated: false,
      score: 1 - providerRank / 100,
      suitabilityScore: 1 - providerRank / 120,
      providerRank,
    }
  })
}

function deterministicUuid(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function deduplicate<T extends { provider: string; resourceId: number }>(values: T[]): T[] {
  const seen = new Set<string>()
  return values.filter(value => {
    const key = `${value.provider}:${value.resourceId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function sameCandidate(left: CandidateIdentity, right: CandidateIdentity): boolean {
  return left.runId === right.runId && left.resourceId === right.resourceId
}

function allConfirmed(task: WorkbenchTaskView): boolean {
  return task.scenes.every(scene => scene.selected !== null && scene.confirmed !== null
    && sameCandidate(scene.selected, scene.confirmed))
}

function shouldFailOnce(theme: string): boolean {
  return theme.includes('失败恢复测试') || theme.includes('[fixture-fail]')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}

function formatTime(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000)
  const seconds = Math.floor(milliseconds % 60_000 / 1_000)
  const fraction = milliseconds % 1_000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(3, '0')}`
}

async function ensureSilentFixtureVideo(path: string, width: number, height: number): Promise<void> {
  if (await access(path).then(() => true, () => false)) return
  await mkdir(dirname(path), { recursive: true })
  await new Promise<void>((resolvePromise, reject) => {
    const process = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30`,
      '-t', '1', '-an', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path,
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let errorText = ''
    process.stderr.on('data', chunk => { errorText += String(chunk).slice(0, 2_000) })
    process.once('error', reject)
    process.once('close', code => code === 0
      ? resolvePromise()
      : reject(new Error(`fixture ffmpeg failed (${code}): ${errorText}`)))
  })
}

async function mediaMetadata(path: string): Promise<{ sha256: string; sizeBytes: number; durationMs: number }> {
  const [body, file] = await Promise.all([readFile(path), stat(path)])
  return {
    sha256: createHash('sha256').update(body).digest('hex'),
    sizeBytes: file.size,
    durationMs: 1_000,
  }
}

function fixtureRange(body: Buffer, value: string | undefined): {
  body: Uint8Array
  status: number
  contentRange?: string
} {
  const match = value === undefined ? null : /^bytes=(\d+)-(\d*)$/.exec(value)
  if (match === null) return { body: new Uint8Array(body), status: 200 }
  const start = Number(match[1])
  const end = match[2] === '' ? body.length - 1 : Math.min(Number(match[2]), body.length - 1)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= body.length) {
    return { body: new Uint8Array(), status: 416, contentRange: `bytes */${body.length}` }
  }
  return {
    body: new Uint8Array(body.subarray(start, end + 1)),
    status: 206,
    contentRange: `bytes ${start}-${end}/${body.length}`,
  }
}

function requiredMapValue<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key)
  if (value === undefined) throw new Error('fixture metadata is unavailable')
  return value
}
