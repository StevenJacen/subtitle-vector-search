import { randomUUID } from 'node:crypto'
import type { SceneCandidateState } from './candidate-pool.js'
import type {
  WorkbenchFormalReservation,
  WorkbenchManifest,
  WorkbenchSelection,
  WorkbenchSource,
} from './artifacts-v2.js'
import {
  FormalDownloadBudget,
  VecteezyDownloadError,
  type CompletedVecteezyDownload,
  type DownloadReady,
  type FormalDownloadRequest,
  type VecteezyDownloadClient,
  type VecteezyDownloadInfo,
} from '../vecteezy-download.js'

const MAX_FILE_SIZE_BYTES = 512 * 1024 * 1024
const MAX_AGGREGATE_SIZE_BYTES = 2 * 1024 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface ConfirmedScene {
  index: number
  selected: WorkbenchSelection
  confirmed: WorkbenchSelection
  candidates: SceneCandidateState
}

export type ResourceInspector = Pick<VecteezyDownloadClient, 'getDownloadInfo'>

export interface PreflightResult {
  sceneIndex: number
  selection: WorkbenchSelection
  info: VecteezyDownloadInfo
}

export interface VerifiedSceneSource {
  sceneIndex: number
  reservationId: string
  selectionId: number
  resourceId: number
  artifactKey: string
  sourceSizeBytes: number
  sourceSha256: string
}

export interface WorkbenchArtifactStore {
  readTask(taskId: string): Promise<WorkbenchManifest>
  updateTask(
    taskId: string,
    updater: (manifest: WorkbenchManifest) => WorkbenchManifest | Promise<WorkbenchManifest>,
  ): Promise<WorkbenchManifest>
  verifySource(source: WorkbenchSource): Promise<boolean>
}

type WorkbenchDownloadClient = ResourceInspector & Pick<
  VecteezyDownloadClient,
  'requestDownloadWithInfo' | 'waitForDownload' | 'transferSignedUrl'
>

export class WorkbenchDownloadError extends Error {
  constructor(readonly code: string, message = code.replaceAll('_', ' ')) {
    super(message)
    this.name = 'WorkbenchDownloadError'
  }
}

export async function preflightSelections(input: {
  taskId: string
  scenes: readonly ConfirmedScene[]
  inspect: ResourceInspector
}): Promise<PreflightResult[]> {
  validateTaskAndScenes(input.taskId, input.scenes)
  const results = await Promise.all(input.scenes.map(async scene => ({
    sceneIndex: scene.index,
    selection: { ...scene.confirmed },
    info: await input.inspect.getDownloadInfo(scene.confirmed.resourceId),
  })))
  let aggregateSizeBytes = 0
  for (const result of results) {
    if (result.info.resourceId !== result.selection.resourceId) {
      throw new WorkbenchDownloadError('resource_changed')
    }
    if (result.info.sourceSizeBytes > MAX_FILE_SIZE_BYTES) {
      throw new VecteezyDownloadError('file_size_limit_exceeded', 'Vecteezy file exceeds the 512 MiB limit')
    }
    aggregateSizeBytes += result.info.sourceSizeBytes
    if (aggregateSizeBytes > MAX_AGGREGATE_SIZE_BYTES) {
      throw new VecteezyDownloadError('aggregate_size_limit_exceeded', 'Vecteezy downloads exceed the 2 GiB aggregate limit')
    }
  }
  return results
}

export async function downloadConfirmedScenes(input: {
  taskId: string
  scenes: readonly ConfirmedScene[]
  budget: FormalDownloadBudget
  artifacts: WorkbenchArtifactStore
  client: WorkbenchDownloadClient
}): Promise<VerifiedSceneSource[]> {
  validateTaskAndScenes(input.taskId, input.scenes)
  if (input.budget.maximum !== input.scenes.length) {
    throw new WorkbenchDownloadError('invalid_download_budget')
  }
  const manifest = await input.artifacts.readTask(input.taskId)
  validateManifestOwnership(manifest, input.taskId, input.scenes)

  const reusable = new Map<number, VerifiedSceneSource>()
  const pendingScenes: ConfirmedScene[] = []
  for (const scene of input.scenes) {
    const reservation = manifest.formalReservations.find(value => value.sceneIndex === scene.index)
    if (reservation === undefined) {
      pendingScenes.push(scene)
      continue
    }
    if (!sameSelection(reservation, scene.confirmed)) throw new WorkbenchDownloadError('resource_changed')
    if (reservation.status !== 'completed') throw new WorkbenchDownloadError('formal_call_uncertain')
    const source = manifest.sources.find(value => value.sceneIndex === scene.index)
    if (source === undefined || source.reservationId !== reservation.reservationId) {
      throw new WorkbenchDownloadError('formal_call_uncertain')
    }
    if (!await input.artifacts.verifySource(source)) throw new WorkbenchDownloadError('verified_source_mismatch')
    reusable.set(scene.index, verifiedFromExisting(scene, reservation, source))
  }

  if (input.budget.remaining < pendingScenes.length) {
    throw new WorkbenchDownloadError('download_budget_exhausted')
  }

  const preflight = pendingScenes.length === 0
    ? []
    : await preflightSelections({ taskId: input.taskId, scenes: pendingScenes, inspect: input.client })
  const downloaded = new Map<number, VerifiedSceneSource>()
  for (const result of preflight) {
    const reservationId = randomUUID()
    const reservation: WorkbenchFormalReservation = {
      sceneIndex: result.sceneIndex,
      reservationId,
      ...result.selection,
      status: 'reserved',
    }
    await input.artifacts.updateTask(input.taskId, current => ({
      ...current,
      formalReservations: [...current.formalReservations, reservation],
      stage: 'downloading',
    }))

    let request: FormalDownloadRequest
    try {
      request = await input.client.requestDownloadWithInfo(result.info, input.budget, reservationId)
    } catch {
      await markUncertain(input.artifacts, input.taskId, reservationId)
      throw new WorkbenchDownloadError('formal_call_uncertain')
    }

    await input.artifacts.updateTask(input.taskId, current => ({
      ...current,
      formalReservations: current.formalReservations.map(value => value.reservationId === reservationId
        ? { ...value, status: 'completed' }
        : value),
    }))
    const ready = await input.client.waitForDownload(request)
    const destination = `video-runs/${input.taskId}/sources/scene-${result.sceneIndex}.mp4`
    const completed = await input.client.transferSignedUrl(ready as DownloadReady, destination)
    downloaded.set(result.sceneIndex, verifiedFromDownload(result, reservationId, completed))
  }

  return input.scenes.map(scene => {
    const source = reusable.get(scene.index) ?? downloaded.get(scene.index)
    if (source === undefined) throw new WorkbenchDownloadError('download_incomplete')
    return source
  })
}

function validateTaskAndScenes(taskId: string, scenes: readonly ConfirmedScene[]): void {
  if (!UUID.test(taskId)) throw new WorkbenchDownloadError('invalid_task_id')
  if (scenes.length < 5 || scenes.length > 10) throw new WorkbenchDownloadError('invalid_scene_count')
  const selectionIds = new Set<number>()
  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index]
    if (scene.index !== index
      || !validSelection(scene.selected)
      || !validSelection(scene.confirmed)
      || !sameSelection(scene.selected, scene.confirmed)
      || selectionIds.has(scene.confirmed.selectionId)
      || !candidateStateOwns(scene.candidates, scene.confirmed)) {
      throw new WorkbenchDownloadError('selection_ownership_mismatch')
    }
    selectionIds.add(scene.confirmed.selectionId)
  }
}

function candidateStateOwns(state: SceneCandidateState, selection: WorkbenchSelection): boolean {
  const sameKey = (value: { runId: string; resourceId: number } | undefined) => value?.runId === selection.runId
    && value.resourceId === selection.resourceId
  return sameKey(state.selected)
    && sameKey(state.confirmed)
    && state.pages.flat().some(candidate => candidate.provider === 'vecteezy' && sameKey(candidate))
}

function validateManifestOwnership(
  manifest: WorkbenchManifest,
  taskId: string,
  scenes: readonly ConfirmedScene[],
): void {
  if (manifest.taskId !== taskId || manifest.sceneCount !== scenes.length || manifest.scenes.length !== scenes.length) {
    throw new WorkbenchDownloadError('task_changed')
  }
  for (const scene of scenes) {
    const persisted = manifest.scenes[scene.index]
    if (persisted === undefined || persisted.selected === null || persisted.confirmed === null
      || !sameSelection(persisted.selected, scene.selected)
      || !sameSelection(persisted.confirmed, scene.confirmed)) {
      throw new WorkbenchDownloadError('resource_changed')
    }
  }
}

function validSelection(selection: WorkbenchSelection): boolean {
  return UUID.test(selection.runId)
    && Number.isSafeInteger(selection.resourceId) && selection.resourceId > 0
    && Number.isSafeInteger(selection.selectionId) && selection.selectionId > 0
}

function sameSelection(left: WorkbenchSelection, right: WorkbenchSelection): boolean {
  return left.runId === right.runId
    && left.resourceId === right.resourceId
    && left.selectionId === right.selectionId
}

async function markUncertain(
  artifacts: WorkbenchArtifactStore,
  taskId: string,
  reservationId: string,
): Promise<void> {
  await artifacts.updateTask(taskId, current => ({
    ...current,
    formalReservations: current.formalReservations.map(value => value.reservationId === reservationId
      ? { ...value, status: 'uncertain' }
      : value),
    stage: 'failed',
    failure: {
      code: 'formal_call_uncertain',
      message: 'Formal download outcome is uncertain',
      retryable: false,
    },
  }))
}

function verifiedFromDownload(
  result: PreflightResult,
  reservationId: string,
  completed: CompletedVecteezyDownload,
): VerifiedSceneSource {
  return {
    sceneIndex: result.sceneIndex,
    reservationId,
    selectionId: result.selection.selectionId,
    resourceId: result.selection.resourceId,
    artifactKey: completed.artifactKey,
    sourceSizeBytes: completed.sourceSizeBytes,
    sourceSha256: completed.sourceSha256,
  }
}

function verifiedFromExisting(
  scene: ConfirmedScene,
  reservation: WorkbenchFormalReservation,
  source: WorkbenchSource,
): VerifiedSceneSource {
  return {
    sceneIndex: scene.index,
    reservationId: reservation.reservationId,
    selectionId: scene.confirmed.selectionId,
    resourceId: scene.confirmed.resourceId,
    artifactKey: source.artifactKey,
    sourceSizeBytes: source.sizeBytes,
    sourceSha256: source.sha256,
  }
}
