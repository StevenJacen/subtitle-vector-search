import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWorkbenchTask,
  listWorkbenchTasks,
  nextWorkbenchStage,
  readWorkbenchReviewState,
  readWorkbenchTask,
  updateWorkbenchReviewState,
  updateWorkbenchTask,
  writeWorkbenchReviewState,
  type WorkbenchManifest,
  type WorkbenchReviewState,
} from '../src/workbench/artifacts-v2.js'

vi.mock('node:fs/promises', { spy: true })

const taskId = 'd62a53a1-08fb-4bee-a1ed-d8ba13de85f2'
const renderId = '11111111-2222-4333-8444-555555555555'
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(process.cwd(), 'test-workbench-v2-'))
  roots.push(root)
  return root
}

function manifestFor(sceneCount = 5): WorkbenchManifest {
  const cues = Array.from({ length: sceneCount }, (_, index) => ({
    trackId: 7,
    cueIndex: 30 + index,
    startMs: 5_000 + index * 3_000,
    endMs: 8_000 + index * 3_000,
    text: `Exact cue ${index + 1}.`,
    timestamp: `00:00:${String(5 + index * 3).padStart(2, '0')}.000 --> 00:00:${String(8 + index * 3).padStart(2, '0')}.000`,
  }))
  return {
    version: 2,
    taskId,
    renderId: null,
    requestDigest: 'a'.repeat(64),
    theme: 'Crossing darkness toward dawn',
    aspectRatio: '16:9',
    width: 1920,
    height: 1080,
    sceneCount,
    passage: {
      movie: { id: 9, title: 'Example Film', releaseYear: 1994 },
      trackId: 7,
      startCueIndex: 30,
      endCueIndex: 29 + sceneCount,
      totalDurationMs: sceneCount * 3_000,
      cues,
    },
    scenes: cues.map((cue, index) => ({
      index,
      cueIndex: cue.cueIndex,
      durationMs: cue.endMs - cue.startMs,
      captionEn: cue.text,
      plan: {
        captionZh: `\u53f0\u8bcd${index + 1}`,
        visualConcept: `person crossing an open landscape ${index + 1}`,
      },
      selected: null,
      confirmed: null,
    })),
    formalReservations: [],
    sources: [],
    stage: 'review',
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
  }
}

function selectedManifest(sceneCount = 5): WorkbenchManifest {
  const manifest = manifestFor(sceneCount)
  return {
    ...manifest,
    renderId,
    scenes: manifest.scenes.map((scene, index) => {
      const selection = {
        runId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        resourceId: 100 + index,
        selectionId: 200 + index,
      }
      return { ...scene, selected: selection, confirmed: selection }
    }),
    stage: 'preflight',
  }
}

function productionManifest(sceneCount = 5): WorkbenchManifest {
  const manifest = selectedManifest(sceneCount)
  const formalReservations = manifest.scenes.map((scene, index) => ({
    sceneIndex: index,
    reservationId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    runId: scene.confirmed!.runId,
    resourceId: scene.confirmed!.resourceId,
    selectionId: scene.confirmed!.selectionId,
    status: 'completed' as const,
  }))
  const sources = formalReservations.map((reservation, index) => ({
    sceneIndex: index,
    reservationId: reservation.reservationId,
    selectionId: reservation.selectionId,
    artifactKey: `video-runs/${taskId}/assets/scene-${index + 1}.mp4`,
    sha256: String(index + 1).repeat(64).slice(0, 64),
    sizeBytes: 1_000 + index,
    width: 1920,
    height: 1080,
    durationMs: 4_000,
    frameRate: 30,
    videoCodec: 'h264',
    audioCodec: null,
  }))
  return { ...manifest, formalReservations, sources, stage: 'rendering' }
}

function completedManifest(sceneCount = 5): WorkbenchManifest {
  const manifest = productionManifest(sceneCount)
  return {
    ...manifest,
    output: {
      artifactKey: `video-runs/${taskId}/final.mp4`,
      sha256: 'f'.repeat(64),
      sizeBytes: 20_000,
      durationMs: manifest.passage.totalDurationMs,
      width: manifest.width,
      height: manifest.height,
      frameRate: 30,
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      audioCodec: null,
      ffmpegVersion: '7.1',
    },
    stage: 'completed',
  }
}

function reviewState(manifest = manifestFor()): WorkbenchReviewState {
  return {
    version: 1,
    taskId: manifest.taskId,
    scenes: manifest.scenes.map((_, sceneIndex) => ({
      pages: [Array.from({ length: 8 }, (_, index) => ({
        provider: 'vecteezy' as const,
        resourceId: sceneIndex * 100 + index + 1,
        runId: `20000000-0000-4000-8000-${String(sceneIndex + 1).padStart(12, '0')}`,
        page: 1,
        title: `Candidate ${index + 1}`,
        previewId: `30000000-0000-4000-8000-${String(sceneIndex * 10 + index + 1).padStart(12, '0')}`,
        orientation: 'horizontal',
        licenseType: 'free',
        aiGenerated: false,
        score: 1 - index / 100,
        suitabilityScore: 0.8,
        providerRank: index + 1,
      }))],
      recommended: {
        runId: `20000000-0000-4000-8000-${String(sceneIndex + 1).padStart(12, '0')}`,
        resourceId: sceneIndex * 100 + 1,
      },
      hasNextPage: true,
    })),
  }
}

describe('workbench v2 manifest contract', () => {
  it.each([5, 10])('round-trips a complete %i-scene manifest at its versioned path', async sceneCount => {
    const root = await temporaryRoot()
    const manifest = manifestFor(sceneCount)

    await createWorkbenchTask(root, manifest)

    expect(await readWorkbenchTask(root, taskId)).toEqual(manifest)
    await expect(fs.readFile(join(root, 'video-runs', taskId, 'manifest-v2.json'), 'utf8'))
      .resolves.toContain('"version": 2')
  })

  it('accepts only the canonical portrait and landscape dimensions', async () => {
    const root = await temporaryRoot()
    const portrait = { ...manifestFor(), aspectRatio: '9:16' as const, width: 1080, height: 1920 }
    await createWorkbenchTask(root, portrait)
    expect((await readWorkbenchTask(root, taskId)).aspectRatio).toBe('9:16')

    const invalid = { ...portrait, width: 1920 }
    await expect(createWorkbenchTask(await temporaryRoot(), invalid)).rejects.toThrow('invalid workbench manifest')
  })

  it.each([
    ['non UUID owner', (value: WorkbenchManifest) => ({ ...value, taskId: 'task-1' })],
    ['invalid digest', (value: WorkbenchManifest) => ({ ...value, requestDigest: 'abc' })],
    ['four scenes', (value: WorkbenchManifest) => ({ ...value, sceneCount: 4 })],
    ['scene count mismatch', (value: WorkbenchManifest) => ({ ...value, sceneCount: 6 })],
    ['mixed tracks', (value: WorkbenchManifest) => ({ ...value, passage: { ...value.passage, cues: value.passage.cues.map((cue, index) => index === 2 ? { ...cue, trackId: 8 } : cue) } })],
    ['nonconsecutive cues', (value: WorkbenchManifest) => ({ ...value, passage: { ...value.passage, cues: value.passage.cues.map((cue, index) => index === 2 ? { ...cue, cueIndex: 99 } : cue) } })],
    ['wrong timestamp', (value: WorkbenchManifest) => ({ ...value, passage: { ...value.passage, cues: value.passage.cues.map((cue, index) => index === 0 ? { ...cue, timestamp: '00:00:00.000 --> 00:00:01.000' } : cue) } })],
    ['changed English', (value: WorkbenchManifest) => ({ ...value, scenes: value.scenes.map((scene, index) => index === 0 ? { ...scene, captionEn: 'Changed.' } : scene) })],
    ['wrong duration', (value: WorkbenchManifest) => ({ ...value, scenes: value.scenes.map((scene, index) => index === 0 ? { ...scene, durationMs: 2_999 } : scene) })],
    ['missing translation', (value: WorkbenchManifest) => ({ ...value, scenes: value.scenes.map((scene, index) => index === 0 ? { ...scene, plan: { ...scene.plan, captionZh: '' } } : scene) })],
    ['missing concept', (value: WorkbenchManifest) => ({ ...value, scenes: value.scenes.map((scene, index) => index === 0 ? { ...scene, plan: { ...scene.plan, visualConcept: '' } } : scene) })],
  ] satisfies Array<[string, (value: WorkbenchManifest) => WorkbenchManifest]>)('rejects %s', async (_label, mutate) => {
    const invalid = mutate(manifestFor())
    await expect(createWorkbenchTask(await temporaryRoot(), invalid)).rejects.toThrow('invalid workbench manifest')
  })

  it('rejects passages outside 15-60 seconds and cues below 1.2 seconds', async () => {
    const shortTotal = manifestFor()
    shortTotal.passage.totalDurationMs = 14_999
    await expect(createWorkbenchTask(await temporaryRoot(), shortTotal)).rejects.toThrow('invalid workbench manifest')

    const shortCue = manifestFor()
    shortCue.passage.cues[0] = { ...shortCue.passage.cues[0], endMs: shortCue.passage.cues[0].startMs + 1_199 }
    await expect(createWorkbenchTask(await temporaryRoot(), shortCue)).rejects.toThrow('invalid workbench manifest')
  })

  it('requires selected and confirmed identities to agree and reservations to own them', async () => {
    const root = await temporaryRoot()
    const valid = productionManifest()
    await createWorkbenchTask(root, valid)

    const mismatchedConfirmation = selectedManifest()
    mismatchedConfirmation.scenes[0] = {
      ...mismatchedConfirmation.scenes[0],
      confirmed: { ...mismatchedConfirmation.scenes[0].confirmed!, resourceId: 999 },
    }
    await expect(createWorkbenchTask(await temporaryRoot(), mismatchedConfirmation))
      .rejects.toThrow('invalid workbench manifest')

    const mismatchedReservation = productionManifest()
    mismatchedReservation.formalReservations[0] = {
      ...mismatchedReservation.formalReservations[0],
      runId: '40000000-0000-4000-8000-000000000001',
    }
    await expect(createWorkbenchTask(await temporaryRoot(), mismatchedReservation))
      .rejects.toThrow('invalid workbench manifest')
  })

  it('requires stage-specific render, reservation, source, output, and failure state', async () => {
    const invalidDownloading = { ...selectedManifest(), stage: 'downloading' as const }
    await expect(createWorkbenchTask(await temporaryRoot(), invalidDownloading)).rejects.toThrow('invalid workbench manifest')

    const missingOutput = { ...productionManifest(), stage: 'completed' as const }
    await expect(createWorkbenchTask(await temporaryRoot(), missingOutput)).rejects.toThrow('invalid workbench manifest')

    const failedWithoutFailure = { ...productionManifest(), stage: 'failed' as const }
    await expect(createWorkbenchTask(await temporaryRoot(), failedWithoutFailure)).rejects.toThrow('invalid workbench manifest')

    await createWorkbenchTask(await temporaryRoot(), completedManifest())
  })

  it('requires silent H.264 yuv420p output with selected dimensions and exact duration', async () => {
    const completed = completedManifest()
    const audible = {
      ...completed,
      output: { ...completed.output!, audioCodec: 'aac' },
    } as unknown as WorkbenchManifest
    await expect(createWorkbenchTask(await temporaryRoot(), audible)).rejects.toThrow('invalid workbench manifest')

    const wrongDuration = completedManifest()
    wrongDuration.output = { ...wrongDuration.output!, durationMs: wrongDuration.output!.durationMs + 1 }
    await expect(createWorkbenchTask(await temporaryRoot(), wrongDuration)).rejects.toThrow('invalid workbench manifest')
  })

  it.each([
    ['raw preview URL', (value: WorkbenchManifest) => ({ ...value, failure: { code: 'x', message: 'https://media.vecteezy.com/a.mp4', retryable: true }, stage: 'failed' as const })],
    ['sensitive key', (value: WorkbenchManifest) => ({ ...value, apiToken: 'secret' })],
    ['absolute artifact path', (value: WorkbenchManifest) => ({ ...completedManifest(), output: { ...completedManifest().output!, artifactKey: 'C:/temp/final.mp4' } })],
  ])('rejects %s anywhere in durable data', async (_label, mutate) => {
    await expect(createWorkbenchTask(await temporaryRoot(), mutate(manifestFor()) as WorkbenchManifest))
      .rejects.toThrow('invalid workbench manifest')
  })
})

describe('workbench v2 storage and history', () => {
  it('atomically writes manifest and review state beneath the task directory', async () => {
    const root = await temporaryRoot()
    const manifest = manifestFor()
    const review = reviewState(manifest)
    await createWorkbenchTask(root, manifest)
    vi.mocked(fs.rename).mockClear()

    await writeWorkbenchReviewState(root, taskId, review)

    expect(await readWorkbenchReviewState(root, taskId)).toEqual(review)
    expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(1)
    expect(await fs.readdir(join(root, 'video-runs', taskId))).toEqual(['manifest-v2.json', 'review-state.json'])
  })

  it('serializes concurrent manifest and review updates without losing either change', async () => {
    const root = await temporaryRoot()
    await createWorkbenchTask(root, manifestFor())
    await writeWorkbenchReviewState(root, taskId, reviewState())

    await Promise.all([
      updateWorkbenchTask(root, taskId, current => ({ ...current, theme: `${current.theme} A` }), () => new Date('2026-07-21T00:00:01.000Z')),
      updateWorkbenchTask(root, taskId, current => ({ ...current, theme: `${current.theme} B` }), () => new Date('2026-07-21T00:00:02.000Z')),
      updateWorkbenchReviewState(root, taskId, current => ({ ...current, scenes: current.scenes.map((scene, index) => index === 0 ? { ...scene, hasNextPage: false } : scene) })),
    ])

    const updated = await readWorkbenchTask(root, taskId)
    expect(updated.theme).toContain(' A')
    expect(updated.theme).toContain(' B')
    expect((await readWorkbenchReviewState(root, taskId)).scenes[0].hasNextPage).toBe(false)
  })

  it('rejects a symlinked task directory without touching its target', async context => {
    const root = await temporaryRoot()
    const external = await temporaryRoot()
    const taskDirectory = join(root, 'video-runs', taskId)
    await fs.mkdir(dirname(taskDirectory), { recursive: true })
    await fs.writeFile(join(external, 'sentinel.txt'), 'untouched')
    try {
      await fs.symlink(external, taskDirectory, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (isNodeError(error) && error.code === 'EPERM') {
        context.skip('symlink or junction creation is not permitted on this host')
        return
      }
      throw error
    }

    await expect(createWorkbenchTask(root, manifestFor())).rejects.toThrow('unsafe workbench path')
    expect(await fs.readdir(external)).toEqual(['sentinel.txt'])
  })

  it('rejects symlinked manifest and review files', async context => {
    const root = await temporaryRoot()
    const external = await temporaryRoot()
    await createWorkbenchTask(root, manifestFor(), reviewState())

    for (const [filename, read] of [
      ['manifest-v2.json', () => readWorkbenchTask(root, taskId)],
      ['review-state.json', () => readWorkbenchReviewState(root, taskId)],
    ] as const) {
      const destination = join(root, 'video-runs', taskId, filename)
      const target = join(external, filename)
      await fs.writeFile(target, await fs.readFile(destination))
      await fs.rm(destination)
      try {
        await fs.symlink(target, destination, 'file')
      } catch (error) {
        if (isNodeError(error) && error.code === 'EPERM') {
          context.skip('file symlink creation is not permitted on this host')
          return
        }
        throw error
      }

      await expect(read()).rejects.toThrow('unsafe workbench path')
      await fs.rm(destination)
    }
  })

  it('checks each durable JSON file before reading it', async () => {
    const root = await temporaryRoot()
    await createWorkbenchTask(root, manifestFor(), reviewState())
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(fs.lstat).mockImplementation(async path => {
      const stats = await realFs.lstat(path)
      if (String(path).endsWith('manifest-v2.json')) {
        return { ...stats, isFile: () => false, isSymbolicLink: () => true } as typeof stats
      }
      return stats
    })

    try {
      await expect(readWorkbenchTask(root, taskId)).rejects.toThrow('unsafe workbench path')
    } finally {
      vi.mocked(fs.lstat).mockRestore()
    }
  })

  it('isolates corrupt history entries and orders valid tasks by updatedAt then taskId', async () => {
    const root = await temporaryRoot()
    const laterId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const sameTimeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    await createWorkbenchTask(root, { ...manifestFor(), taskId: laterId, updatedAt: '2026-07-21T00:00:02.000Z' })
    await createWorkbenchTask(root, { ...manifestFor(), taskId: sameTimeId, updatedAt: '2026-07-21T00:00:02.000Z' })
    await createWorkbenchTask(root, manifestFor())
    const corruptId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const corruptDirectory = join(root, 'video-runs', corruptId)
    await fs.mkdir(corruptDirectory, { recursive: true })
    await fs.writeFile(join(corruptDirectory, 'manifest-v2.json'), '{broken')

    expect((await listWorkbenchTasks(root)).map(task => task.taskId)).toEqual([laterId, sameTimeId, taskId])
  })

  it('keeps completed tasks immutable while allowing an identical completion retry', async () => {
    const root = await temporaryRoot()
    const completed = completedManifest()
    await createWorkbenchTask(root, completed)
    vi.mocked(fs.rename).mockClear()

    await updateWorkbenchTask(root, taskId, current => current)
    expect(vi.mocked(fs.rename)).not.toHaveBeenCalled()
    await expect(updateWorkbenchTask(root, taskId, current => ({ ...current, theme: 'changed' })))
      .rejects.toThrow('completed_workbench_immutable')
  })

  it('rejects URLs in review pages and verifies selected ownership against the candidate pool', async () => {
    const root = await temporaryRoot()
    const manifest = manifestFor()
    await createWorkbenchTask(root, manifest)
    const withUrl = reviewState(manifest) as WorkbenchReviewState & { previewUrl?: string }
    withUrl.previewUrl = 'https://media.vecteezy.com/a.mp4'
    await expect(writeWorkbenchReviewState(root, taskId, withUrl)).rejects.toThrow('invalid workbench review state')

    const selected = reviewState(manifest)
    selected.scenes[0] = {
      ...selected.scenes[0],
      selected: { runId: '50000000-0000-4000-8000-000000000001', resourceId: 1 },
    }
    await expect(writeWorkbenchReviewState(root, taskId, selected)).rejects.toThrow('invalid workbench review state')
  })
})

describe('workbench resume stage', () => {
  it('reuses only verified source and output hashes', () => {
    const manifest = productionManifest()
    const hashes = Object.fromEntries(manifest.sources.map(source => [source.artifactKey, source.sha256]))
    expect(nextWorkbenchStage(manifest, { hashes })).toBe('rendering')

    const completed = completedManifest()
    const completedHashes = {
      ...Object.fromEntries(completed.sources.map(source => [source.artifactKey, source.sha256])),
      [completed.output!.artifactKey]: completed.output!.sha256,
    }
    expect(nextWorkbenchStage(completed, { hashes: completedHashes })).toBe('completed')
    expect(nextWorkbenchStage(completed, { hashes: { ...completedHashes, [completed.sources[0].artifactKey]: '0'.repeat(64) } }))
      .toBe('downloading')
  })

  it('never re-spends an uncertain formal reservation', () => {
    const manifest = productionManifest()
    manifest.formalReservations[0] = { ...manifest.formalReservations[0], status: 'uncertain' }
    manifest.sources = manifest.sources.slice(1)
    manifest.stage = 'failed'
    manifest.failure = { code: 'formal_call_uncertain', message: 'Formal download outcome is uncertain', retryable: false }

    expect(nextWorkbenchStage(manifest, { hashes: {} })).toBe('failed')
  })

  it('retries only idempotent completion after final output has been verified', () => {
    const manifest = completedManifest()
    manifest.stage = 'failed'
    manifest.failure = { code: 'completion_failed', message: 'Metadata completion failed', retryable: true }
    const hashes = {
      ...Object.fromEntries(manifest.sources.map(source => [source.artifactKey, source.sha256])),
      [manifest.output!.artifactKey]: manifest.output!.sha256,
    }

    expect(nextWorkbenchStage(manifest, { hashes })).toBe('completing')
    expect(nextWorkbenchStage(manifest, { hashes: { ...hashes, [manifest.output!.artifactKey]: '0'.repeat(64) } }))
      .toBe('rendering')
  })
})

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
