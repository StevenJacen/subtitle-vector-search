import { describe, expect, it, vi } from 'vitest'
import { runBatchImport } from '../src/batch-classics.js'

const candidates = [
  { imdbId: 'tt0468569', title: 'The Dark Knight', year: 2008, rating: 9.1, votes: 3_000_000, genres: 'Action,Crime,Drama', score: 104 },
  { imdbId: 'tt0108052', title: "Schindler's List", year: 1993, rating: 9, votes: 1_500_000, genres: 'Biography,Drama,History', score: 103 },
]

function deps(overrides: {
  state?: object
  exists?: (path: string) => boolean
  downloadMovie?: () => Promise<void>
  importMovie?: () => Promise<void>
} = {}) {
  const writes: string[] = []
  return {
    writes,
    dependencies: {
      readText: vi.fn(async (path: string) => {
        if (path.includes('state') && overrides.state !== undefined) return JSON.stringify(overrides.state)
        return JSON.stringify(candidates)
      }),
      writeText: vi.fn(async (_path: string, text: string) => {
        writes.push(text)
      }),
      ensureDirectory: vi.fn(async () => undefined),
      exists: overrides.exists ?? vi.fn(() => false),
      downloadMovie: overrides.downloadMovie ?? vi.fn(async () => undefined),
      importMovie: overrides.importMovie ?? vi.fn(async () => undefined),
      now: vi.fn(() => '2026-07-18T00:00:00.000Z'),
      output: vi.fn(),
    },
  }
}

describe('batch classics importer', () => {
  it('downloads and imports candidates until the target succeeds', async () => {
    const context = deps()

    const state = await runBatchImport({
      candidatesPath: 'candidates.json',
      statePath: '.batch-state/state.json',
      downloadsDir: 'downloads/classics',
      targetSuccessCount: 2,
      maxAttempts: 2,
      dryRun: false,
    }, context.dependencies)

    expect(state.successes.map(success => success.imdbId)).toEqual(['tt0468569', 'tt0108052'])
    expect(context.dependencies.downloadMovie).toHaveBeenCalledTimes(2)
    expect(context.dependencies.importMovie).toHaveBeenCalledTimes(2)
    expect(context.writes).toHaveLength(2)
  })

  it('resumes without retrying already successful movies', async () => {
    const context = deps({
      state: {
        successes: [{ imdbId: 'tt0468569', title: 'The Dark Knight', year: 2008, file: 'old.srt', importedAt: 'then' }],
        failures: [],
      },
      exists: vi.fn((path: string) => path.includes('state')),
    })

    const state = await runBatchImport({
      candidatesPath: 'candidates.json',
      statePath: '.batch-state/state.json',
      downloadsDir: 'downloads/classics',
      targetSuccessCount: 2,
      maxAttempts: 2,
      dryRun: false,
    }, context.dependencies)

    expect(state.successes.map(success => success.imdbId)).toEqual(['tt0468569', 'tt0108052'])
    expect(context.dependencies.downloadMovie).toHaveBeenCalledTimes(1)
    expect(context.dependencies.importMovie).toHaveBeenCalledTimes(1)
  })

  it('stops cleanly when the provider quota is reached', async () => {
    const context = deps({
      downloadMovie: vi.fn(async () => {
        throw new Error('HTTP 429 rate limited')
      }),
    })

    const state = await runBatchImport({
      candidatesPath: 'candidates.json',
      statePath: '.batch-state/state.json',
      downloadsDir: 'downloads/classics',
      targetSuccessCount: 2,
      maxAttempts: 2,
      dryRun: false,
    }, context.dependencies)

    expect(state.successes).toEqual([])
    expect(state.failures).toEqual([])
    expect(context.dependencies.downloadMovie).toHaveBeenCalledTimes(1)
    expect(context.dependencies.importMovie).not.toHaveBeenCalled()
  })

  it('stops cleanly without marking a movie failed when subtitle API auth is invalid', async () => {
    const context = deps({
      exists: vi.fn((path: string) => path.endsWith('.srt')),
      importMovie: vi.fn(async () => {
        throw new Error('invalid subtitle token')
      }),
    })

    const state = await runBatchImport({
      candidatesPath: 'candidates.json',
      statePath: '.batch-state/state.json',
      downloadsDir: 'downloads/classics',
      targetSuccessCount: 2,
      maxAttempts: 2,
      dryRun: false,
    }, context.dependencies)

    expect(state.successes).toEqual([])
    expect(state.failures).toEqual([])
    expect(context.dependencies.downloadMovie).not.toHaveBeenCalled()
    expect(context.dependencies.importMovie).toHaveBeenCalledTimes(1)
  })
})
