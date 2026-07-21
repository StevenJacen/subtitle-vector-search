import { describe, expect, it, vi } from 'vitest'
import { SubtitleSyncController, type SubtitleSyncDependencies } from '../src/workbench/subtitle-sync.js'

const MOVIE = { imdbId: 'tt2543164', title: 'Arrival', releaseYear: 2016 }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

function setup(overrides: Partial<SubtitleSyncDependencies> = {}, optionOverrides: Record<string, number> = {}) {
  const snapshots: string[] = []
  const writes: Array<{ path: string; text: string }> = []
  const dependencies: SubtitleSyncDependencies = {
    readText: vi.fn(async () => JSON.stringify([
      { imdbId: 'tt2543164', title: 'Arrival', year: 2016, rating: 7.9, votes: 800_000, genres: 'Drama,Mystery,Sci-Fi', score: 100 },
      { imdbId: 'tt0133093', title: 'The Matrix', year: 1999, rating: 8.7, votes: 2_000_000, genres: 'Action,Sci-Fi', score: 99 },
    ])),
    writeText: vi.fn(async (path, text) => {
      writes.push({ path, text })
      if (path === 'snapshot.json') snapshots.push(text)
    }),
    exists: vi.fn(() => false),
    ensureDirectory: vi.fn(async () => undefined),
    downloadMovie: vi.fn(async () => undefined),
    importMovie: vi.fn(async () => undefined),
    now: vi.fn(() => '2026-07-21T00:00:00.000Z'),
    createId: vi.fn(() => 'job-1'),
    ...overrides,
  }
  return { controller: new SubtitleSyncController({
    candidatesPath: 'candidates.json',
    batchStatePath: 'batch-state.json',
    snapshotPath: 'snapshot.json',
    downloadsDir: 'downloads',
    targetSuccessCount: 2,
    maxAttempts: 2,
    ...optionOverrides,
  }, dependencies), dependencies, snapshots, writes }
}

async function settled(controller: SubtitleSyncController) {
  await vi.waitFor(() => expect(controller.snapshot().status).not.toBe('running'))
}

describe('SubtitleSyncController', () => {
  it('allows only one active job across controller instances and releases its own lock', async () => {
    const firstDownload = deferred<void>()
    const first = setup({ downloadMovie: vi.fn(() => firstDownload.promise) })
    const second = setup()

    await first.controller.start({ mode: 'manual', movie: MOVIE })
    expect(() => second.controller.start({ mode: 'automatic' })).toThrowError('subtitle_sync_already_running')

    firstDownload.resolve()
    await settled(first.controller)
    await expect(second.controller.start({ mode: 'manual', movie: MOVIE })).resolves.toMatchObject({ status: 'running' })
    await settled(second.controller)
  })

  it('starts manual work in the background and rejects a second start synchronously', async () => {
    const download = deferred<void>()
    const { controller } = setup({ downloadMovie: vi.fn(() => download.promise) })

    await expect(controller.start({ mode: 'manual', movie: MOVIE })).resolves.toMatchObject({ status: 'running', mode: 'manual' })
    expect(() => controller.start({ mode: 'automatic' })).toThrowError('subtitle_sync_already_running')

    download.resolve()
    await settled(controller)
    expect(controller.snapshot()).toMatchObject({ status: 'completed', attempted: 1, succeeded: 1 })
  })

  it('validates manual input before starting provider work', () => {
    const { controller, dependencies } = setup()

    expect(() => controller.start({ mode: 'manual', movie: { ...MOVIE, imdbId: 'not-imdb' } }))
      .toThrowError('invalid_subtitle_sync_input')
    expect(dependencies.downloadMovie).not.toHaveBeenCalled()
  })

  it('continues automatic work after a movie failure and never persists the provider error', async () => {
    const { controller, dependencies, snapshots, writes } = setup({
      downloadMovie: vi.fn(async movie => {
        if (movie.imdbId === MOVIE.imdbId) throw new Error('provider said token=secret at C:\\private\\download.srt')
      }),
    })
    const events: string[] = []
    controller.events.subscribe(event => events.push(event.snapshot.message))

    await controller.start({ mode: 'automatic' })
    await settled(controller)

    expect(controller.snapshot()).toMatchObject({ status: 'candidate_exhausted', attempted: 2, succeeded: 1, failed: 1 })
    expect(dependencies.downloadMovie).toHaveBeenCalledTimes(2)
    expect(events).toContain('Movie import failed; continuing')
    expect(JSON.stringify(snapshots)).not.toMatch(/secret|private|download\.srt/i)
    expect(JSON.stringify(writes)).not.toMatch(/secret|private|download\.srt/i)
  })

  it('ends automatic work with a quota status and a safe message', async () => {
    const { controller, snapshots } = setup({
      downloadMovie: vi.fn(async () => { throw new Error('HTTP 429 bearer super-secret-token') }),
    })

    await controller.start({ mode: 'automatic' })
    await settled(controller)

    expect(controller.snapshot()).toMatchObject({ status: 'quota_reached', attempted: 1, message: 'Provider quota reached; rerun later' })
    expect(JSON.stringify(snapshots)).not.toContain('super-secret-token')
  })

  it('ends authentication failures as configuration errors', async () => {
    const { controller } = setup({
      downloadMovie: vi.fn(async () => { throw new Error('invalid subtitle token abc123') }),
    })

    await controller.start({ mode: 'manual', movie: MOVIE })
    await settled(controller)

    expect(controller.snapshot()).toMatchObject({ status: 'configuration_error', message: 'Subtitle provider configuration needs attention' })
  })

  it('classifies provider HTTP authentication statuses without exposing their message', async () => {
    const { controller } = setup({
      downloadMovie: vi.fn(async () => { throw Object.assign(new Error('opaque provider response'), { status: 401 }) }),
    })

    await controller.start({ mode: 'manual', movie: MOVIE })
    await settled(controller)

    expect(controller.snapshot()).toMatchObject({ status: 'configuration_error', message: 'Subtitle provider configuration needs attention' })
  })

  it('stops cooperatively after the current movie completes', async () => {
    const first = deferred<void>()
    const { controller, dependencies } = setup({ downloadMovie: vi.fn(() => first.promise) })

    await controller.start({ mode: 'automatic' })
    await vi.waitFor(() => expect(dependencies.downloadMovie).toHaveBeenCalledTimes(1))
    expect(controller.stop()).toMatchObject({ status: 'running' })
    first.resolve()
    await settled(controller)

    expect(controller.snapshot()).toMatchObject({ status: 'stopped', attempted: 1, succeeded: 1 })
    expect(dependencies.downloadMovie).toHaveBeenCalledTimes(1)
  })

  it('stops manual work before the provider operation starts', async () => {
    const { controller, dependencies } = setup()
    const messages: string[] = []
    controller.events.subscribe(event => messages.push(event.snapshot.message))

    await controller.start({ mode: 'manual', movie: MOVIE })
    controller.stop()
    await settled(controller)

    expect(controller.snapshot()).toMatchObject({ status: 'stopped', attempted: 0, succeeded: 0, failed: 0 })
    expect(messages).not.toContain('Importing subtitle')
    expect(dependencies.downloadMovie).not.toHaveBeenCalled()
    expect(dependencies.importMovie).not.toHaveBeenCalled()
  })

  it('does not report candidate exhaustion until automatic mode processes the finite candidate list', async () => {
    const { controller, dependencies } = setup({}, { targetSuccessCount: 3, maxAttempts: 1 })

    await controller.start({ mode: 'automatic' })
    await settled(controller)

    expect(controller.snapshot()).toMatchObject({ status: 'candidate_exhausted', attempted: 2, succeeded: 2 })
    expect(dependencies.downloadMovie).toHaveBeenCalledTimes(2)
  })

  it('reloads only a valid sanitized snapshot', async () => {
    const persisted = JSON.stringify({
      jobId: 'job-0', mode: 'automatic', status: 'stopped', currentMovie: null,
      attempted: 2, succeeded: 1, failed: 1, message: 'Stopped by operator',
      startedAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:01:00.000Z',
      credential: 'must-not-survive',
    })
    const { controller } = setup({ exists: vi.fn(path => path === 'snapshot.json'), readText: vi.fn(async () => persisted) })

    await controller.reload()

    expect(controller.snapshot()).toEqual({
      jobId: 'job-0', mode: 'automatic', status: 'stopped', currentMovie: null,
      attempted: 2, succeeded: 1, failed: 1, message: 'Stopped by operator',
      startedAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:01:00.000Z',
    })
  })

  it('rejects a persisted raw provider message', async () => {
    const persisted = JSON.stringify({
      jobId: 'job-0', mode: 'automatic', status: 'failed', currentMovie: null,
      attempted: 1, succeeded: 0, failed: 1, message: 'HTTP 500 token=secret',
      startedAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:01:00.000Z',
    })
    const { controller } = setup({ exists: vi.fn(path => path === 'snapshot.json'), readText: vi.fn(async () => persisted) })

    await expect(controller.reload()).rejects.toThrow('invalid_subtitle_sync_snapshot')
  })
})
