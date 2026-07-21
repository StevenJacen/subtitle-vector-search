import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import {
  createBatchImportDependencies,
  runBatchImport,
  syncMovie,
  type BatchImportDependencies,
  type BatchImportProgress,
  type SubtitleMovieInput,
} from '../batch-classics.js'

export type SubtitleSyncStatus = 'idle' | 'running' | 'completed' | 'quota_reached'
  | 'candidate_exhausted' | 'stopped' | 'configuration_error' | 'failed'

export interface SubtitleSyncSnapshot {
  jobId: string | null
  mode: 'automatic' | 'manual' | null
  status: SubtitleSyncStatus
  currentMovie: { imdbId: string; title: string; releaseYear: number } | null
  attempted: number
  succeeded: number
  failed: number
  message: string
  startedAt: string | null
  updatedAt: string
}

export type SubtitleSyncInput =
  | { mode: 'automatic' }
  | { mode: 'manual'; movie: { imdbId: string; title: string; releaseYear: number } }

export interface SubtitleSyncOptions {
  candidatesPath: string
  batchStatePath: string
  snapshotPath: string
  downloadsDir: string
  targetSuccessCount: number
  maxAttempts: number
}

export interface SubtitleSyncDependencies extends Omit<BatchImportDependencies, 'output'> {
  createId: () => string
}

export interface SubtitleSyncEvent {
  sequence: number
  snapshot: SubtitleSyncSnapshot
}

type Listener = (event: SubtitleSyncEvent) => void

const defaultOptions: SubtitleSyncOptions = {
  candidatesPath: 'data/classic-movie-candidates.json',
  batchStatePath: '.batch-state/classic-import-state.json',
  snapshotPath: '.batch-state/subtitle-sync-snapshot.json',
  downloadsDir: 'downloads/classics',
  targetSuccessCount: 200,
  maxAttempts: 230,
}

const safeMessages = new Set([
  'Idle',
  'Synchronizing subtitles',
  'Importing subtitle',
  'Movie imported',
  'Movie import failed; continuing',
  'Movie import failed',
  'Synchronization completed',
  'No remaining subtitle candidates',
  'Stopped by operator',
  'Provider quota reached; rerun later',
  'Subtitle provider configuration needs attention',
  'Synchronization interrupted; rerun to resume',
  'Synchronization failed',
  'Synchronization attempt limit reached; rerun to resume',
])

let activeSyncOwner: symbol | null = null

export class SubtitleSyncEventBus {
  private readonly history: SubtitleSyncEvent[] = []
  private readonly listeners = new Set<Listener>()

  publish(snapshot: SubtitleSyncSnapshot): SubtitleSyncEvent {
    const event = { sequence: this.history.length + 1, snapshot: copySnapshot(snapshot) }
    this.history.push(event)
    for (const listener of this.listeners) {
      try {
        listener(copyEvent(event))
      } catch {
        // Observers cannot interrupt synchronization.
      }
    }
    return copyEvent(event)
  }

  replay(afterSequence = 0): SubtitleSyncEvent[] {
    return this.history.filter(event => event.sequence > afterSequence).map(copyEvent)
  }

  subscribe(listener: Listener, afterSequence = 0): () => void {
    for (const event of this.replay(afterSequence)) listener(event)
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export class SubtitleSyncController {
  readonly events = new SubtitleSyncEventBus()

  private readonly options: SubtitleSyncOptions
  private readonly dependencies: SubtitleSyncDependencies
  private current: SubtitleSyncSnapshot
  private running: Promise<void> | null = null
  private stopRequested = false

  constructor(options: Partial<SubtitleSyncOptions> = {}, dependencies: Partial<SubtitleSyncDependencies> = {}) {
    this.options = { ...defaultOptions, ...options }
    const batch = createBatchImportDependencies({ output: () => {} })
    this.dependencies = {
      ...batch,
      createId: randomUUID,
      ...dependencies,
    }
    this.current = idleSnapshot(this.dependencies.now())
  }

  start(input: SubtitleSyncInput): Promise<SubtitleSyncSnapshot> {
    if (this.running !== null || activeSyncOwner !== null) throw new Error('subtitle_sync_already_running')
    assertInput(input)

    const startedAt = this.dependencies.now()
    this.stopRequested = false
    this.current = {
      jobId: this.dependencies.createId(),
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
    const owner = Symbol('subtitle-sync-owner')
    activeSyncOwner = owner
    const task = this.run(input)
    this.running = task.finally(() => {
      this.running = null
      if (activeSyncOwner === owner) activeSyncOwner = null
    })
    return Promise.resolve(this.snapshot())
  }

  stop(): SubtitleSyncSnapshot {
    if (this.running !== null) this.stopRequested = true
    return this.snapshot()
  }

  snapshot(): SubtitleSyncSnapshot {
    return copySnapshot(this.current)
  }

  async reload(): Promise<SubtitleSyncSnapshot> {
    if (this.running !== null) throw new Error('subtitle_sync_already_running')
    if (!this.dependencies.exists(this.options.snapshotPath)) return this.snapshot()
    const parsed = JSON.parse(await this.dependencies.readText(this.options.snapshotPath)) as unknown
    if (!isSnapshot(parsed)) throw new Error('invalid_subtitle_sync_snapshot')
    this.current = snapshotFrom(parsed)
    if (this.current.status === 'running') {
      await this.transition({ status: 'stopped', currentMovie: null, message: 'Synchronization interrupted; rerun to resume' })
    }
    return this.snapshot()
  }

  private async run(input: SubtitleSyncInput): Promise<void> {
    try {
      await this.persist()
      this.events.publish(this.current)
      if (this.stopRequested) {
        await this.finish('stopped')
        return
      }
      if (input.mode === 'manual') {
        await this.runManual(input.movie)
      } else {
        await this.runAutomatic()
      }
    } catch {
      await this.transition({ status: 'failed', currentMovie: null, message: 'Synchronization failed' })
    }
  }

  private async runManual(movie: { imdbId: string; title: string; releaseYear: number }): Promise<void> {
    const candidate = { imdbId: movie.imdbId, title: movie.title.trim(), year: movie.releaseYear }
    await this.handleProgress({ type: 'movie_started', movie: candidate })
    const file = `${this.options.downloadsDir}/${candidate.imdbId}.srt`
    const result = await syncMovie(candidate, file, this.dependencies)
    if (result.status === 'succeeded') {
      await this.handleProgress({ type: 'movie_succeeded', movie: candidate })
      await this.finish(this.stopRequested ? 'stopped' : 'completed')
      return
    }
    if (result.status === 'failed') {
      await this.transition({ failed: this.current.failed + 1, currentMovie: null, status: 'failed', message: 'Movie import failed' })
      if (this.stopRequested) await this.finish('stopped')
      return
    }
    await this.finish(result.status)
  }

  private async runAutomatic(): Promise<void> {
    await runBatchImport({
      candidatesPath: this.options.candidatesPath,
      statePath: this.options.batchStatePath,
      downloadsDir: this.options.downloadsDir,
      targetSuccessCount: this.options.targetSuccessCount,
      maxAttempts: Number.MAX_SAFE_INTEGER,
      dryRun: false,
    }, { ...this.dependencies, output: () => {} }, {
      shouldStop: () => this.stopRequested,
      onProgress: event => this.handleProgress(event),
    })
  }

  private async handleProgress(event: BatchImportProgress): Promise<void> {
    switch (event.type) {
      case 'movie_started':
        await this.transition({
          attempted: this.current.attempted + 1,
          currentMovie: movieSnapshot(event.movie),
          message: 'Importing subtitle',
        })
        return
      case 'movie_succeeded':
        await this.transition({ succeeded: this.current.succeeded + 1, message: 'Movie imported' })
        return
      case 'movie_failed':
        await this.transition({
          failed: this.current.failed + 1,
          currentMovie: null,
          message: 'Movie import failed; continuing',
        })
        return
      case 'quota_reached':
      case 'configuration_error':
        await this.finish(event.type)
        return
      case 'stopped':
      case 'completed':
      case 'candidate_exhausted':
        await this.finish(event.type)
        return
      case 'attempt_limit_reached':
        await this.transition({
          status: 'failed',
          currentMovie: null,
          message: 'Synchronization attempt limit reached; rerun to resume',
        })
    }
  }

  private async finish(status: Exclude<SubtitleSyncStatus, 'idle' | 'running' | 'failed'>): Promise<void> {
    const message = status === 'completed' ? 'Synchronization completed'
      : status === 'candidate_exhausted' ? 'No remaining subtitle candidates'
        : status === 'stopped' ? 'Stopped by operator'
          : status === 'quota_reached' ? 'Provider quota reached; rerun later'
            : 'Subtitle provider configuration needs attention'
    await this.transition({ status, currentMovie: null, message })
  }

  private async transition(change: Partial<SubtitleSyncSnapshot>): Promise<void> {
    this.current = { ...this.current, ...change, updatedAt: this.dependencies.now() }
    await this.persist()
    this.events.publish(this.current)
  }

  private async persist(): Promise<void> {
    await this.dependencies.ensureDirectory(dirname(this.options.snapshotPath))
    await this.dependencies.writeText(this.options.snapshotPath, `${JSON.stringify(this.snapshot())}\n`)
  }
}

function assertInput(input: SubtitleSyncInput): void {
  if (typeof input !== 'object' || input === null || (input.mode !== 'automatic' && input.mode !== 'manual')) {
    throw new Error('invalid_subtitle_sync_input')
  }
  if (input.mode === 'manual' && !isMovieInput(input.movie)) throw new Error('invalid_subtitle_sync_input')
}

function isMovieInput(movie: unknown): movie is { imdbId: string; title: string; releaseYear: number } {
  if (typeof movie !== 'object' || movie === null || Array.isArray(movie)) return false
  const record = movie as Record<string, unknown>
  return typeof record.imdbId === 'string' && /^tt\d+$/.test(record.imdbId)
    && typeof record.title === 'string' && record.title.trim().length > 0 && record.title.trim().length <= 200
    && typeof record.releaseYear === 'number' && Number.isSafeInteger(record.releaseYear)
    && record.releaseYear >= 1888 && record.releaseYear <= 3000
}

function idleSnapshot(updatedAt: string): SubtitleSyncSnapshot {
  return {
    jobId: null, mode: null, status: 'idle', currentMovie: null,
    attempted: 0, succeeded: 0, failed: 0, message: 'Idle', startedAt: null, updatedAt,
  }
}

function movieSnapshot(movie: SubtitleMovieInput): SubtitleSyncSnapshot['currentMovie'] {
  return { imdbId: movie.imdbId, title: movie.title, releaseYear: movie.year }
}

function copySnapshot(snapshot: SubtitleSyncSnapshot): SubtitleSyncSnapshot {
  return { ...snapshot, currentMovie: snapshot.currentMovie === null ? null : { ...snapshot.currentMovie } }
}

function copyEvent(event: SubtitleSyncEvent): SubtitleSyncEvent {
  return { sequence: event.sequence, snapshot: copySnapshot(event.snapshot) }
}

function isSnapshot(value: unknown): value is SubtitleSyncSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const snapshot = value as Record<string, unknown>
  return (snapshot.jobId === null || typeof snapshot.jobId === 'string')
    && (snapshot.mode === null || snapshot.mode === 'automatic' || snapshot.mode === 'manual')
    && isStatus(snapshot.status)
    && (snapshot.currentMovie === null || isMovieInput(snapshot.currentMovie))
    && counts(snapshot.attempted, snapshot.succeeded, snapshot.failed)
    && typeof snapshot.message === 'string' && safeMessages.has(snapshot.message)
    && (snapshot.startedAt === null || typeof snapshot.startedAt === 'string')
    && typeof snapshot.updatedAt === 'string'
}

function isStatus(value: unknown): value is SubtitleSyncStatus {
  return value === 'idle' || value === 'running' || value === 'completed' || value === 'quota_reached'
    || value === 'candidate_exhausted' || value === 'stopped' || value === 'configuration_error' || value === 'failed'
}

function counts(...values: unknown[]): boolean {
  return values.every(value => Number.isSafeInteger(value) && (value as number) >= 0)
}

function snapshotFrom(snapshot: SubtitleSyncSnapshot): SubtitleSyncSnapshot {
  return {
    jobId: snapshot.jobId,
    mode: snapshot.mode,
    status: snapshot.status,
    currentMovie: snapshot.currentMovie === null ? null : {
      imdbId: snapshot.currentMovie.imdbId,
      title: snapshot.currentMovie.title,
      releaseYear: snapshot.currentMovie.releaseYear,
    },
    attempted: snapshot.attempted,
    succeeded: snapshot.succeeded,
    failed: snapshot.failed,
    message: snapshot.message,
    startedAt: snapshot.startedAt,
    updatedAt: snapshot.updatedAt,
  }
}
