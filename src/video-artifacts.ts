import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

export type VideoRunStage = 'review' | 'downloading' | 'rendering' | 'completed' | 'failed'

export interface VideoRunQuote {
  trackId: number
  cueIndex: number
  text: string
  captionZh: string
}

export interface VideoRunScene {
  index: number
  captionKind: 'original' | 'quote'
  captionEn: string
  captionZh: string
  visualTheme: string
  sourceMovieId?: number
  sourceTrackId?: number
  sourceCueIndex?: number
  sourceStartMs?: number
  sourceEndMs?: number
  sourceTimestamp?: string
  movieTitle?: string
  releaseYear?: number | null
  runId?: string
  providerResourceId?: number
  selectionId?: number
  note?: string
  sourceInMs?: number
}

export interface VideoRunSource {
  artifactKey: string
  sha256: string
  selectionId?: number
  sizeBytes?: number
  width?: number
  height?: number
  durationMs?: number
  frameRate?: number
  videoCodec?: string
  audioCodec?: string | null
  requiresAttribution?: boolean
  requiredAttributionUrl?: string | null
  quotaLimit?: number | null
  quotaRemaining?: number | null
}

export interface VideoRunOutput {
  artifactKey: string
  sha256: string
  sizeBytes?: number
  durationMs?: number
  videoCodec?: string
  audioCodec?: string
  pixelFormat?: string
  ffmpegVersion?: string
}

export interface VideoRunManifest {
  version: 1
  planId: string
  renderId: string | null
  requestDigest: string
  theme: string
  quote: VideoRunQuote
  scenes: VideoRunScene[]
  sources?: VideoRunSource[]
  output?: VideoRunOutput
  stage: VideoRunStage
  createdAt: string
  updatedAt: string
}

export interface LocalFileState {
  hashes: Readonly<Record<string, string | undefined>>
}

declare const resolvedArtifactPathBrand: unique symbol
export type ResolvedArtifactPath = string & { readonly [resolvedArtifactPathBrand]: true }

interface ArtifactPathRegistration {
  root: string
  key: string
  destination: string
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sha256Pattern = /^[0-9a-f]{64}$/
const stageValues = new Set<VideoRunStage>(['review', 'downloading', 'rendering', 'completed', 'failed'])
const forbiddenArtifactTerm = /url|token|secret|authorization/i
const sensitiveUrlVocabulary = /(?:signed|status|download|signature|x-amz-[a-z0-9-]*|token|secret|credential|policy|expires|key-pair-id|authorization)/i
const embeddedUrl = /(?:[a-z][a-z0-9+.-]*:\/\/|(?:https?|ftp|file|data|mailto):)[^\s<>"']+/gi
const windowsDeviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const artifactPathRegistrations = new Map<string, ArtifactPathRegistration>()

export function artifactKey(renderId: string, relativePath: string): string {
  if (!isUuid(renderId) || !isSafeRelativePath(relativePath)) throw new Error('invalid artifact key')
  return `video-runs/${renderId.toLowerCase()}/${relativePath}`
}

export function resolveArtifactPath(root: string, key: string): ResolvedArtifactPath {
  if (!isSafeArtifactKey(key)) throw new Error('invalid artifact key')

  const artifactRoot = resolve(root)
  const destination = resolve(artifactRoot, ...key.split('/'))
  assertContainedPath(artifactRoot, destination, 'invalid artifact key')
  artifactPathRegistrations.set(destination, { root: artifactRoot, key, destination })
  return destination as ResolvedArtifactPath
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function writeManifestAtomic(path: ResolvedArtifactPath, manifest: VideoRunManifest): Promise<void> {
  assertRegisteredArtifactPath(path)
  const parsed = parseManifest(manifest)
  const directory = dirname(path)
  const bytes = `${JSON.stringify(serializableManifest(parsed), null, 2)}\n`

  await mkdir(directory, { recursive: true })
  assertRegisteredArtifactPath(path)
  const temporary = join(directory, `.${randomUUID()}.manifest.tmp`)
  try {
    await writeFile(temporary, bytes, { encoding: 'utf8', flag: 'wx' })
    assertRegisteredArtifactPath(path)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function readManifest(path: string): Promise<VideoRunManifest> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw invalidManifest()
  }
  return parseManifest(value)
}

export function canonicalRequestDigestInput(input: unknown): string {
  rejectPrivateContent(input)
  return stableJson(withoutPlanId(input))
}

export function canonicalRequestDigest(input: unknown): string {
  return createHash('sha256').update(canonicalRequestDigestInput(input)).digest('hex')
}

export function nextIncompleteStage(manifest: VideoRunManifest, localFiles: LocalFileState): VideoRunStage {
  const parsed = parseManifest(manifest)
  if (parsed.stage === 'failed') return 'failed'
  if (parsed.stage === 'review') return 'review'
  if (!filesMatch(parsed.sources ?? [], localFiles)) return 'downloading'
  if (parsed.output === undefined || localFiles.hashes[parsed.output.artifactKey] !== parsed.output.sha256) return 'rendering'
  return 'completed'
}

function parseManifest(value: unknown): VideoRunManifest {
  rejectPrivateContent(value)
  const manifest = record(value)
  exactKeys(manifest, [
    'version', 'planId', 'renderId', 'requestDigest', 'theme', 'quote', 'scenes', 'stage', 'createdAt', 'updatedAt',
  ], ['sources', 'output'])
  if (manifest.version !== 1
    || !isUuid(manifest.planId)
    || !(manifest.renderId === null || isUuid(manifest.renderId))
    || !isSha256(manifest.requestDigest)
    || !text(manifest.theme, 300)
    || typeof manifest.stage !== 'string'
    || !stageValues.has(manifest.stage as VideoRunStage)
    || !timestamp(manifest.createdAt)
    || !timestamp(manifest.updatedAt)) {
    throw invalidManifest()
  }

  const parsed: VideoRunManifest = {
    version: 1,
    planId: manifest.planId.toLowerCase(),
    renderId: manifest.renderId === null ? null : manifest.renderId.toLowerCase(),
    requestDigest: manifest.requestDigest,
    theme: manifest.theme,
    quote: parseQuote(manifest.quote),
    scenes: array(manifest.scenes).map(parseScene),
    stage: manifest.stage as VideoRunStage,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
  }
  const ownerId = parsed.renderId ?? parsed.planId
  if (manifest.sources !== undefined) parsed.sources = array(manifest.sources).map(value => parseSource(value, ownerId))
  if (manifest.output !== undefined) parsed.output = parseOutput(manifest.output, ownerId)
  if (parsed.stage === 'completed' && parsed.output === undefined) throw invalidManifest()
  return parsed
}

function parseQuote(value: unknown): VideoRunQuote {
  const quote = record(value)
  exactKeys(quote, ['trackId', 'cueIndex', 'text', 'captionZh'])
  if (!positiveInteger(quote.trackId) || !nonnegativeInteger(quote.cueIndex) || !text(quote.text, 10_000) || !text(quote.captionZh, 10_000)) {
    throw invalidManifest()
  }
  return { trackId: quote.trackId, cueIndex: quote.cueIndex, text: quote.text, captionZh: quote.captionZh }
}

function parseScene(value: unknown): VideoRunScene {
  const scene = record(value)
  exactKeys(scene, ['index', 'captionKind', 'captionEn', 'captionZh', 'visualTheme'], [
    'sourceMovieId', 'sourceTrackId', 'sourceCueIndex', 'sourceStartMs', 'sourceEndMs', 'sourceTimestamp',
    'movieTitle', 'releaseYear', 'runId', 'providerResourceId', 'selectionId', 'note', 'sourceInMs',
  ])
  if (!nonnegativeInteger(scene.index)
    || (scene.captionKind !== 'original' && scene.captionKind !== 'quote')
    || !text(scene.captionEn, 10_000)
    || !text(scene.captionZh, 10_000)
    || !text(scene.visualTheme, 1_000)
    || !optionalPositiveInteger(scene.sourceMovieId)
    || !optionalPositiveInteger(scene.sourceTrackId)
    || !optionalNonnegativeInteger(scene.sourceCueIndex)
    || !optionalNonnegativeInteger(scene.sourceStartMs)
    || !optionalNonnegativeInteger(scene.sourceEndMs)
    || !optionalText(scene.sourceTimestamp, 100)
    || !optionalText(scene.movieTitle, 300)
    || !(scene.releaseYear === undefined || scene.releaseYear === null || positiveInteger(scene.releaseYear))
    || !(scene.runId === undefined || isUuid(scene.runId))
    || !optionalPositiveInteger(scene.providerResourceId)
    || !optionalPositiveInteger(scene.selectionId)
    || !optionalText(scene.note, 1_000)
    || !optionalNonnegativeInteger(scene.sourceInMs)) {
    throw invalidManifest()
  }
  const parsed = scene as unknown as VideoRunScene
  return parsed.runId === undefined ? parsed : { ...parsed, runId: parsed.runId.toLowerCase() }
}

function parseSource(value: unknown, ownerId: string): VideoRunSource {
  const source = record(value)
  exactKeys(source, ['artifactKey', 'sha256'], [
    'selectionId', 'sizeBytes', 'width', 'height', 'durationMs', 'frameRate', 'videoCodec', 'audioCodec',
    'requiresAttribution', 'requiredAttributionUrl', 'quotaLimit', 'quotaRemaining',
  ])
  if (!isOwnedArtifactKey(source.artifactKey, ownerId)
    || !isSha256(source.sha256)
    || !optionalPositiveInteger(source.selectionId)
    || !optionalPositiveInteger(source.sizeBytes)
    || !optionalPositiveInteger(source.width)
    || !optionalPositiveInteger(source.height)
    || !optionalPositiveInteger(source.durationMs)
    || !optionalPositiveNumber(source.frameRate)
    || !optionalText(source.videoCodec, 200)
    || !(source.audioCodec === undefined || source.audioCodec === null || text(source.audioCodec, 200))
    || !(source.requiresAttribution === undefined || typeof source.requiresAttribution === 'boolean')
    || !(source.requiredAttributionUrl === undefined || source.requiredAttributionUrl === null || stableAttributionUrl(source.requiredAttributionUrl))
    || !optionalNullableNonnegativeInteger(source.quotaLimit)
    || !optionalNullableNonnegativeInteger(source.quotaRemaining)) {
    throw invalidManifest()
  }
  return source as unknown as VideoRunSource
}

function parseOutput(value: unknown, ownerId: string): VideoRunOutput {
  const output = record(value)
  exactKeys(output, ['artifactKey', 'sha256'], ['sizeBytes', 'durationMs', 'videoCodec', 'audioCodec', 'pixelFormat', 'ffmpegVersion'])
  if (!isOwnedArtifactKey(output.artifactKey, ownerId)
    || !isSha256(output.sha256)
    || !optionalPositiveInteger(output.sizeBytes)
    || !optionalPositiveInteger(output.durationMs)
    || !optionalText(output.videoCodec, 200)
    || !optionalText(output.audioCodec, 200)
    || !optionalText(output.pixelFormat, 200)
    || !optionalText(output.ffmpegVersion, 500)) {
    throw invalidManifest()
  }
  return output as unknown as VideoRunOutput
}

function serializableManifest(manifest: VideoRunManifest): VideoRunManifest {
  return {
    version: manifest.version,
    planId: manifest.planId,
    renderId: manifest.renderId,
    requestDigest: manifest.requestDigest,
    theme: manifest.theme,
    quote: { ...manifest.quote },
    scenes: manifest.scenes.map(serializableScene),
    ...(manifest.sources === undefined ? {} : { sources: manifest.sources.map(serializableSource) }),
    ...(manifest.output === undefined ? {} : { output: serializableOutput(manifest.output) }),
    stage: manifest.stage,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
  }
}

function serializableScene(scene: VideoRunScene): VideoRunScene {
  return {
    index: scene.index,
    captionKind: scene.captionKind,
    captionEn: scene.captionEn,
    captionZh: scene.captionZh,
    visualTheme: scene.visualTheme,
    ...(scene.sourceMovieId === undefined ? {} : { sourceMovieId: scene.sourceMovieId }),
    ...(scene.sourceTrackId === undefined ? {} : { sourceTrackId: scene.sourceTrackId }),
    ...(scene.sourceCueIndex === undefined ? {} : { sourceCueIndex: scene.sourceCueIndex }),
    ...(scene.sourceStartMs === undefined ? {} : { sourceStartMs: scene.sourceStartMs }),
    ...(scene.sourceEndMs === undefined ? {} : { sourceEndMs: scene.sourceEndMs }),
    ...(scene.sourceTimestamp === undefined ? {} : { sourceTimestamp: scene.sourceTimestamp }),
    ...(scene.movieTitle === undefined ? {} : { movieTitle: scene.movieTitle }),
    ...(scene.releaseYear === undefined ? {} : { releaseYear: scene.releaseYear }),
    ...(scene.runId === undefined ? {} : { runId: scene.runId }),
    ...(scene.providerResourceId === undefined ? {} : { providerResourceId: scene.providerResourceId }),
    ...(scene.selectionId === undefined ? {} : { selectionId: scene.selectionId }),
    ...(scene.note === undefined ? {} : { note: scene.note }),
    ...(scene.sourceInMs === undefined ? {} : { sourceInMs: scene.sourceInMs }),
  }
}

function serializableSource(source: VideoRunSource): VideoRunSource {
  return {
    artifactKey: source.artifactKey,
    sha256: source.sha256,
    ...(source.selectionId === undefined ? {} : { selectionId: source.selectionId }),
    ...(source.sizeBytes === undefined ? {} : { sizeBytes: source.sizeBytes }),
    ...(source.width === undefined ? {} : { width: source.width }),
    ...(source.height === undefined ? {} : { height: source.height }),
    ...(source.durationMs === undefined ? {} : { durationMs: source.durationMs }),
    ...(source.frameRate === undefined ? {} : { frameRate: source.frameRate }),
    ...(source.videoCodec === undefined ? {} : { videoCodec: source.videoCodec }),
    ...(source.audioCodec === undefined ? {} : { audioCodec: source.audioCodec }),
    ...(source.requiresAttribution === undefined ? {} : { requiresAttribution: source.requiresAttribution }),
    ...(source.requiredAttributionUrl === undefined ? {} : { requiredAttributionUrl: source.requiredAttributionUrl }),
    ...(source.quotaLimit === undefined ? {} : { quotaLimit: source.quotaLimit }),
    ...(source.quotaRemaining === undefined ? {} : { quotaRemaining: source.quotaRemaining }),
  }
}

function serializableOutput(output: VideoRunOutput): VideoRunOutput {
  return {
    artifactKey: output.artifactKey,
    sha256: output.sha256,
    ...(output.sizeBytes === undefined ? {} : { sizeBytes: output.sizeBytes }),
    ...(output.durationMs === undefined ? {} : { durationMs: output.durationMs }),
    ...(output.videoCodec === undefined ? {} : { videoCodec: output.videoCodec }),
    ...(output.audioCodec === undefined ? {} : { audioCodec: output.audioCodec }),
    ...(output.pixelFormat === undefined ? {} : { pixelFormat: output.pixelFormat }),
    ...(output.ffmpegVersion === undefined ? {} : { ffmpegVersion: output.ffmpegVersion }),
  }
}

function filesMatch(files: VideoRunSource[], localFiles: LocalFileState): boolean {
  return files.length > 0 && files.every(file => localFiles.hashes[file.artifactKey] === file.sha256)
}

function rejectPrivateContent(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectPrivateContent)
    return
  }
  if (typeof value === 'string') {
    if (containsUrl(value)) throw invalidManifest()
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, nested] of Object.entries(value)) {
    if (isForbiddenManifestKey(key)) throw invalidManifest()
    if (key === 'requiredAttributionUrl') {
      if (nested !== undefined && nested !== null && !stableAttributionUrl(nested)) throw invalidManifest()
      continue
    }
    rejectPrivateContent(nested)
  }
}

function isForbiddenManifestKey(key: string): boolean {
  if (key === 'requiredAttributionUrl') return false
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return normalized.includes('url')
    || normalized.includes('token')
    || normalized.includes('secret')
    || normalized.includes('authorization')
}

function stableAttributionUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    const components = decodeUrlComponents(`${url.hostname}\n${url.pathname}\n${url.search}\n${url.hash}`)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.hostname !== ''
      && url.username === ''
      && url.password === ''
      && !sensitiveUrlVocabulary.test(components)
  } catch {
    return false
  }
}

function containsUrl(value: string): boolean {
  embeddedUrl.lastIndex = 0
  return Array.from(value.matchAll(embeddedUrl)).some(match => {
    try {
      new URL(match[0])
      return true
    } catch {
      return false
    }
  })
}

function decodeUrlComponents(value: string): string {
  let decoded = value
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded.replace(/\+/g, ' '))
      if (next === decoded) return decoded
      decoded = next
    } catch {
      return decoded
    }
  }
  return decoded
}

function withoutPlanId(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPlanId)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'planId')
    .map(([key, nested]) => [key, withoutPlanId(nested)]))
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

function isSafeArtifactKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^video-runs\/([^/]+)\/(.+)$/.exec(value)
  return match !== null && isUuid(match[1]) && isSafeRelativePath(match[2])
}

function isOwnedArtifactKey(value: unknown, ownerId: string): value is string {
  if (!isSafeArtifactKey(value)) return false
  const runId = value.split('/')[1]
  return runId.toLowerCase() === ownerId.toLowerCase()
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !forbiddenArtifactTerm.test(value)
    && !/[\\\u0000-\u001f\u007f]/.test(value)
    && !/^[a-z][a-z0-9+.-]*:/i.test(value)
    && value.split('/').every(segment => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)
      && segment !== '.'
      && segment !== '..'
      && !segment.endsWith('.')
      && !segment.endsWith(' ')
      && !windowsDeviceName.test(segment))
}

function assertRegisteredArtifactPath(path: string): ArtifactPathRegistration {
  const registration = artifactPathRegistrations.get(path)
  if (registration === undefined) throw new Error('unsafe artifact path')

  const root = resolve(registration.root)
  const destination = resolve(root, ...registration.key.split('/'))
  assertContainedPath(root, destination, 'unsafe artifact path')
  if (destination !== registration.destination || destination !== path) throw new Error('unsafe artifact path')
  return registration
}

function assertContainedPath(root: string, destination: string, message: string): void {
  const pathFromRoot = relative(root, destination)
  if (pathFromRoot === '' || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) throw new Error(message)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidManifest()
  return value as Record<string, unknown>
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw invalidManifest()
  return value
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional])
  if (!required.every(key => key in value) || Object.keys(value).some(key => !allowed.has(key))) throw invalidManifest()
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && sha256Pattern.test(value)
}

function text(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maximumLength
}

function optionalText(value: unknown, maximumLength: number): boolean {
  return value === undefined || text(value, maximumLength)
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function optionalPositiveInteger(value: unknown): boolean {
  return value === undefined || positiveInteger(value)
}

function optionalNonnegativeInteger(value: unknown): boolean {
  return value === undefined || nonnegativeInteger(value)
}

function optionalPositiveNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0)
}

function optionalNullableNonnegativeInteger(value: unknown): boolean {
  return value === undefined || value === null || nonnegativeInteger(value)
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function invalidManifest(): Error {
  return new Error('invalid manifest')
}
