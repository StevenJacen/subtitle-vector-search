import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { formatTimestamp } from '../subtitles.js'
import type { LocalFileState } from '../video-artifacts.js'
import type { CandidateKey, CandidateReference, SceneCandidateState } from './candidate-pool.js'
import type { PlannedCue } from './ollama.js'
import type { SelectedPassage, SelectedPassageCue } from './passage-selection.js'

export type WorkbenchStage =
  | 'planning'
  | 'review'
  | 'starting'
  | 'preflight'
  | 'downloading'
  | 'probing'
  | 'rendering'
  | 'validating'
  | 'completing'
  | 'completed'
  | 'failed'

export interface WorkbenchSelection {
  runId: string
  resourceId: number
  selectionId: number
}

export interface WorkbenchScene {
  index: number
  cueIndex: number
  durationMs: number
  captionEn: string
  plan: PlannedCue
  selected: WorkbenchSelection | null
  confirmed: WorkbenchSelection | null
}

export type FormalReservationStatus = 'reserved' | 'uncertain' | 'completed'

export interface WorkbenchDownloadReceipt {
  taskId: string
  sceneIndex: number
  reservationId: string
  artifactKey: string
  sha256: string
  sizeBytes: number
}

export interface WorkbenchFormalReservation extends WorkbenchSelection {
  sceneIndex: number
  reservationId: string
  status: FormalReservationStatus
  receipt?: WorkbenchDownloadReceipt
}

export interface WorkbenchSource {
  sceneIndex: number
  reservationId: string
  selectionId: number
  artifactKey: string
  sha256: string
  sizeBytes: number
  width: number
  height: number
  durationMs: number
  frameRate: number
  videoCodec: string
  audioCodec: string | null
}

export interface WorkbenchOutput {
  artifactKey: string
  sha256: string
  sizeBytes: number
  durationMs: number
  width: number
  height: number
  frameRate: 30
  videoCodec: 'h264'
  pixelFormat: 'yuv420p'
  audioCodec: null
  ffmpegVersion: string
}

export interface WorkbenchFailure {
  code: string
  message: string
  retryable: boolean
}

export interface WorkbenchManifest {
  version: 2
  taskId: string
  renderId: string | null
  requestDigest: string
  theme: string
  aspectRatio: '9:16' | '16:9'
  width: number
  height: number
  sceneCount: number
  passage: SelectedPassage
  scenes: WorkbenchScene[]
  formalReservations: WorkbenchFormalReservation[]
  sources: WorkbenchSource[]
  output?: WorkbenchOutput
  stage: WorkbenchStage
  failure?: WorkbenchFailure
  createdAt: string
  updatedAt: string
}

export interface WorkbenchReviewState {
  version: 1
  taskId: string
  scenes: SceneCandidateState[]
}

type Clock = () => Date
type ManifestUpdater = (manifest: WorkbenchManifest) => WorkbenchManifest | Promise<WorkbenchManifest>
type ReviewUpdater = (state: WorkbenchReviewState) => WorkbenchReviewState | Promise<WorkbenchReviewState>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/
const STAGES = new Set<WorkbenchStage>([
  'planning', 'review', 'starting', 'preflight', 'downloading', 'probing',
  'rendering', 'validating', 'completing', 'completed', 'failed',
])
const RESERVATION_STATES = new Set<FormalReservationStatus>(['reserved', 'uncertain', 'completed'])
const FORBIDDEN_KEY = /url|token|secret|authorization|api[_-]?key|access[_-]?key|credential|password/i
const EMBEDDED_URL = /(?:[a-z][a-z0-9+.-]*:\/\/|(?:https?|ftp|file|data):|\/\/[a-z0-9.-]+)[^\s<>"']*/i
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const writeMutexes = new Map<string, Promise<void>>()

export async function createWorkbenchTask(
  root: string,
  value: WorkbenchManifest,
  reviewState?: WorkbenchReviewState,
): Promise<void> {
  const manifest = parseWorkbenchManifest(value)
  const destination = manifestPath(root, manifest.taskId)
  await withWriteMutex(destination, async () => {
    await ensureTaskDirectory(root, manifest.taskId, true)
    if (await fileExists(destination)) throw new Error('workbench_task_exists')
    await writeJsonAtomic(root, manifest.taskId, 'manifest-v2.json', manifest)
  })
  if (reviewState !== undefined) await writeWorkbenchReviewState(root, manifest.taskId, reviewState)
}

export async function readWorkbenchTask(root: string, taskId: string): Promise<WorkbenchManifest> {
  assertUuid(taskId, 'invalid workbench task id')
  await ensureTaskDirectory(root, taskId, false)
  try {
    return parseWorkbenchManifest(await readJsonFile(manifestPath(root, taskId)))
  } catch (error) {
    if (error instanceof Error && error.message === 'unsafe workbench path') throw error
    throw invalidManifest()
  }
}

export async function listWorkbenchTasks(root: string): Promise<WorkbenchManifest[]> {
  const runsDirectory = resolve(root, 'video-runs')
  let entries
  try {
    await assertDirectoryChain(root, [], false)
    const stats = await lstat(runsDirectory)
    if (stats.isSymbolicLink() || !stats.isDirectory()) return []
    entries = await readdir(runsDirectory, { withFileTypes: true })
  } catch {
    return []
  }

  const tasks: WorkbenchManifest[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID.test(entry.name)) continue
    try {
      const task = await readWorkbenchTask(root, entry.name)
      if (task.taskId === entry.name.toLowerCase()) tasks.push(task)
    } catch {
      // A damaged task must not hide other local history entries.
    }
  }
  return tasks.sort((left, right) => {
    const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    return updated !== 0 ? updated : left.taskId.localeCompare(right.taskId, 'en-US')
  })
}

export async function updateWorkbenchTask(
  root: string,
  taskId: string,
  updater: ManifestUpdater,
  clock: Clock = () => new Date(),
): Promise<WorkbenchManifest> {
  assertUuid(taskId, 'invalid workbench task id')
  const destination = manifestPath(root, taskId)
  return withWriteMutex(destination, async () => {
    const current = await readWorkbenchTask(root, taskId)
    const candidateValue = await updater(clone(current))
    const candidate = parseWorkbenchManifest(candidateValue)
    if (candidate.taskId !== current.taskId || candidate.createdAt !== current.createdAt) throw invalidManifest()

    if (current.stage === 'completed') {
      if (stableJson(candidate) === stableJson(current)) return current
      throw new Error('completed_workbench_immutable')
    }

    const updatedAt = monotonicTimestamp(current.updatedAt, clock())
    const updated = parseWorkbenchManifest({ ...candidate, updatedAt })
    await writeJsonAtomic(root, taskId, 'manifest-v2.json', updated)
    return updated
  })
}

export async function writeWorkbenchReviewState(
  root: string,
  taskId: string,
  value: WorkbenchReviewState,
): Promise<void> {
  assertUuid(taskId, 'invalid workbench task id')
  const destination = reviewPath(root, taskId)
  await withWriteMutex(destination, async () => {
    const manifest = await readWorkbenchTask(root, taskId)
    const review = parseReviewState(value, manifest)
    await writeJsonAtomic(root, taskId, 'review-state.json', review)
  })
}

export async function readWorkbenchReviewState(root: string, taskId: string): Promise<WorkbenchReviewState> {
  assertUuid(taskId, 'invalid workbench task id')
  const manifest = await readWorkbenchTask(root, taskId)
  try {
    return parseReviewState(await readJsonFile(reviewPath(root, taskId)), manifest)
  } catch (error) {
    if (error instanceof Error && error.message === 'unsafe workbench path') throw error
    throw invalidReview()
  }
}

export async function updateWorkbenchReviewState(
  root: string,
  taskId: string,
  updater: ReviewUpdater,
): Promise<WorkbenchReviewState> {
  assertUuid(taskId, 'invalid workbench task id')
  const destination = reviewPath(root, taskId)
  return withWriteMutex(destination, async () => {
    const manifest = await readWorkbenchTask(root, taskId)
    const current = await readWorkbenchReviewState(root, taskId)
    const updated = parseReviewState(await updater(clone(current)), manifest)
    await writeJsonAtomic(root, taskId, 'review-state.json', updated)
    return updated
  })
}

export function nextWorkbenchStage(manifestValue: WorkbenchManifest, localFiles: LocalFileState): WorkbenchStage {
  const manifest = parseWorkbenchManifest(manifestValue)
  if (manifest.formalReservations.some(reservation => reservation.status === 'uncertain')) return 'failed'
  if (manifest.formalReservations.some(reservation => (
    reservation.status === 'completed' && reservation.receipt === undefined
  ))) return 'failed'
  if (manifest.stage === 'planning') return 'planning'
  if (!allScenesConfirmed(manifest.scenes)) return 'review'
  if (manifest.renderId === null) return 'starting'
  if (manifest.formalReservations.length < manifest.sceneCount) {
    return manifest.formalReservations.length === 0 ? 'preflight' : 'downloading'
  }
  if (!verifiedFiles(manifest.sources, manifest.sceneCount, localFiles)) return 'downloading'
  if (manifest.output === undefined || localFiles.hashes[manifest.output.artifactKey] !== manifest.output.sha256) return 'rendering'
  return manifest.stage === 'completed' ? 'completed' : 'completing'
}

export function parseWorkbenchManifest(value: unknown): WorkbenchManifest {
  rejectPrivateContent(value, invalidManifest)
  const input = record(value, invalidManifest)
  exactKeys(input, [
    'version', 'taskId', 'renderId', 'requestDigest', 'theme', 'aspectRatio', 'width', 'height',
    'sceneCount', 'passage', 'scenes', 'formalReservations', 'sources', 'stage', 'createdAt', 'updatedAt',
  ], ['output', 'failure'], invalidManifest)
  if (input.version !== 2
    || !isUuid(input.taskId)
    || !(input.renderId === null || isUuid(input.renderId))
    || !isSha256(input.requestDigest)
    || !text(input.theme, 300)
    || !validRenderDimensions(input.aspectRatio, input.width, input.height)
    || !integerInRange(input.sceneCount, 5, 10)
    || typeof input.stage !== 'string'
    || !STAGES.has(input.stage as WorkbenchStage)
    || !timestamp(input.createdAt)
    || !timestamp(input.updatedAt)
    || Date.parse(input.updatedAt) < Date.parse(input.createdAt)) {
    throw invalidManifest()
  }

  const passage = parsePassage(input.passage, input.sceneCount)
  const scenes = array(input.scenes, invalidManifest).map((scene, index) => parseScene(scene, index, passage.cues[index]))
  if (scenes.length !== input.sceneCount) throw invalidManifest()
  const formalReservations = array(input.formalReservations, invalidManifest)
    .map(reservation => parseReservation(reservation, scenes, input.taskId as string))
  assertUnique(formalReservations.map(reservation => reservation.sceneIndex), invalidManifest)
  assertUnique(formalReservations.map(reservation => reservation.reservationId), invalidManifest)
  const sources = array(input.sources, invalidManifest)
    .map(source => parseSource(source, input.taskId as string, formalReservations))
  assertUnique(sources.map(source => source.sceneIndex), invalidManifest)
  assertUnique(sources.map(source => source.reservationId), invalidManifest)
  if (formalReservations.length > input.sceneCount || sources.length > input.sceneCount) throw invalidManifest()

  const output = input.output === undefined
    ? undefined
    : parseOutput(input.output, input.taskId, input.width, input.height, passage.totalDurationMs)
  const failure = input.failure === undefined ? undefined : parseFailure(input.failure)
  const manifest: WorkbenchManifest = {
    version: 2,
    taskId: input.taskId.toLowerCase(),
    renderId: input.renderId === null ? null : input.renderId.toLowerCase(),
    requestDigest: input.requestDigest,
    theme: input.theme,
    aspectRatio: input.aspectRatio as '9:16' | '16:9',
    width: input.width as number,
    height: input.height as number,
    sceneCount: input.sceneCount,
    passage,
    scenes,
    formalReservations,
    sources,
    ...(output === undefined ? {} : { output }),
    stage: input.stage as WorkbenchStage,
    ...(failure === undefined ? {} : { failure }),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  }
  validateStage(manifest)
  return manifest
}

function parsePassage(value: unknown, sceneCount: number): SelectedPassage {
  const passage = record(value, invalidManifest)
  exactKeys(passage, [
    'movie', 'trackId', 'startCueIndex', 'endCueIndex', 'totalDurationMs', 'cues',
  ], [], invalidManifest)
  const movie = record(passage.movie, invalidManifest)
  exactKeys(movie, ['id', 'title', 'releaseYear'], [], invalidManifest)
  const cues = array(passage.cues, invalidManifest).map(parsePassageCue)
  const totalDurationMs = cues.reduce((total, cue) => total + cue.endMs - cue.startMs, 0)
  if (!positiveInteger(movie.id)
    || !text(movie.title, 300)
    || !(movie.releaseYear === null || integerInRange(movie.releaseYear, 1888, 9999))
    || !positiveInteger(passage.trackId)
    || !nonnegativeInteger(passage.startCueIndex)
    || !nonnegativeInteger(passage.endCueIndex)
    || cues.length !== sceneCount
    || cues.some((cue, index) => cue.trackId !== passage.trackId || cue.cueIndex !== (passage.startCueIndex as number) + index)
    || passage.endCueIndex !== passage.startCueIndex + sceneCount - 1
    || totalDurationMs !== passage.totalDurationMs
    || totalDurationMs < 15_000
    || totalDurationMs > 60_000) {
    throw invalidManifest()
  }
  return {
    movie: { id: movie.id, title: movie.title, releaseYear: movie.releaseYear as number | null },
    trackId: passage.trackId,
    startCueIndex: passage.startCueIndex,
    endCueIndex: passage.endCueIndex,
    totalDurationMs,
    cues,
  }
}

function parsePassageCue(value: unknown): SelectedPassageCue {
  const cue = record(value, invalidManifest)
  exactKeys(cue, ['trackId', 'cueIndex', 'startMs', 'endMs', 'text', 'timestamp'], [], invalidManifest)
  if (!positiveInteger(cue.trackId)
    || !nonnegativeInteger(cue.cueIndex)
    || !nonnegativeInteger(cue.startMs)
    || !positiveInteger(cue.endMs)
    || cue.endMs - cue.startMs < 1_200
    || !text(cue.text, 10_000)
    || cue.timestamp !== `${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}`) {
    throw invalidManifest()
  }
  return cue as unknown as SelectedPassageCue
}

function parseScene(value: unknown, index: number, cue: SelectedPassageCue | undefined): WorkbenchScene {
  if (cue === undefined) throw invalidManifest()
  const scene = record(value, invalidManifest)
  exactKeys(scene, [
    'index', 'cueIndex', 'durationMs', 'captionEn', 'plan', 'selected', 'confirmed',
  ], [], invalidManifest)
  const selected = scene.selected === null ? null : parseSelection(scene.selected)
  const confirmed = scene.confirmed === null ? null : parseSelection(scene.confirmed)
  if (scene.index !== index
    || scene.cueIndex !== cue.cueIndex
    || scene.durationMs !== cue.endMs - cue.startMs
    || scene.captionEn !== cue.text
    || (confirmed !== null && (selected === null || !sameSelection(selected, confirmed)))) {
    throw invalidManifest()
  }
  return {
    index,
    cueIndex: cue.cueIndex,
    durationMs: cue.endMs - cue.startMs,
    captionEn: cue.text,
    plan: parsePlan(scene.plan),
    selected,
    confirmed,
  }
}

function parsePlan(value: unknown): PlannedCue {
  const plan = record(value, invalidManifest)
  exactKeys(plan, ['captionZh', 'visualConcept'], ['mood', 'action', 'setting', 'lighting'], invalidManifest)
  if (!text(plan.captionZh, 2_000)
    || !/\p{Script=Han}/u.test(plan.captionZh)
    || !asciiText(plan.visualConcept, 500)
    || !optionalAsciiText(plan.mood, 500)
    || !optionalAsciiText(plan.action, 500)
    || !optionalAsciiText(plan.setting, 500)
    || !optionalAsciiText(plan.lighting, 500)) {
    throw invalidManifest()
  }
  return plan as unknown as PlannedCue
}

function parseSelection(value: unknown): WorkbenchSelection {
  const selection = record(value, invalidManifest)
  exactKeys(selection, ['runId', 'resourceId', 'selectionId'], [], invalidManifest)
  if (!isUuid(selection.runId) || !positiveInteger(selection.resourceId) || !positiveInteger(selection.selectionId)) {
    throw invalidManifest()
  }
  return {
    runId: selection.runId.toLowerCase(),
    resourceId: selection.resourceId,
    selectionId: selection.selectionId,
  }
}

function parseReservation(
  value: unknown,
  scenes: readonly WorkbenchScene[],
  taskId: string,
): WorkbenchFormalReservation {
  const reservation = record(value, invalidManifest)
  exactKeys(reservation, [
    'sceneIndex', 'reservationId', 'runId', 'resourceId', 'selectionId', 'status',
  ], ['receipt'], invalidManifest)
  if (!nonnegativeInteger(reservation.sceneIndex)
    || reservation.sceneIndex >= scenes.length
    || !isUuid(reservation.reservationId)
    || typeof reservation.status !== 'string'
    || !RESERVATION_STATES.has(reservation.status as FormalReservationStatus)) {
    throw invalidManifest()
  }
  const selection = parseSelection({
    runId: reservation.runId,
    resourceId: reservation.resourceId,
    selectionId: reservation.selectionId,
  })
  const confirmed = scenes[reservation.sceneIndex]?.confirmed
  if (confirmed === null || confirmed === undefined || !sameSelection(selection, confirmed)) throw invalidManifest()
  const receipt = reservation.receipt === undefined
    ? undefined
    : parseDownloadReceipt(reservation.receipt, taskId, reservation.sceneIndex, reservation.reservationId)
  if (receipt !== undefined && reservation.status !== 'completed') throw invalidManifest()
  return {
    sceneIndex: reservation.sceneIndex,
    reservationId: reservation.reservationId.toLowerCase(),
    ...selection,
    status: reservation.status as FormalReservationStatus,
    ...(receipt === undefined ? {} : { receipt }),
  }
}

function parseDownloadReceipt(
  value: unknown,
  taskId: string,
  sceneIndex: unknown,
  reservationId: unknown,
): WorkbenchDownloadReceipt {
  const receipt = record(value, invalidManifest)
  exactKeys(receipt, [
    'taskId', 'sceneIndex', 'reservationId', 'artifactKey', 'sha256', 'sizeBytes',
  ], [], invalidManifest)
  if (!isUuid(receipt.taskId)
    || receipt.taskId.toLowerCase() !== taskId.toLowerCase()
    || receipt.sceneIndex !== sceneIndex
    || !isUuid(receipt.reservationId)
    || receipt.reservationId.toLowerCase() !== String(reservationId).toLowerCase()
    || !ownedArtifactKey(receipt.artifactKey, taskId)
    || !isSha256(receipt.sha256)
    || !positiveInteger(receipt.sizeBytes)) {
    throw invalidManifest()
  }
  return {
    taskId: receipt.taskId.toLowerCase(),
    sceneIndex: receipt.sceneIndex as number,
    reservationId: receipt.reservationId.toLowerCase(),
    artifactKey: receipt.artifactKey as string,
    sha256: receipt.sha256,
    sizeBytes: receipt.sizeBytes,
  }
}

function parseSource(
  value: unknown,
  taskId: string,
  reservations: readonly WorkbenchFormalReservation[],
): WorkbenchSource {
  const source = record(value, invalidManifest)
  exactKeys(source, [
    'sceneIndex', 'reservationId', 'selectionId', 'artifactKey', 'sha256', 'sizeBytes',
    'width', 'height', 'durationMs', 'frameRate', 'videoCodec', 'audioCodec',
  ], [], invalidManifest)
  const reservation = reservations.find(candidate => candidate.sceneIndex === source.sceneIndex)
  if (!nonnegativeInteger(source.sceneIndex)
    || !isUuid(source.reservationId)
    || !positiveInteger(source.selectionId)
    || reservation === undefined
    || reservation.status !== 'completed'
    || reservation.reservationId !== source.reservationId.toLowerCase()
    || reservation.selectionId !== source.selectionId
    || !ownedArtifactKey(source.artifactKey, taskId)
    || !isSha256(source.sha256)
    || !positiveInteger(source.sizeBytes)
    || !positiveInteger(source.width)
    || !positiveInteger(source.height)
    || !positiveInteger(source.durationMs)
    || !positiveNumber(source.frameRate)
    || !text(source.videoCodec, 100)
    || !(source.audioCodec === null || text(source.audioCodec, 100))) {
    throw invalidManifest()
  }
  if (reservation.receipt !== undefined
    && (reservation.receipt.artifactKey !== source.artifactKey
      || reservation.receipt.sha256 !== source.sha256
      || reservation.receipt.sizeBytes !== source.sizeBytes)) {
    throw invalidManifest()
  }
  return source as unknown as WorkbenchSource
}

function parseOutput(
  value: unknown,
  taskId: string,
  width: unknown,
  height: unknown,
  expectedDurationMs: number,
): WorkbenchOutput {
  const output = record(value, invalidManifest)
  exactKeys(output, [
    'artifactKey', 'sha256', 'sizeBytes', 'durationMs', 'width', 'height', 'frameRate',
    'videoCodec', 'pixelFormat', 'audioCodec', 'ffmpegVersion',
  ], [], invalidManifest)
  if (!ownedArtifactKey(output.artifactKey, taskId)
    || !isSha256(output.sha256)
    || !positiveInteger(output.sizeBytes)
    || output.durationMs !== expectedDurationMs
    || output.width !== width
    || output.height !== height
    || output.frameRate !== 30
    || output.videoCodec !== 'h264'
    || output.pixelFormat !== 'yuv420p'
    || output.audioCodec !== null
    || !text(output.ffmpegVersion, 500)) {
    throw invalidManifest()
  }
  return output as unknown as WorkbenchOutput
}

function parseFailure(value: unknown): WorkbenchFailure {
  const failure = record(value, invalidManifest)
  exactKeys(failure, ['code', 'message', 'retryable'], [], invalidManifest)
  if (!/^[a-z][a-z0-9_]{0,99}$/.test(String(failure.code))
    || !text(failure.message, 500)
    || typeof failure.retryable !== 'boolean') {
    throw invalidManifest()
  }
  return failure as unknown as WorkbenchFailure
}

function validateStage(manifest: WorkbenchManifest): void {
  const confirmed = allScenesConfirmed(manifest.scenes)
  const allReservations = manifest.formalReservations.length === manifest.sceneCount
  const allSources = manifest.sources.length === manifest.sceneCount
  if ((manifest.stage === 'planning' || manifest.stage === 'review')
    && (manifest.renderId !== null || manifest.formalReservations.length > 0 || manifest.sources.length > 0 || manifest.output !== undefined)) {
    throw invalidManifest()
  }
  if (manifest.stage !== 'planning' && manifest.stage !== 'review' && manifest.stage !== 'failed' && !confirmed) {
    throw invalidManifest()
  }
  if (['preflight', 'downloading', 'probing', 'rendering', 'validating', 'completing', 'completed'].includes(manifest.stage)
    && manifest.renderId === null) {
    throw invalidManifest()
  }
  if (manifest.stage === 'downloading' && manifest.formalReservations.length === 0) throw invalidManifest()
  if (['probing', 'rendering', 'validating', 'completing', 'completed'].includes(manifest.stage) && !allReservations) {
    throw invalidManifest()
  }
  if (['rendering', 'validating', 'completing', 'completed'].includes(manifest.stage) && !allSources) throw invalidManifest()
  if (['validating', 'completing', 'completed'].includes(manifest.stage) && manifest.output === undefined) throw invalidManifest()
  if (manifest.stage === 'failed' ? manifest.failure === undefined : manifest.failure !== undefined) throw invalidManifest()
}

function parseReviewState(value: unknown, manifest: WorkbenchManifest): WorkbenchReviewState {
  rejectPrivateContent(value, invalidReview)
  const review = record(value, invalidReview)
  exactKeys(review, ['version', 'taskId', 'scenes'], [], invalidReview)
  if (review.version !== 1 || !isUuid(review.taskId) || review.taskId.toLowerCase() !== manifest.taskId) throw invalidReview()
  const scenes = array(review.scenes, invalidReview).map(parseCandidateState)
  if (scenes.length !== manifest.sceneCount) throw invalidReview()
  return { version: 1, taskId: manifest.taskId, scenes }
}

function parseCandidateState(value: unknown): SceneCandidateState {
  const state = record(value, invalidReview)
  exactKeys(state, ['pages', 'hasNextPage'], ['selected', 'confirmed', 'recommended'], invalidReview)
  if (typeof state.hasNextPage !== 'boolean') throw invalidReview()
  const pages = array(state.pages, invalidReview).map((pageValue, pageIndex) => {
    const page = array(pageValue, invalidReview).map(parseCandidate)
    const validSize = pageIndex === 0 ? page.length === 8 : page.length >= 1 && page.length <= 8
    if (!validSize || page.some(candidate => candidate.page !== pageIndex + 1)) throw invalidReview()
    return page
  })
  const flattened = pages.flat()
  assertUnique(flattened.map(candidate => `${candidate.provider}:${candidate.resourceId}`), invalidReview)
  const selected = state.selected === undefined ? undefined : parseCandidateKey(state.selected)
  const confirmed = state.confirmed === undefined ? undefined : parseCandidateKey(state.confirmed)
  const recommended = state.recommended === undefined ? undefined : parseCandidateKey(state.recommended)
  for (const key of [selected, confirmed, recommended]) {
    if (key !== undefined && !flattened.some(candidate => candidate.runId === key.runId && candidate.resourceId === key.resourceId)) {
      throw invalidReview()
    }
  }
  if (confirmed !== undefined && (selected === undefined || !sameCandidateKey(selected, confirmed))) throw invalidReview()
  return {
    pages,
    ...(selected === undefined ? {} : { selected }),
    ...(confirmed === undefined ? {} : { confirmed }),
    ...(recommended === undefined ? {} : { recommended }),
    hasNextPage: state.hasNextPage,
  }
}

function parseCandidate(value: unknown): CandidateReference {
  const candidate = record(value, invalidReview)
  exactKeys(candidate, [
    'provider', 'resourceId', 'runId', 'page', 'title', 'previewId', 'orientation',
    'licenseType', 'aiGenerated', 'score', 'suitabilityScore', 'providerRank',
  ], [], invalidReview)
  if (candidate.provider !== 'vecteezy'
    || !positiveInteger(candidate.resourceId)
    || !isUuid(candidate.runId)
    || !integerInRange(candidate.page, 1, 100)
    || !(candidate.title === null || text(candidate.title, 500))
    || !(candidate.previewId === null || isUuid(candidate.previewId))
    || !(candidate.orientation === null || text(candidate.orientation, 100))
    || !(candidate.licenseType === null || text(candidate.licenseType, 100))
    || !(candidate.aiGenerated === null || typeof candidate.aiGenerated === 'boolean')
    || !finiteNumber(candidate.score)
    || !finiteNumber(candidate.suitabilityScore)
    || candidate.suitabilityScore < 0
    || !positiveInteger(candidate.providerRank)) {
    throw invalidReview()
  }
  return {
    provider: 'vecteezy',
    resourceId: candidate.resourceId,
    runId: candidate.runId.toLowerCase(),
    page: candidate.page,
    title: candidate.title as string | null,
    previewId: candidate.previewId === null ? null : candidate.previewId.toLowerCase(),
    orientation: candidate.orientation as string | null,
    licenseType: candidate.licenseType as string | null,
    aiGenerated: candidate.aiGenerated as boolean | null,
    score: candidate.score,
    suitabilityScore: candidate.suitabilityScore,
    providerRank: candidate.providerRank,
  }
}

function parseCandidateKey(value: unknown): CandidateKey {
  const key = record(value, invalidReview)
  exactKeys(key, ['runId', 'resourceId'], [], invalidReview)
  if (!isUuid(key.runId) || !positiveInteger(key.resourceId)) throw invalidReview()
  return { runId: key.runId.toLowerCase(), resourceId: key.resourceId }
}

function allScenesConfirmed(scenes: readonly WorkbenchScene[]): boolean {
  return scenes.every(scene => scene.selected !== null
    && scene.confirmed !== null
    && sameSelection(scene.selected, scene.confirmed))
}

function sameSelection(left: WorkbenchSelection, right: WorkbenchSelection): boolean {
  return left.runId === right.runId
    && left.resourceId === right.resourceId
    && left.selectionId === right.selectionId
}

function sameCandidateKey(left: CandidateKey, right: CandidateKey): boolean {
  return left.runId === right.runId && left.resourceId === right.resourceId
}

function verifiedFiles(sources: readonly WorkbenchSource[], sceneCount: number, files: LocalFileState): boolean {
  return sources.length === sceneCount
    && sources.every(source => files.hashes[source.artifactKey] === source.sha256)
}

async function writeJsonAtomic(root: string, taskId: string, filename: string, value: unknown): Promise<void> {
  const taskDirectory = await ensureTaskDirectory(root, taskId, true)
  const destination = join(taskDirectory, filename)
  const temporary = join(taskDirectory, `${filename}.tmp-${randomUUID()}`)
  const bytes = `${JSON.stringify(value, null, 2)}\n`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let created = false
  try {
    handle = await open(temporary, 'wx')
    created = true
    await handle.writeFile(bytes, 'utf8')
    await handle.close()
    handle = undefined
    await ensureTaskDirectory(root, taskId, false)
    await rename(temporary, destination)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    if (created) await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function ensureTaskDirectory(root: string, taskId: string, create: boolean): Promise<string> {
  assertUuid(taskId, 'invalid workbench task id')
  return assertDirectoryChain(root, ['video-runs', taskId.toLowerCase()], create)
}

async function assertDirectoryChain(root: string, segments: readonly string[], create: boolean): Promise<string> {
  const artifactRoot = resolve(root)
  if (create) await mkdir(artifactRoot, { recursive: true })
  const rootStats = await lstat(artifactRoot).catch(() => {
    throw new Error('unsafe workbench path')
  })
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Error('unsafe workbench path')
  const physicalRoot = await realpath(artifactRoot).catch(() => {
    throw new Error('unsafe workbench path')
  })
  let current = artifactRoot
  for (const segment of segments) {
    current = join(current, segment)
    if (create) await mkdir(current).catch(error => {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error
    })
    const stats = await lstat(current).catch(() => {
      throw new Error('unsafe workbench path')
    })
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('unsafe workbench path')
    const physical = await realpath(current).catch(() => {
      throw new Error('unsafe workbench path')
    })
    assertContained(physicalRoot, physical)
  }
  return current
}

function manifestPath(root: string, taskId: string): string {
  return resolve(root, 'video-runs', taskId.toLowerCase(), 'manifest-v2.json')
}

function reviewPath(root: string, taskId: string): string {
  return resolve(root, 'video-runs', taskId.toLowerCase(), 'review-state.json')
}

async function withWriteMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeMutexes.get(key) ?? Promise.resolve()
  let release = (): void => undefined
  const current = new Promise<void>(resolveCurrent => {
    release = resolveCurrent
  })
  writeMutexes.set(key, current)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (writeMutexes.get(key) === current) writeMutexes.delete(key)
  }
}

function monotonicTimestamp(previous: string, proposed: Date): string {
  const proposedMs = proposed.getTime()
  if (!Number.isFinite(proposedMs)) throw invalidManifest()
  return new Date(Math.max(proposedMs, Date.parse(previous) + 1)).toISOString()
}

function ownedArtifactKey(value: unknown, taskId: string): value is string {
  if (typeof value !== 'string') return false
  const prefix = `video-runs/${taskId.toLowerCase()}/`
  return value.toLowerCase().startsWith(prefix)
    && safeRelativePath(value.slice(prefix.length))
}

function safeRelativePath(value: string): boolean {
  return value.length > 0
    && !/[\\\u0000-\u001f\u007f]/.test(value)
    && !/^[a-z][a-z0-9+.-]*:/i.test(value)
    && value.split('/').every(segment => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)
      && segment !== '.'
      && segment !== '..'
      && !segment.endsWith('.')
      && !segment.endsWith(' ')
      && !WINDOWS_DEVICE.test(segment))
}

function rejectPrivateContent(value: unknown, errorFactory: () => Error): void {
  if (Array.isArray(value)) {
    value.forEach(item => rejectPrivateContent(item, errorFactory))
    return
  }
  if (typeof value === 'string') {
    if (EMBEDDED_URL.test(value)) throw errorFactory()
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key.replace(/[^a-z0-9_-]/gi, ''))) throw errorFactory()
    rejectPrivateContent(nested, errorFactory)
  }
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  errorFactory: () => Error,
): void {
  const allowed = new Set([...required, ...optional])
  if (!required.every(key => key in value) || Object.keys(value).some(key => !allowed.has(key))) throw errorFactory()
}

function record(value: unknown, errorFactory: () => Error): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw errorFactory()
  return value as Record<string, unknown>
}

function array(value: unknown, errorFactory: () => Error): unknown[] {
  if (!Array.isArray(value)) throw errorFactory()
  return value
}

function assertUnique(values: readonly (string | number)[], errorFactory: () => Error): void {
  if (new Set(values).size !== values.length) throw errorFactory()
}

function validRenderDimensions(aspect: unknown, width: unknown, height: unknown): boolean {
  return (aspect === '16:9' && width === 1920 && height === 1080)
    || (aspect === '9:16' && width === 1080 && height === 1920)
}

function assertContained(root: string, destination: string): void {
  const fromRoot = relative(root, destination)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) throw new Error('unsafe workbench path')
}

function assertUuid(value: unknown, message: string): asserts value is string {
  if (!isUuid(value)) throw new Error(message)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value)
}

function text(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximumLength
}

function asciiText(value: unknown, maximumLength: number): value is string {
  return text(value, maximumLength) && /^[\x20-\x7e]+$/.test(value)
}

function optionalAsciiText(value: unknown, maximumLength: number): boolean {
  return value === undefined || asciiText(value, maximumLength)
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function integerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
  }
  throw invalidManifest()
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('unsafe workbench path')
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  const stats = await lstat(path)
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('unsafe workbench path')
  return JSON.parse(await readFile(path, 'utf8'))
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

function invalidManifest(): Error {
  return new Error('invalid workbench manifest')
}

function invalidReview(): Error {
  return new Error('invalid workbench review state')
}
