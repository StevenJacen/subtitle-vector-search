import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { WorkbenchHealthReport } from './health.js'
import { WorkbenchEventBus } from './events.js'
import type { WorkbenchHttpTaskService } from './http-server.js'
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
  previewFetcher: typeof fetch
  lookupPreviewHost(hostname: string): Promise<string[]>
}

const PRODUCTION_STAGES = [
  'preflight',
  'downloading',
  'probing',
  'rendering',
  'validating',
  'completing',
] as const

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
      const cues = Array.from({ length: input.sceneCount }, (_, index) => fixtureCue(index))
      const task: WorkbenchTaskView = {
        taskId,
        theme: input.theme.trim(),
        aspectRatio: input.aspectRatio,
        ...(input.aspectRatio === '16:9'
          ? { width: 1920, height: 1080 }
          : { width: 1080, height: 1920 }),
        sceneCount: input.sceneCount,
        stage: 'review',
        passage: {
          movie: { id: 1, title: 'The Shawshank Redemption', releaseYear: 1994 },
          trackId: 101,
          startCueIndex: 400,
          endCueIndex: 399 + input.sceneCount,
          totalDurationMs: cues.reduce((sum, cue) => sum + cue.endMs - cue.startMs, 0),
          cues,
        },
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

  return {
    taskService,
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

function validateCreateInput(input: CreateTaskInput): void {
  if (input.theme.trim() === '' || input.theme.trim().length > 300
    || (input.aspectRatio !== '9:16' && input.aspectRatio !== '16:9')
    || !Number.isSafeInteger(input.sceneCount) || input.sceneCount < 5 || input.sceneCount > 10) {
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
