import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Command } from 'commander'
import 'dotenv/config'
import { buildChunks } from './chunks.js'
import { OpenSubtitlesClient } from './opensubtitles.js'
import { SubtitleApi } from './supabase-api.js'
import { parseSubtitle } from './subtitles.js'

export interface MovieCandidate {
  imdbId: string
  title: string
  year: number
  rating: number
  votes: number
  genres: string
  score: number
}

export interface SubtitleMovieInput {
  imdbId: string
  title: string
  year: number
}

export interface BatchImportState {
  successes: BatchImportSuccess[]
  failures: BatchImportFailure[]
}

export interface BatchImportSuccess {
  imdbId: string
  title: string
  year: number
  file: string
  importedAt: string
}

export interface BatchImportFailure {
  imdbId: string
  title: string
  year: number
  stage: 'download' | 'import'
  message: string
  failedAt: string
}

export interface BatchImportOptions {
  candidatesPath: string
  statePath: string
  downloadsDir: string
  targetSuccessCount: number
  maxAttempts: number
  dryRun: boolean
}

export interface BatchImportDependencies {
  readText: (path: string) => Promise<string>
  writeText: (path: string, text: string) => Promise<void>
  ensureDirectory: (path: string) => Promise<void>
  exists: (path: string) => boolean
  downloadMovie: (candidate: SubtitleMovieInput, file: string) => Promise<void>
  importMovie: (candidate: SubtitleMovieInput, file: string) => Promise<void>
  now: () => string
  output: (text: string) => void
}

export type BatchImportProgress =
  | { type: 'movie_started'; movie: SubtitleMovieInput }
  | { type: 'movie_succeeded'; movie: SubtitleMovieInput }
  | { type: 'movie_failed'; movie: SubtitleMovieInput }
  | { type: 'quota_reached'; movie: SubtitleMovieInput }
  | { type: 'configuration_error'; movie: SubtitleMovieInput }
  | { type: 'stopped' }
  | { type: 'completed' }
  | { type: 'attempt_limit_reached' }
  | { type: 'candidate_exhausted' }

export interface BatchImportHooks {
  shouldStop?: () => boolean
  onProgress?: (event: BatchImportProgress) => void | Promise<void>
}

export type SyncMovieResult =
  | { status: 'succeeded' }
  | { status: 'failed'; stage: BatchImportFailure['stage']; message: string }
  | { status: 'quota_reached' }
  | { status: 'configuration_error' }

const defaultOptions: BatchImportOptions = {
  candidatesPath: 'data/classic-movie-candidates.json',
  statePath: '.batch-state/classic-import-state.json',
  downloadsDir: 'downloads/classics',
  targetSuccessCount: 200,
  maxAttempts: 230,
  dryRun: false,
}

export async function runBatchImport(
  options: Partial<BatchImportOptions> = {},
  dependencies: Partial<BatchImportDependencies> = {},
  hooks: BatchImportHooks = {},
): Promise<BatchImportState> {
  const resolved = { ...defaultOptions, ...options }
  const deps = createBatchImportDependencies(dependencies)
  const candidates = parseCandidates(await deps.readText(resolved.candidatesPath))
  const state = await readState(resolved.statePath, deps)
  const alreadySucceeded = new Set(state.successes.map(success => success.imdbId))
  const attemptedCandidates = new Set<string>()
  let attempts = 0

  await deps.ensureDirectory(resolved.downloadsDir)
  await deps.ensureDirectory(dirname(resolved.statePath))

  for (const candidate of candidates) {
    if (hooks.shouldStop?.()) {
      await reportProgress(hooks, { type: 'stopped' })
      return state
    }
    if (state.successes.length >= resolved.targetSuccessCount || attempts >= resolved.maxAttempts) break
    if (alreadySucceeded.has(candidate.imdbId) || attemptedCandidates.has(candidate.imdbId)) continue
    attempts += 1
    attemptedCandidates.add(candidate.imdbId)

    const file = join(resolved.downloadsDir, `${slugify(candidate.title)}-${candidate.year}-${candidate.imdbId}.srt`)
    const displayIndex = resolved.dryRun ? attempts : state.successes.length + 1
    deps.output(`[${displayIndex}/${resolved.targetSuccessCount}] ${candidate.title} (${candidate.year})\n`)
    if (resolved.dryRun) continue

    await reportProgress(hooks, { type: 'movie_started', movie: subtitleMovie(candidate) })
    const result = await syncMovie(candidate, file, deps)
    if (result.status === 'quota_reached' || result.status === 'configuration_error') {
      await reportProgress(hooks, { type: result.status, movie: subtitleMovie(candidate) })
      deps.output(`${stopMessageFor(result.status)} Rerun later to resume.\n`)
      return state
    }
    if (result.status === 'failed') {
      recordFailure(state, candidate, result.stage, result.message, deps.now())
      await writeState(resolved.statePath, state, deps)
      await reportProgress(hooks, { type: 'movie_failed', movie: subtitleMovie(candidate) })
      deps.output(`Skipped after ${result.stage} failure: ${candidate.title}\n`)
      continue
    }

    state.successes.push({
      imdbId: candidate.imdbId,
      title: candidate.title,
      year: candidate.year,
      file,
      importedAt: deps.now(),
    })
    alreadySucceeded.add(candidate.imdbId)
    clearFailure(state, candidate.imdbId)
    await writeState(resolved.statePath, state, deps)
    await reportProgress(hooks, { type: 'movie_succeeded', movie: subtitleMovie(candidate) })
    if (hooks.shouldStop?.()) {
      await reportProgress(hooks, { type: 'stopped' })
      return state
    }
  }

  const eligibleCandidatesRemain = candidates.some(candidate => !alreadySucceeded.has(candidate.imdbId)
    && !attemptedCandidates.has(candidate.imdbId))
  await reportProgress(hooks, state.successes.length >= resolved.targetSuccessCount ? { type: 'completed' }
    : attempts >= resolved.maxAttempts && eligibleCandidatesRemain ? { type: 'attempt_limit_reached' }
      : { type: 'candidate_exhausted' })
  deps.output(`Batch progress: ${state.successes.length}/${resolved.targetSuccessCount} imported, ${state.failures.length} failed.\n`)
  return state
}

export async function syncMovie(
  movie: SubtitleMovieInput,
  file: string,
  dependencies: Pick<BatchImportDependencies, 'exists' | 'downloadMovie' | 'importMovie'>,
): Promise<SyncMovieResult> {
  if (!dependencies.exists(file)) {
    try {
      await dependencies.downloadMovie(movie, file)
    } catch (error) {
      return resultForError(error, 'download')
    }
  }

  try {
    await dependencies.importMovie(movie, file)
    return { status: 'succeeded' }
  } catch (error) {
    return resultForError(error, 'import')
  }
}

function subtitleMovie(candidate: MovieCandidate): SubtitleMovieInput {
  return { imdbId: candidate.imdbId, title: candidate.title, year: candidate.year }
}

export function createBatchImportDependencies(overrides: Partial<BatchImportDependencies> = {}): BatchImportDependencies {
  return {
    readText: path => readFile(path, 'utf8'),
    writeText: async (path, text) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text, 'utf8')
    },
    ensureDirectory: path => mkdir(path, { recursive: true }).then(() => undefined),
    exists: existsSync,
    downloadMovie,
    importMovie,
    now: () => new Date().toISOString(),
    output: text => process.stdout.write(text),
    ...overrides,
  }
}

async function readState(path: string, deps: BatchImportDependencies): Promise<BatchImportState> {
  if (!deps.exists(path)) return { successes: [], failures: [] }
  const parsed = JSON.parse(await deps.readText(path)) as unknown
  if (!isState(parsed)) throw new Error(`invalid batch state file: ${path}`)
  return parsed
}

async function writeState(path: string, state: BatchImportState, deps: BatchImportDependencies): Promise<void> {
  await deps.writeText(path, `${JSON.stringify(state, null, 2)}\n`)
}

function parseCandidates(content: string): MovieCandidate[] {
  const parsed = JSON.parse(content) as unknown
  if (!Array.isArray(parsed) || !parsed.every(isCandidate)) {
    throw new Error('candidate file must contain an array of movie candidates')
  }
  return parsed
}

function isCandidate(value: unknown): value is MovieCandidate {
  return isRecord(value)
    && typeof value.imdbId === 'string'
    && /^tt\d+$/.test(value.imdbId)
    && typeof value.title === 'string'
    && Number.isInteger(value.year)
    && typeof value.rating === 'number'
    && typeof value.votes === 'number'
    && typeof value.genres === 'string'
    && typeof value.score === 'number'
}

function isState(value: unknown): value is BatchImportState {
  return isRecord(value) && Array.isArray(value.successes) && Array.isArray(value.failures)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordFailure(
  state: BatchImportState,
  candidate: MovieCandidate,
  stage: BatchImportFailure['stage'],
  message: string,
  failedAt: string,
): void {
  clearFailure(state, candidate.imdbId)
  state.failures.push({
    imdbId: candidate.imdbId,
    title: candidate.title,
    year: candidate.year,
    stage,
    message,
    failedAt,
  })
}

function clearFailure(state: BatchImportState, imdbId: string): void {
  state.failures = state.failures.filter(failure => failure.imdbId !== imdbId)
}

async function reportProgress(hooks: BatchImportHooks, event: BatchImportProgress): Promise<void> {
  await hooks.onProgress?.(event)
}

function resultForError(error: unknown, stage: BatchImportFailure['stage']): SyncMovieResult {
  const terminal = classifyBatchImportError(error)
  if (terminal !== null) return { status: terminal }
  return { status: 'failed', stage, message: safeFailureMessage(stage) }
}

function safeFailureMessage(stage: BatchImportFailure['stage']): string {
  return stage === 'download' ? 'Subtitle download failed' : 'Subtitle import failed'
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isQuotaLimitError(error: unknown): boolean {
  return errorStatus(error) === 429 || errorCode(error) === 'rate_limited'
    || /429|rate.?limited|quota|download limit|daily limit/i.test(summarizeError(error))
}

function isConfigurationStopError(error: unknown): boolean {
  return errorStatus(error) === 401 || errorStatus(error) === 403
    || errorCode(error) === 'unauthorized' || errorCode(error) === 'forbidden'
    || /invalid subtitle token|unauthorized|forbidden|missing environment variable/i.test(summarizeError(error))
}

function errorStatus(error: unknown): number | null {
  if (!isRecord(error) || typeof error.status !== 'number' || !Number.isInteger(error.status)) return null
  return error.status
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === 'string' ? error.code : null
}

export function classifyBatchImportError(error: unknown): 'quota_reached' | 'configuration_error' | null {
  if (isQuotaLimitError(error)) return 'quota_reached'
  if (isConfigurationStopError(error)) return 'configuration_error'
  return null
}

function stopMessageFor(status: 'quota_reached' | 'configuration_error'): string {
  if (status === 'quota_reached') {
    return 'Provider quota limit reached; stop cleanly.'
  }
  return 'Configuration or authentication error reached; stop cleanly.'
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

async function downloadMovie(candidate: SubtitleMovieInput, file: string): Promise<void> {
  const client = new OpenSubtitlesClient({
    apiKey: requireEnvironment('OPENSUBTITLES_API_KEY'),
    token: requireEnvironment('OPENSUBTITLES_TOKEN'),
    userAgent: requireEnvironment('OPENSUBTITLES_USER_AGENT'),
  })
  const subtitle = (await client.searchEnglishByImdb(candidate.imdbId.replace(/^tt/, '')))[0]
  if (subtitle === undefined) {
    throw new Error('no English subtitles found for the supplied IMDb ID')
  }
  const download = await client.downloadFile(subtitle.fileId)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, download.bytes)
}

async function importMovie(candidate: SubtitleMovieInput, file: string): Promise<void> {
  const bytes = await readFile(file)
  const cues = parseSubtitle(bytes.toString('utf8'), extname(file))
  const chunks = buildChunks(cues)
  if (chunks.length === 0) {
    throw new Error('subtitle contains no usable chunks')
  }

  const api = new SubtitleApi({
    supabaseUrl: requireEnvironment('SUPABASE_URL'),
    publishableKey: requireEnvironment('SUPABASE_PUBLISHABLE_KEY'),
    personalToken: requireEnvironment('SUBTITLE_PERSONAL_TOKEN'),
  })
  const started = await api.startImport({
    movie: { title: candidate.title, releaseYear: candidate.year, imdbId: candidate.imdbId },
    track: {
      languageCode: 'en',
      source: 'opensubtitles',
      sourceRef: `opensubtitles:${candidate.imdbId}`,
      sourceFileName: basename(file),
      sourceSha256: createHash('sha256').update(bytes).digest('hex'),
      rightsStatus: 'personal_research',
    },
  })

  try {
    for (let cueStart = 0, chunkStart = 0; cueStart < cues.length || chunkStart < chunks.length;) {
      const cueBatch = cues.slice(cueStart, cueStart + 100)
      const chunkBatch = chunks.slice(chunkStart, chunkStart + 1)
      await api.sendBatch({ trackId: started.trackId, cues: cueBatch, chunks: chunkBatch })
      cueStart += cueBatch.length
      chunkStart += chunkBatch.length
    }
    await api.finalizeImport(started.trackId)
  } catch (error) {
    await api.failImport(started.trackId).catch(failError => attachCleanupFailure(error, failError))
    throw error
  }
}

function requireEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`missing environment variable: ${name}`)
  }
  return value
}

function attachCleanupFailure(originalError: unknown, failError: unknown): void {
  if (originalError instanceof Error && originalError.cause === undefined) {
    Object.defineProperty(originalError, 'cause', {
      configurable: true,
      value: failError,
    })
  }
}

function createProgram(): Command {
  const program = new Command()
  program
    .name('batch-classics')
    .option('--candidates <path>', 'candidate movie JSON file', defaultOptions.candidatesPath)
    .option('--state <path>', 'resume state JSON file', defaultOptions.statePath)
    .option('--downloads <path>', 'download directory', defaultOptions.downloadsDir)
    .option('--target <count>', 'successful imports to add', parseInteger, defaultOptions.targetSuccessCount)
    .option('--max-attempts <count>', 'maximum candidates to attempt in one run', parseInteger, defaultOptions.maxAttempts)
    .option('--dry-run', 'print candidates without downloading or importing')
    .action(async options => {
      await runBatchImport({
        candidatesPath: options.candidates,
        statePath: options.state,
        downloadsDir: options.downloads,
        targetSuccessCount: options.target,
        maxAttempts: options.maxAttempts,
        dryRun: options.dryRun ?? false,
      })
    })
  return program
}

function parseInteger(value: string): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`expected a positive integer, received: ${value}`)
  }
  return number
}

const entryPoint = process.argv[1]
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  void createProgram().parseAsync().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
