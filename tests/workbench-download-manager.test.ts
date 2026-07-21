import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SceneCandidateState } from '../src/workbench/candidate-pool.js'
import type {
  WorkbenchFormalReservation,
  WorkbenchDownloadReceipt,
  WorkbenchManifest,
  WorkbenchSelection,
  WorkbenchSource,
} from '../src/workbench/artifacts-v2.js'
import { FormalDownloadBudget, VecteezyDownloadError } from '../src/vecteezy-download.js'
import {
  downloadConfirmedScenes,
  preflightSelections,
  type ConfirmedScene,
  type WorkbenchArtifactStore,
} from '../src/workbench/download-manager.js'

const TASK_ID = '10000000-0000-4000-8000-000000000001'
const RUN_ID = '20000000-0000-4000-8000-000000000001'
const MiB = 1024 * 1024
const SHA256 = 'a'.repeat(64)

function scene(index: number): ConfirmedScene {
  const selection: WorkbenchSelection = {
    runId: RUN_ID,
    resourceId: 100 + index,
    selectionId: 1_000 + index,
  }
  const candidates: SceneCandidateState = {
    pages: [[{
      provider: 'vecteezy',
      resourceId: selection.resourceId,
      runId: selection.runId,
      page: 1,
      title: null,
      previewId: null,
      orientation: 'landscape',
      licenseType: 'free',
      aiGenerated: false,
      score: 0.9,
      suitabilityScore: 1,
      providerRank: index + 1,
    }]],
    selected: { runId: selection.runId, resourceId: selection.resourceId },
    confirmed: { runId: selection.runId, resourceId: selection.resourceId },
    hasNextPage: false,
  }
  return { index, selected: selection, confirmed: { ...selection }, candidates }
}

function scenes(count: number): ConfirmedScene[] {
  return Array.from({ length: count }, (_, index) => scene(index))
}

function downloadInfo(resourceId: number, sourceSizeBytes = 1 * MiB) {
  return {
    resourceId,
    sourceSizeBytes,
    requiresAttribution: false,
    requiredAttributionUrl: null,
    quota: { limit: 100, remaining: 99 },
  }
}

function manifestFor(inputScenes: readonly ConfirmedScene[]): WorkbenchManifest {
  return {
    taskId: TASK_ID,
    sceneCount: inputScenes.length,
    scenes: inputScenes.map(value => ({
      index: value.index,
      selected: value.selected,
      confirmed: value.confirmed,
    })),
    formalReservations: [],
    sources: [],
    stage: 'preflight',
  } as unknown as WorkbenchManifest
}

function artifactStore(initial: WorkbenchManifest) {
  let current = structuredClone(initial)
  const events: string[] = []
  const store: WorkbenchArtifactStore = {
    readTask: vi.fn(async taskId => {
      expect(taskId).toBe(TASK_ID)
      return structuredClone(current)
    }),
    updateTask: vi.fn(async (taskId, updater) => {
      expect(taskId).toBe(TASK_ID)
      current = await updater(structuredClone(current))
      events.push('persist')
      return structuredClone(current)
    }),
    verifyReceipt: vi.fn(async () => false),
  }
  return { store, events, current: () => current }
}

function downloadClient(events: string[] = []) {
  let nextRequestId = 1
  return {
    seedAggregateSizeBytes: vi.fn(),
    getDownloadInfo: vi.fn(async (resourceId: number) => downloadInfo(resourceId)),
    requestDownloadWithInfo: vi.fn(async (info: ReturnType<typeof downloadInfo>, _budget: FormalDownloadBudget, _reservationId: string) => {
      events.push('formal')
      return { ...info, requestId: nextRequestId++ }
    }),
    waitForDownload: vi.fn(async (request: { requestId: number; resourceId: number }) => request),
    transferSignedUrl: vi.fn(async (_ready: unknown, destination: string) => ({
      artifactKey: destination,
      sourceSizeBytes: 5,
      sourceSha256: SHA256,
      requiresAttribution: false,
      requiredAttributionUrl: null,
      quota: { limit: 100, remaining: 99 },
    })),
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('workbench download preflight', () => {
  it.each([5, 10])('preflights all %i confirmed scenes without a formal call', async count => {
    const inputScenes = scenes(count)
    const inspect = { getDownloadInfo: vi.fn(async (resourceId: number) => downloadInfo(resourceId)) }

    const result = await preflightSelections({ taskId: TASK_ID, scenes: inputScenes, inspect })

    expect(result).toHaveLength(count)
    expect(inspect.getDownloadInfo).toHaveBeenCalledTimes(count)
    expect(result.map(value => value.sceneIndex)).toEqual(Array.from({ length: count }, (_, index) => index))
  })

  it.each([4, 11])('rejects an invalid v2 scene count of %i before inspection', async count => {
    const inspect = { getDownloadInfo: vi.fn() }

    await expect(preflightSelections({ taskId: TASK_ID, scenes: scenes(count), inspect }))
      .rejects.toMatchObject({ code: 'invalid_scene_count' })
    expect(inspect.getDownloadInfo).not.toHaveBeenCalled()
  })

  it('validates every owning run, resource, and selection before inspecting anything', async () => {
    const inputScenes = scenes(5)
    inputScenes[4] = { ...inputScenes[4], confirmed: { ...inputScenes[4].confirmed, selectionId: 999_999 } }
    const inspect = { getDownloadInfo: vi.fn() }

    await expect(preflightSelections({ taskId: TASK_ID, scenes: inputScenes, inspect }))
      .rejects.toMatchObject({ code: 'selection_ownership_mismatch' })
    expect(inspect.getDownloadInfo).not.toHaveBeenCalled()
  })

  it('retains the 512 MiB per-file and 2 GiB aggregate limits during preflight', async () => {
    const inputScenes = scenes(5)
    const oversized = { getDownloadInfo: vi.fn(async (resourceId: number) => downloadInfo(resourceId, 512 * MiB + 1)) }

    await expect(preflightSelections({ taskId: TASK_ID, scenes: inputScenes, inspect: oversized }))
      .rejects.toMatchObject({ code: 'file_size_limit_exceeded' })

    const aggregate = { getDownloadInfo: vi.fn(async (resourceId: number) => downloadInfo(resourceId, 410 * MiB)) }
    await expect(preflightSelections({ taskId: TASK_ID, scenes: inputScenes, inspect: aggregate }))
      .rejects.toMatchObject({ code: 'aggregate_size_limit_exceeded' })
  })
})

describe('workbench formal downloads', () => {
  it('rejects a v1-sized budget before v2 preflight or persistence', async () => {
    const inputScenes = scenes(5)
    const artifacts = artifactStore(manifestFor(inputScenes))
    const client = downloadClient()

    await expect(downloadConfirmedScenes({
      taskId: TASK_ID,
      scenes: inputScenes,
      budget: new FormalDownloadBudget(4),
      artifacts: artifacts.store,
      client,
    })).rejects.toMatchObject({ code: 'invalid_download_budget' })

    expect(client.getDownloadInfo).not.toHaveBeenCalled()
    expect(client.requestDownloadWithInfo).not.toHaveBeenCalled()
    expect(artifacts.store.updateTask).not.toHaveBeenCalled()
  })

  it('marks an uncertain formal call and never silently retries it', async () => {
    const inputScenes = scenes(5)
    const artifacts = artifactStore(manifestFor(inputScenes))
    const client = downloadClient()
    client.requestDownloadWithInfo.mockRejectedValueOnce(new VecteezyDownloadError('provider_request_failed', 'failed'))

    const run = () => downloadConfirmedScenes({
      taskId: TASK_ID,
      scenes: inputScenes,
      budget: new FormalDownloadBudget(5),
      artifacts: artifacts.store,
      client,
    })

    await expect(run()).rejects.toMatchObject({ code: 'formal_call_uncertain' })
    await expect(run()).rejects.toMatchObject({ code: 'formal_call_uncertain' })
    expect(client.requestDownloadWithInfo).toHaveBeenCalledTimes(1)
    expect(artifacts.current().formalReservations[0]).toMatchObject({ status: 'uncertain' })
  })

  it('persists each reservation before exactly one formal call per scene', async () => {
    const inputScenes = scenes(5)
    const artifacts = artifactStore(manifestFor(inputScenes))
    const client = downloadClient(artifacts.events)

    const result = await downloadConfirmedScenes({
      taskId: TASK_ID,
      scenes: inputScenes,
      budget: new FormalDownloadBudget(5),
      artifacts: artifacts.store,
      client,
    })

    expect(result).toHaveLength(5)
    expect(client.getDownloadInfo).toHaveBeenCalledTimes(5)
    expect(client.requestDownloadWithInfo).toHaveBeenCalledTimes(5)
    expect(client.seedAggregateSizeBytes).toHaveBeenCalledWith(0)
    expect(artifacts.current().formalReservations.every(reservation => (
      reservation.status === 'completed' && reservation.receipt !== undefined
    ))).toBe(true)
    expect(JSON.stringify(artifacts.current().formalReservations)).not.toMatch(/url/i)
    expect(artifacts.events).toEqual([
      'persist', 'formal', 'persist', 'persist', 'formal', 'persist', 'persist', 'formal', 'persist',
      'persist', 'formal', 'persist', 'persist', 'formal', 'persist',
    ])
  })

  it('rejects a changed resource before preflight or another formal call', async () => {
    const inputScenes = scenes(5)
    const manifest = manifestFor(inputScenes)
    manifest.formalReservations = [{
      sceneIndex: 0,
      reservationId: '30000000-0000-4000-8000-000000000001',
      ...inputScenes[0].confirmed,
      resourceId: 999,
      status: 'completed',
    }]
    const artifacts = artifactStore(manifest)
    const client = downloadClient()

    await expect(downloadConfirmedScenes({
      taskId: TASK_ID,
      scenes: inputScenes,
      budget: new FormalDownloadBudget(5),
      artifacts: artifacts.store,
      client,
    })).rejects.toMatchObject({ code: 'resource_changed' })
    expect(client.getDownloadInfo).not.toHaveBeenCalled()
    expect(client.requestDownloadWithInfo).not.toHaveBeenCalled()
  })

  it('reuses existing source metadata only when its local hash verifies', async () => {
    const inputScenes = scenes(5)
    const manifest = manifestFor(inputScenes)
    manifest.formalReservations = inputScenes.map((value, index): WorkbenchFormalReservation => ({
      sceneIndex: index,
      reservationId: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      ...value.confirmed,
      status: 'completed',
    }))
    manifest.sources = manifest.formalReservations.map((reservation, index): WorkbenchSource => ({
      sceneIndex: index,
      reservationId: reservation.reservationId,
      selectionId: reservation.selectionId,
      artifactKey: `video-runs/${TASK_ID}/sources/scene-${index}.mp4`,
      sha256: SHA256,
      sizeBytes: 5,
      width: 1920,
      height: 1080,
      durationMs: 3_000,
      frameRate: 30,
      videoCodec: 'h264',
      audioCodec: null,
    }))
    manifest.formalReservations = manifest.formalReservations.map((reservation, index) => ({
      ...reservation,
      receipt: {
        taskId: TASK_ID,
        sceneIndex: index,
        reservationId: reservation.reservationId,
        artifactKey: manifest.sources[index].artifactKey,
        sha256: manifest.sources[index].sha256,
        sizeBytes: manifest.sources[index].sizeBytes,
      },
    }))
    const artifacts = artifactStore(manifest)
    vi.mocked(artifacts.store.verifyReceipt).mockResolvedValue(true)
    const client = downloadClient()

    const result = await downloadConfirmedScenes({
      taskId: TASK_ID,
      scenes: inputScenes,
      budget: new FormalDownloadBudget(5),
      artifacts: artifacts.store,
      client,
    })

    expect(result.map(value => value.sourceSha256)).toEqual(Array(5).fill(SHA256))
    expect(result[0]).toMatchObject({
      requiresAttribution: false,
      requiredAttributionUrl: null,
      quota: { limit: 100, remaining: 99 },
    })
    expect(client.getDownloadInfo).toHaveBeenCalledTimes(5)
    expect(client.requestDownloadWithInfo).not.toHaveBeenCalled()
  })

  it('treats a completed legacy reservation without a receipt as uncertain', async () => {
    const inputScenes = scenes(5)
    const manifest = manifestFor(inputScenes)
    manifest.formalReservations = [{
      sceneIndex: 0,
      reservationId: '30000000-0000-4000-8000-000000000001',
      ...inputScenes[0].confirmed,
      status: 'completed',
    }]
    const artifacts = artifactStore(manifest)
    const client = downloadClient()

    await expect(downloadConfirmedScenes({
      taskId: TASK_ID,
      scenes: inputScenes,
      budget: new FormalDownloadBudget(5),
      artifacts: artifacts.store,
      client,
    })).rejects.toMatchObject({ code: 'formal_call_uncertain' })

    expect(artifacts.store.verifyReceipt).not.toHaveBeenCalled()
    expect(client.getDownloadInfo).not.toHaveBeenCalled()
    expect(client.requestDownloadWithInfo).not.toHaveBeenCalled()
  })

  it('counts reusable receipts before pending preflight and rejects over 2 GiB with zero formal calls', async () => {
    const inputScenes = scenes(5)
    const manifest = manifestFor(inputScenes)
    const existingSize = 500 * MiB
    manifest.formalReservations = inputScenes.slice(0, 4).map((value, index): WorkbenchFormalReservation => {
      const reservationId = `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
      const receipt: WorkbenchDownloadReceipt = {
        taskId: TASK_ID,
        sceneIndex: index,
        reservationId,
        artifactKey: `video-runs/${TASK_ID}/sources/scene-${index}.mp4`,
        sha256: SHA256,
        sizeBytes: existingSize,
      }
      return { sceneIndex: index, reservationId, ...value.confirmed, status: 'completed', receipt }
    })
    const artifacts = artifactStore(manifest)
    vi.mocked(artifacts.store.verifyReceipt).mockResolvedValue(true)
    const client = downloadClient()
    client.getDownloadInfo.mockImplementation(async (resourceId: number) => downloadInfo(resourceId, 100 * MiB))

    await expect(downloadConfirmedScenes({
      taskId: TASK_ID,
      scenes: inputScenes,
      budget: new FormalDownloadBudget(5),
      artifacts: artifacts.store,
      client,
    })).rejects.toMatchObject({ code: 'aggregate_size_limit_exceeded' })

    expect(client.getDownloadInfo).toHaveBeenCalledTimes(5)
    expect(client.requestDownloadWithInfo).not.toHaveBeenCalled()
    expect(artifacts.store.updateTask).not.toHaveBeenCalled()
  })
})
