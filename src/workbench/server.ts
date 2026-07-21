import 'dotenv/config'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatTimestamp } from '../subtitles.js'
import { probeMedia, validateFinalMediaProbe } from '../media-probe.js'
import { resolveArtifactPath, sha256File } from '../video-artifacts.js'
import { VideoProductionApi } from '../video-production-api.js'
import { renderSilentWorkbenchVideo } from '../video-renderer.js'
import { VecteezyDownloadClient } from '../vecteezy-download.js'
import { getVecteezyResource } from '../../supabase/functions/_shared/vecteezy.js'
import {
  createWorkbenchTask,
  listWorkbenchTasks,
  readWorkbenchReviewState,
  readWorkbenchTask,
  updateWorkbenchReviewState,
  updateWorkbenchTask,
  type WorkbenchDownloadReceipt,
  type WorkbenchOutput,
} from './artifacts-v2.js'
import { downloadConfirmedScenes, preflightSelections } from './download-manager.js'
import { runWorkbenchHealthChecks, type WorkbenchHealthDependencies } from './health.js'
import { createWorkbenchHttpServer, listenWorkbenchServer } from './http-server.js'
import { planPassageWithOllama } from './ollama.js'
import type { SelectedPassage, SelectedPassageCue } from './passage-selection.js'
import {
  WorkbenchTaskService,
  type CreateTaskInput,
  type WorkbenchTaskDependencies,
  type WorkbenchTaskStore,
} from './task-service.js'
import { PreviewRegistry, VecteezyCandidateAdapter } from './vecteezy-candidates.js'

export interface WorkbenchServerConfiguration {
  supabaseUrl: string
  supabasePublishableKey: string
  personalToken: string
  vecteezyAccount: string
  vecteezyApiKey: string
  ollamaEndpoint: URL
  ollamaModel: string
  artifactRoot: string
  fontPath: string
  port: number
}

export interface WorkbenchRuntime {
  taskService: WorkbenchTaskService
  previews: { resolve(previewId: string): Promise<string | undefined> | string | undefined }
  health(): ReturnType<typeof runWorkbenchHealthChecks>
  resolveFinalPath(taskId: string): Promise<string | null>
}

export function parseWorkbenchServerConfiguration(
  environment: Record<string, string | undefined> = process.env,
): WorkbenchServerConfiguration {
  try {
    const supabaseUrl = serviceUrl(required(environment, 'SUPABASE_URL'), true)
    const ollamaEndpoint = serviceUrl(required(environment, 'AI_INFERENCE_API_HOST'), false)
    const port = optionalPort(environment.WORKBENCH_PORT)
    const vecteezyAccount = required(environment, 'VECTEEZY_ACCOUNT')
    const ollamaModel = required(environment, 'OLLAMA_MODEL')
    const artifactRoot = environment.WORKBENCH_ARTIFACT_ROOT?.trim() || 'artifacts'
    const fontPath = environment.WORKBENCH_FONT_PATH?.trim() || 'C:\\Windows\\Fonts\\msyh.ttc'
    if (!/^\d+$/.test(vecteezyAccount)
      || !/^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/.test(ollamaModel)
      || artifactRoot.includes('\0') || fontPath.includes('\0')) throw new Error()
    return {
      supabaseUrl: supabaseUrl.origin,
      supabasePublishableKey: required(environment, 'SUPABASE_PUBLISHABLE_KEY'),
      personalToken: required(environment, 'SUBTITLE_PERSONAL_TOKEN'),
      vecteezyAccount,
      vecteezyApiKey: required(environment, 'VECTEEZY_API_KEY'),
      ollamaEndpoint,
      ollamaModel,
      artifactRoot,
      fontPath,
      port,
    }
  } catch {
    throw new Error('invalid workbench configuration')
  }
}

export async function requestSubtitlePassage(input: {
  supabaseUrl: string
  publishableKey: string
  personalToken: string
  theme: string
  sceneCount: number
  fetcher?: typeof fetch
}): Promise<SelectedPassage> {
  try {
    const response = await (input.fetcher ?? fetch)(`${input.supabaseUrl.replace(/\/$/, '')}/functions/v1/subtitle-passages`, {
      method: 'POST',
      headers: {
        apikey: input.publishableKey,
        'x-subtitle-token': input.personalToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ theme: input.theme, sceneCount: input.sceneCount }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error()
    const text = await response.text()
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error()
    const envelope = exactObject(JSON.parse(text), ['passage'])
    return parseSelectedPassage(envelope.passage, input.sceneCount)
  } catch {
    throw new Error('subtitle passage request failed')
  }
}

export function createWorkbenchRuntime(
  configuration: WorkbenchServerConfiguration,
  fetcher: typeof fetch = fetch,
): WorkbenchRuntime {
  const artifactRoot = resolve(configuration.artifactRoot)
  const apiConfiguration = {
    supabaseUrl: configuration.supabaseUrl,
    publishableKey: configuration.supabasePublishableKey,
    personalToken: configuration.personalToken,
    fetchFn: fetcher,
  }
  const production = new VideoProductionApi(apiConfiguration)
  const previewRegistry = new PreviewRegistry()
  const candidates = new VecteezyCandidateAdapter(production, previewRegistry)
  const downloads = new VecteezyDownloadClient({
    accountId: configuration.vecteezyAccount,
    apiKey: configuration.vecteezyApiKey,
    fetcher,
    fileOperations: {
      createWriteStream: key => createWriteStream(resolveArtifactPath(artifactRoot, key)),
      rename: (from, to) => rename(resolveArtifactPath(artifactRoot, from), resolveArtifactPath(artifactRoot, to)),
      rm: key => rm(resolveArtifactPath(artifactRoot, key), { force: true }),
    },
  })
  const artifacts: WorkbenchTaskStore = {
    createTask: (manifest, review) => createWorkbenchTask(artifactRoot, manifest, review),
    readTask: taskId => readWorkbenchTask(artifactRoot, taskId),
    listTasks: () => listWorkbenchTasks(artifactRoot),
    readReview: taskId => readWorkbenchReviewState(artifactRoot, taskId),
    updateTask: (taskId, updater) => updateWorkbenchTask(artifactRoot, taskId, updater),
    updateReview: (taskId, updater) => updateWorkbenchReviewState(artifactRoot, taskId, updater),
    verifyReceipt: receipt => verifyReceipt(artifactRoot, receipt),
  }
  const taskService = new WorkbenchTaskService({
    createId: randomUUID,
    now: () => new Date(),
    requestDigest,
    selectPassage: input => requestSubtitlePassage({
      supabaseUrl: configuration.supabaseUrl,
      publishableKey: configuration.supabasePublishableKey,
      personalToken: configuration.personalToken,
      theme: input.theme,
      sceneCount: input.sceneCount,
      fetcher,
    }),
    planPassage: input => planPassageWithOllama({
      endpoint: configuration.ollamaEndpoint,
      model: configuration.ollamaModel,
      cues: input.passage.cues,
      movieTitle: input.passage.movie.title,
      fetchFn: fetcher,
    }),
    loadCandidatePage: input => candidates.loadPage({
      theme: input.theme,
      aspectRatio: input.aspectRatio,
      page: input.page,
      ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
    }),
    selectCandidate: input => candidates.select(input.candidate, input.note),
    artifacts,
    preflightSelections: async input => {
      await mkdir(resolve(artifactRoot, 'video-runs', input.taskId, 'sources'), { recursive: true })
      return preflightSelections({ ...input, inspect: downloads })
    },
    downloadConfirmedScenes: input => downloadConfirmedScenes({ ...input, artifacts, client: downloads }),
    probeSource: async input => {
      try {
        return await probeMedia(resolveArtifactPath(artifactRoot, input.source.artifactKey))
      } catch {
        throw Object.assign(new Error('source media validation failed'), { code: 'invalid_media_probe' })
      }
    },
    renderVideo: input => renderWorkbenchOutput(artifactRoot, configuration.fontPath, input),
    recoverOutput: taskId => recoverWorkbenchOutput(artifactRoot, taskId),
    validateOutput: input => validateWorkbenchOutput(artifactRoot, input.taskId, input.output),
    manifestSha256: taskId => sha256File(resolve(artifactRoot, 'video-runs', taskId, 'manifest-v2.json')),
    production,
  })
  let previewIndex: Promise<Map<string, number>> | undefined
  const previews = createLazyPreviewResolver({
    registry: previewRegistry,
    findResourceId: async previewId => {
      previewIndex ??= indexPersistedPreviews(artifactRoot)
      return (await previewIndex).get(previewId) ?? null
    },
    loadPreviewUrl: async resourceId => (
      await getVecteezyResource(resourceId, {
        accountId: configuration.vecteezyAccount,
        apiKey: configuration.vecteezyApiKey,
        fetcher,
      })
    ).ephemeral.previewUrl,
  })
  const healthDependencies = productionHealthDependencies(configuration, artifactRoot, fetcher)
  return {
    taskService,
    previews,
    health: () => runWorkbenchHealthChecks({ ollamaModel: configuration.ollamaModel }, healthDependencies),
    resolveFinalPath: taskId => finalPathForCompletedTask(artifactRoot, taskId),
  }
}

export function createLazyPreviewResolver(input: {
  registry: PreviewRegistry
  findResourceId(previewId: string): Promise<number | null>
  loadPreviewUrl(resourceId: number): Promise<string | null>
}): { resolve(previewId: string): Promise<string | undefined> } {
  const pending = new Map<string, Promise<string | undefined>>()
  return {
    async resolve(previewId: string): Promise<string | undefined> {
      const existing = input.registry.resolve(previewId)
      if (existing !== undefined) return existing
      const active = pending.get(previewId)
      if (active !== undefined) return active
      const recovery = (async () => {
        const resourceId = await input.findResourceId(previewId)
        if (resourceId === null) return undefined
        const url = await input.loadPreviewUrl(resourceId)
        if (url === null) return undefined
        input.registry.restore(previewId, url)
        return input.registry.resolve(previewId)
      })().catch(() => undefined).finally(() => pending.delete(previewId))
      pending.set(previewId, recovery)
      return recovery
    },
  }
}

async function indexPersistedPreviews(artifactRoot: string): Promise<Map<string, number>> {
  const index = new Map<string, number>()
  const conflicts = new Set<string>()
  for (const task of await listWorkbenchTasks(artifactRoot)) {
    const review = await readWorkbenchReviewState(artifactRoot, task.taskId).catch(() => null)
    if (review === null) continue
    for (const candidate of review.scenes.flatMap(scene => scene.pages.flat())) {
      if (candidate.previewId === null || conflicts.has(candidate.previewId)) continue
      const existing = index.get(candidate.previewId)
      if (existing !== undefined && existing !== candidate.resourceId) {
        index.delete(candidate.previewId)
        conflicts.add(candidate.previewId)
      } else {
        index.set(candidate.previewId, candidate.resourceId)
      }
    }
  }
  return index
}

export async function runWorkbenchServer(
  environment: Record<string, string | undefined> = process.env,
  options: { dev?: boolean } = {},
): Promise<{ url: string; server: ReturnType<typeof createWorkbenchHttpServer> }> {
  const configuration = parseWorkbenchServerConfiguration(environment)
  await mkdir(resolve(configuration.artifactRoot), { recursive: true })
  const runtime = createWorkbenchRuntime(configuration)
  const workbenchRoot = resolve('workbench')
  let vite: Awaited<ReturnType<(typeof import('vite'))['createServer']>> | undefined
  const server = createWorkbenchHttpServer({
    taskService: runtime.taskService,
    health: runtime.health,
    previewRegistry: runtime.previews,
    resolveFinalPath: runtime.resolveFinalPath,
    ...(options.dev === true ? {
      renderHtml: async () => {
        if (vite === undefined) throw new Error('Vite is unavailable')
        return vite.transformIndexHtml('/', await readFile(resolve(workbenchRoot, 'index.html'), 'utf8'))
      },
      frontendMiddleware: async (request, response) => {
        if (vite === undefined) return false
        return runViteMiddleware(vite.middlewares, request, response)
      },
    } : { staticRoot: resolve(workbenchRoot, 'dist') }),
  })
  if (options.dev === true) {
    const { createServer: createViteServer } = await import('vite')
    vite = await createViteServer({
      configFile: resolve('vite.config.ts'),
      root: workbenchRoot,
      appType: 'spa',
      server: {
        middlewareMode: true,
        hmr: { server },
      },
    })
    server.once('close', () => { void vite?.close() })
  }
  const address = await listenWorkbenchServer(server, { port: configuration.port })
  const report = await runtime.health()
  console.log(address.url)
  console.log(`health=${report.status}`)
  return { url: address.url, server }
}

function runViteMiddleware(
  middleware: { (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, next: (error?: unknown) => void): void },
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    let settled = false
    const finish = (handled: boolean, error?: unknown) => {
      if (settled) return
      settled = true
      response.off('finish', onFinish)
      response.off('close', onClose)
      if (error !== undefined) reject(error)
      else resolvePromise(handled)
    }
    const onFinish = () => finish(true)
    const onClose = () => finish(response.headersSent)
    response.once('finish', onFinish)
    response.once('close', onClose)
    middleware(request, response, error => finish(false, error))
  })
}

async function renderWorkbenchOutput(
  artifactRoot: string,
  fontFilePath: string,
  input: Parameters<WorkbenchTaskDependencies['renderVideo']>[0],
): Promise<WorkbenchOutput> {
  const assKey = `video-runs/${input.taskId}/subtitles.ass`
  const finalKey = `video-runs/${input.taskId}/final.mp4`
  if (!((input.width === 1920 && input.height === 1080)
    || (input.width === 1080 && input.height === 1920))) throw new Error('invalid workbench render dimensions')
  const assPath = resolveArtifactPath(artifactRoot, assKey)
  const finalPath = resolveArtifactPath(artifactRoot, finalKey)
  await mkdir(dirname(assPath), { recursive: true })
  await writeFile(assPath, input.assText, 'utf8')
  const rendered = await renderSilentWorkbenchVideo({
    sourcePaths: input.sources.map(source => resolveArtifactPath(artifactRoot, source.artifactKey)),
    assPath,
    finalPath,
    timeline: input.timeline,
    config: {
      width: input.width as 1080 | 1920,
      height: input.height as 1080 | 1920,
      frameRate: input.frameRate,
      transitionMs: 300,
    },
    fontFilePath,
  })
  const file = await stat(finalPath)
  return {
    artifactKey: finalKey,
    sha256: await sha256File(finalPath),
    sizeBytes: file.size,
    durationMs: rendered.finalProbe.durationMs,
    width: rendered.finalProbe.width,
    height: rendered.finalProbe.height,
    frameRate: 30,
    videoCodec: 'h264',
    pixelFormat: 'yuv420p',
    audioCodec: null,
    ffmpegVersion: await executableVersion('ffmpeg'),
  }
}

async function recoverWorkbenchOutput(artifactRoot: string, taskId: string): Promise<WorkbenchOutput | null> {
  const manifest = await readWorkbenchTask(artifactRoot, taskId)
  const artifactKey = `video-runs/${taskId}/final.mp4`
  const path = resolveArtifactPath(artifactRoot, artifactKey)
  try {
    const file = await stat(path)
    const probe = validateFinalMediaProbe(await probeMedia(path), {
      width: manifest.width,
      height: manifest.height,
      fps: 30,
      durationSeconds: manifest.passage.totalDurationMs / 1_000,
      durationToleranceMs: 50,
      audioCodec: null,
    })
    return {
      artifactKey,
      sha256: await sha256File(path),
      sizeBytes: file.size,
      durationMs: probe.durationMs,
      width: probe.width,
      height: probe.height,
      frameRate: 30,
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      audioCodec: null,
      ffmpegVersion: 'ffmpeg (recovered local output)',
    }
  } catch {
    return null
  }
}

async function validateWorkbenchOutput(
  artifactRoot: string,
  taskId: string,
  output: WorkbenchOutput,
): Promise<void> {
  try {
    const manifest = await readWorkbenchTask(artifactRoot, taskId)
    const path = resolveArtifactPath(artifactRoot, output.artifactKey)
    const [file, digest, probe] = await Promise.all([stat(path), sha256File(path), probeMedia(path)])
    if (file.size !== output.sizeBytes || digest !== output.sha256) {
      throw Object.assign(new Error('output integrity mismatch'), { code: 'output_hash_mismatch' })
    }
    validateFinalMediaProbe(probe, {
      width: manifest.width,
      height: manifest.height,
      fps: 30,
      durationSeconds: manifest.passage.totalDurationMs / 1_000,
      durationToleranceMs: 50,
      audioCodec: null,
    })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'output_hash_mismatch') throw error
    throw Object.assign(new Error('final media validation failed'), { code: 'invalid_final_media' })
  }
}

async function finalPathForCompletedTask(artifactRoot: string, taskId: string): Promise<string | null> {
  try {
    const manifest = await readWorkbenchTask(artifactRoot, taskId)
    if (manifest.stage !== 'completed' || manifest.output === undefined
      || manifest.output.artifactKey !== `video-runs/${taskId}/final.mp4`) return null
    const path = resolveArtifactPath(artifactRoot, manifest.output.artifactKey)
    const file = await stat(path)
    return file.isFile() && file.size === manifest.output.sizeBytes ? path : null
  } catch {
    return null
  }
}

async function verifyReceipt(artifactRoot: string, receipt: WorkbenchDownloadReceipt): Promise<boolean> {
  try {
    const path = resolveArtifactPath(artifactRoot, receipt.artifactKey)
    const file = await stat(path)
    return file.isFile() && file.size === receipt.sizeBytes && await sha256File(path) === receipt.sha256
  } catch {
    return false
  }
}

function productionHealthDependencies(
  configuration: WorkbenchServerConfiguration,
  artifactRoot: string,
  fetcher: typeof fetch,
): WorkbenchHealthDependencies {
  return {
    probeSupabase: async ({ signal }) => {
      const response = await fetcher(`${configuration.supabaseUrl}/functions/v1/subtitle-passages`, {
        method: 'POST',
        headers: {
          apikey: configuration.supabasePublishableKey,
          'x-subtitle-token': configuration.personalToken,
          'content-type': 'application/json',
        },
        body: '{}',
        redirect: 'error',
        signal,
      })
      if (response.status !== 400) throw new Error('Supabase unavailable')
      await response.body?.cancel()
      return { connected: true }
    },
    fetchOllamaTags: async ({ signal }) => {
      const response = await fetcher(new URL('/api/tags', configuration.ollamaEndpoint.origin), {
        redirect: 'error',
        signal,
      })
      if (!response.ok) throw new Error('Ollama unavailable')
      return response.json()
    },
    probeVecteezyAccount: async ({ signal }) => {
      const url = new URL(`/v2/${configuration.vecteezyAccount}/resources`, 'https://api.vecteezy.com')
      url.search = new URLSearchParams({
        term: 'hope',
        content_type: 'video',
        license_type: 'commercial',
        per_page: '1',
      }).toString()
      const response = await fetcher(url, {
        headers: { authorization: `Bearer ${configuration.vecteezyApiKey}`, accept: 'application/json' },
        redirect: 'error',
        signal,
      })
      if (!response.ok) throw new Error('Vecteezy unavailable')
      await response.body?.cancel()
      return {
        active: true,
        quota: {
          limit: quotaHeader(response.headers, ['x-ratelimit-limit', 'x-rate-limit-limit', 'x-download-limit']),
          remaining: quotaHeader(response.headers, ['x-ratelimit-remaining', 'x-rate-limit-remaining', 'x-download-remaining']),
        },
      }
    },
    runProcess: ({ command, args, signal }) => runHealthProcess(command, [...args], signal),
    probeFont: async () => {
      await access(configuration.fontPath)
      return true
    },
    probeDisk: async () => {
      await mkdir(artifactRoot, { recursive: true })
      const fileSystem = await statfs(artifactRoot)
      return { freeBytes: Number(fileSystem.bavail) * Number(fileSystem.bsize) }
    },
  }
}

function runHealthProcess(command: string, args: string[], signal: AbortSignal): Promise<{ exitCode: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, signal, stdio: 'ignore' })
    child.once('error', reject)
    child.once('close', code => resolvePromise({ exitCode: code ?? -1 }))
  })
}

async function executableVersion(command: string): Promise<string> {
  return new Promise(resolvePromise => {
    const child = spawn(command, ['-version'], { shell: false, windowsHide: true })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', value => { if (output.length < 500) output += value })
    child.once('error', () => resolvePromise(`${command} (local)`))
    child.once('close', () => resolvePromise(output.split(/\r?\n/, 1)[0]?.slice(0, 500) || `${command} (local)`))
  })
}

function requestDigest(input: CreateTaskInput): string {
  return createHash('sha256').update(JSON.stringify({
    version: 2,
    theme: input.theme.trim(),
    aspectRatio: input.aspectRatio,
    sceneCount: input.sceneCount,
  })).digest('hex')
}

function parseSelectedPassage(value: unknown, sceneCount: number): SelectedPassage {
  const passage = exactObject(value, [
    'movie', 'trackId', 'startCueIndex', 'endCueIndex', 'totalDurationMs', 'cues',
  ])
  const movie = exactObject(passage.movie, ['id', 'title', 'releaseYear'])
  if (!positiveInteger(movie.id) || typeof movie.title !== 'string' || movie.title.trim() === ''
    || !(movie.releaseYear === null || Number.isSafeInteger(movie.releaseYear))
    || !positiveInteger(passage.trackId) || !nonnegativeInteger(passage.startCueIndex)
    || passage.endCueIndex !== (passage.startCueIndex as number) + sceneCount - 1
    || !Array.isArray(passage.cues) || passage.cues.length !== sceneCount) throw new Error()
  const cues = passage.cues.map((cue, index) => parsePassageCue(
    cue,
    passage.trackId as number,
    (passage.startCueIndex as number) + index,
  ))
  const totalDurationMs = cues.reduce((sum, cue) => sum + cue.endMs - cue.startMs, 0)
  if (totalDurationMs !== passage.totalDurationMs || totalDurationMs < 15_000 || totalDurationMs > 60_000) throw new Error()
  return {
    movie: { id: movie.id as number, title: movie.title, releaseYear: movie.releaseYear as number | null },
    trackId: passage.trackId as number,
    startCueIndex: passage.startCueIndex as number,
    endCueIndex: passage.endCueIndex as number,
    totalDurationMs,
    cues,
  }
}

function parsePassageCue(value: unknown, trackId: number, cueIndex: number): SelectedPassageCue {
  const cue = exactObject(value, ['trackId', 'cueIndex', 'startMs', 'endMs', 'timestamp', 'text'])
  if (cue.trackId !== trackId || cue.cueIndex !== cueIndex
    || !nonnegativeInteger(cue.startMs) || !positiveInteger(cue.endMs)
    || (cue.endMs as number) - (cue.startMs as number) < 1_200
    || typeof cue.text !== 'string' || cue.text.trim() === ''
    || cue.timestamp !== `${formatTimestamp(cue.startMs as number)} --> ${formatTimestamp(cue.endMs as number)}`) throw new Error()
  return {
    trackId,
    cueIndex,
    startMs: cue.startMs as number,
    endMs: cue.endMs as number,
    timestamp: cue.timestamp,
    text: cue.text,
  }
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error()
  const input = value as Record<string, unknown>
  const actual = Object.keys(input).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error()
  return input
}

function required(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name]?.trim()
  if (value === undefined || value === '' || value.length > 2_000) throw new Error()
  return value
}

function serviceUrl(value: string, requireHttps: boolean): URL {
  const url = new URL(value)
  const localHttp = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  if (url.username !== '' || url.password !== ''
    || (requireHttps ? url.protocol !== 'https:' && !localHttp : url.protocol !== 'https:' && url.protocol !== 'http:')) throw new Error()
  return url
}

function optionalPort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 4173
  if (!/^\d+$/.test(value)) throw new Error()
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error()
  return port
}

function quotaHeader(headers: Headers, names: readonly string[]): number | null {
  for (const name of names) {
    const value = headers.get(name)
    if (value !== null && /^\d+$/.test(value)) return Number(value)
  }
  return null
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runWorkbenchServer(process.env, { dev: process.argv.slice(2).includes('--dev') })
}
