import { randomUUID } from 'node:crypto'
import type { SceneCandidateState } from './candidate-pool.js'
import type {
  WorkbenchDownloadReceipt,
  WorkbenchFormalReservation,
  WorkbenchManifest,
  WorkbenchSelection,
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
  requiresAttribution: boolean
  requiredAttributionUrl: string | null
  quota: VecteezyDownloadInfo['quota']
}

export interface WorkbenchArtifactStore {
  readTask(taskId: string): Promise<WorkbenchManifest>
  updateTask(
    taskId: string,
    updater: (manifest: WorkbenchManifest) => WorkbenchManifest | Promise<WorkbenchManifest>,
  ): Promise<WorkbenchManifest>
  verifyReceipt(receipt: WorkbenchDownloadReceipt): Promise<boolean>
}

type WorkbenchDownloadClient = ResourceInspector & Pick<
  VecteezyDownloadClient,
  'seedAggregateSizeBytes' | 'requestDownloadWithInfo' | 'waitForDownload' | 'transferSignedUrl'
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
  return inspectSelections(input.scenes, input.inspect, 0)
}

async function inspectSelections(
  scenes: readonly ConfirmedScene[],
  inspect: ResourceInspector,
  accountedSizeBytes: number,
): Promise<PreflightResult[]> {
  const results = await Promise.all(scenes.map(async scene => ({
    sceneIndex: scene.index,
    selection: { ...scene.confirmed },
    info: await inspect.getDownloadInfo(scene.confirmed.resourceId),
  })))
  let aggregateSizeBytes = accountedSizeBytes
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
  if (input.budget.maximum < input.scenes.length || input.budget.maximum > 10) {
    throw new WorkbenchDownloadError('invalid_download_budget')
  }
  const manifest = await input.artifacts.readTask(input.taskId)
  validateManifestOwnership(manifest, input.taskId, input.scenes)

  const reusableReservations: Array<{
    scene: ConfirmedScene
    reservation: WorkbenchFormalReservation
    receipt: WorkbenchDownloadReceipt
  }> = []
  const pendingScenes: ConfirmedScene[] = []
  let accountedSizeBytes = 0
  for (const scene of input.scenes) {
    const reservation = manifest.formalReservations.find(value => value.sceneIndex === scene.index)
    if (reservation === undefined) {
      pendingScenes.push(scene)
      continue
    }
    if (!sameSelection(reservation, scene.confirmed)) throw new WorkbenchDownloadError('resource_changed')
    if (reservation.status !== 'completed') throw new WorkbenchDownloadError('formal_call_uncertain')
    const receipt = reservation.receipt
    if (receipt === undefined) throw new WorkbenchDownloadError('formal_call_uncertain')
    if (receipt.taskId !== input.taskId
      || receipt.sceneIndex !== scene.index
      || receipt.reservationId !== reservation.reservationId) {
      throw new WorkbenchDownloadError('resource_changed')
    }
    if (!await input.artifacts.verifyReceipt(receipt)) throw new WorkbenchDownloadError('verified_source_mismatch')
    accountedSizeBytes += receipt.sizeBytes
    if (accountedSizeBytes > MAX_AGGREGATE_SIZE_BYTES) {
      throw new VecteezyDownloadError('aggregate_size_limit_exceeded', 'Vecteezy downloads exceed the 2 GiB aggregate limit')
    }
    reusableReservations.push({ scene, reservation, receipt })
  }

  if (input.budget.remaining < pendingScenes.length) {
    throw new WorkbenchDownloadError('download_budget_exhausted')
  }

  const [reusableInfo, preflight] = await Promise.all([
    Promise.all(reusableReservations.map(async value => {
      const info = await input.client.getDownloadInfo(value.scene.confirmed.resourceId)
      if (info.resourceId !== value.scene.confirmed.resourceId) throw new WorkbenchDownloadError('resource_changed')
      return { ...value, info }
    })),
    inspectSelections(pendingScenes, input.client, accountedSizeBytes),
  ])
  input.client.seedAggregateSizeBytes(accountedSizeBytes)

  const reusable = new Map(reusableInfo.map(value => [
    value.scene.index,
    verifiedFromReceipt(value.scene, value.reservation, value.receipt, value.info),
  ]))
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
      const ready = await input.client.waitForDownload(request)
      const destination = `video-runs/${input.taskId}/sources/scene-${result.sceneIndex}.mp4`
      const completed = await input.client.transferSignedUrl(ready as DownloadReady, destination)
      const receipt: WorkbenchDownloadReceipt = {
        taskId: input.taskId,
        sceneIndex: result.sceneIndex,
        reservationId,
        artifactKey: completed.artifactKey,
        sha256: completed.sourceSha256,
        sizeBytes: completed.sourceSizeBytes,
      }
      await input.artifacts.updateTask(input.taskId, current => ({
        ...current,
        formalReservations: current.formalReservations.map(value => value.reservationId === reservationId
          ? { ...value, status: 'completed', receipt }
          : value),
      }))
      downloaded.set(result.sceneIndex, verifiedFromDownload(result, reservationId, completed))
    } catch {
      await markUncertain(input.artifacts, input.taskId, reservationId).catch(() => undefined)
      throw new WorkbenchDownloadError('formal_call_uncertain')
    }
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
    formalReservations: current.formalReservations.map(value => {
      if (value.reservationId !== reservationId) return value
      const { receipt: _receipt, ...reservation } = value
      return { ...reservation, status: 'uncertain' }
    }),
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
    requiresAttribution: completed.requiresAttribution,
    requiredAttributionUrl: completed.requiredAttributionUrl,
    quota: { ...completed.quota },
  }
}

function verifiedFromReceipt(
  scene: ConfirmedScene,
  reservation: WorkbenchFormalReservation,
  receipt: WorkbenchDownloadReceipt,
  info: VecteezyDownloadInfo,
): VerifiedSceneSource {
  return {
    sceneIndex: scene.index,
    reservationId: reservation.reservationId,
    selectionId: scene.confirmed.selectionId,
    resourceId: scene.confirmed.resourceId,
    artifactKey: receipt.artifactKey,
    sourceSizeBytes: receipt.sizeBytes,
    sourceSha256: receipt.sha256,
    requiresAttribution: info.requiresAttribution,
    requiredAttributionUrl: info.requiredAttributionUrl,
    quota: { ...info.quota },
  }
}
