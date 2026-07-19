import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { VideoAssetCandidate, VideoAssetMatchResponse } from '../supabase/functions/_shared/video-assets.js'
import type { CompleteRenderRequest } from './video-production-api.js'
import { buildAssSubtitles } from './ass-subtitles.js'
import { validateFinalMediaProbe, probeMedia, type MediaProbe } from './media-probe.js'
import { selectExactQuote } from './quote-selection.js'
import { buildStoryboard, type StoryboardScene } from './storyboard.js'
import { SubtitleApi } from './supabase-api.js'
import {
  artifactKey,
  canonicalRequestDigest,
  readManifest,
  resolveArtifactPath,
  sha256File,
  writeManifestAtomic,
  type ResolvedArtifactPath,
  type VideoRunManifest,
  type VideoRunSource,
} from './video-artifacts.js'
import { VideoProductionApi } from './video-production-api.js'
import {
  FormalDownloadBudget,
  VecteezyDownloadClient,
  type VecteezyDownloadInfo,
} from './vecteezy-download.js'
import { PRODUCTION_RENDER, renderVideo } from './video-renderer.js'

export interface VideoPipelineDependencies {
  subtitleApi: Pick<SubtitleApi, 'search'>
  productionApi: Pick<VideoProductionApi,
    'matchScene' | 'selectCandidate' | 'start' | 'recordDownload' |
    'beginRender' | 'complete' | 'fail' | 'retry'>
  downloads: VecteezyDownloadClient
  probeMedia: typeof probeMedia
  renderVideo: typeof renderVideo
  readManifest: typeof readManifest
  writeManifest: typeof writeManifestAtomic
  output: (message: string) => void
  now: () => string
}

export interface ReviewedVideoRunInput {
  version: 1
  quote: { trackId: number; cueIndex: number; captionZh: string }
  scenes: [
    { index: 0; runId: string; providerResourceId: number; note: string; sourceInMs: number },
    { index: 1; runId: string; providerResourceId: number; note: string; sourceInMs: number },
    { index: 2; runId: string; providerResourceId: number; note: string; sourceInMs: number },
    { index: 3; runId: string; providerResourceId: number; note: string; sourceInMs: number },
  ]
}

export interface PlanVideoInput {
  artifactRoot: string
  theme: string
  candidateCount: number
  writeLatestPlan?: boolean
}

export interface ProduceVideoInput {
  artifactRoot: string
  manifestPath: string
  reviewPath: string
  maxDownloads: number
}

export interface ResumeVideoInput {
  artifactRoot: string
  manifestPath: string
}

export interface VideoPlanPaths {
  planId: string
  manifestPath: string
  reviewPath: string
}

export interface VideoProductionResult extends VideoPlanPaths {
  renderId: string
  stage: 'downloading' | 'rendering' | 'completed' | 'failed'
}

interface CandidatePacket {
  version: 1
  planId: string
  scenes: Array<{
    index: number
    runId: string
    candidates: VideoAssetCandidate[]
  }>
}

interface PersistedDownload {
  index: number
  selectionId: number
  downloadId: number
  source: VideoRunSource
}

interface ProductionState {
  version: 1
  renderId: string
  requestDigest: string
  downloads: PersistedDownload[]
  completion?: CompleteRenderRequest
}

const CANONICAL_QUOTE_QUERY = 'hope during hard times'
const PENDING_DIGEST = '0'.repeat(64)
const REVIEW_FILE = 'review-input.json'
const CANDIDATE_FILE = 'review-candidates.json'
const STATE_FILE = 'production-state.json'
const LATEST_PLAN_FILE = 'latest-plan.json'
const MAX_FILE_SIZE_BYTES = 512 * 1024 * 1024
const MAX_AGGREGATE_SIZE_BYTES = 2 * 1024 * 1024 * 1024
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function planVideo(
  input: PlanVideoInput,
  dependencies: VideoPipelineDependencies,
): Promise<VideoPlanPaths> {
  validatePlanInput(input)
  const results = await dependencies.subtitleApi.search({ query: CANONICAL_QUOTE_QUERY, limit: 20 })
  const quote = selectExactQuote(results)
  const storyboard = buildStoryboard(quote, 'REVIEW_REQUIRED')
  const matches: VideoAssetMatchResponse[] = []
  for (const scene of storyboard.scenes) {
    matches.push(await dependencies.productionApi.matchScene({
      theme: scene.visualTheme,
      candidateCount: input.candidateCount,
    }))
  }

  const planId = randomUUID()
  const createdAt = dependencies.now()
  const scenes = storyboard.scenes.map((scene, index) => ({ ...scene, runId: matches[index].runId }))
  const manifest: VideoRunManifest = {
    version: 1,
    planId,
    renderId: null,
    requestDigest: PENDING_DIGEST,
    theme: input.theme,
    quote: {
      trackId: quote.trackId,
      cueIndex: quote.cueIndex,
      text: quote.text,
      captionZh: 'REVIEW_REQUIRED',
    },
    scenes,
    stage: 'review',
    createdAt,
    updatedAt: createdAt,
  }
  const manifestPath = manifestPathFor(input.artifactRoot, planId)
  const runDirectory = dirname(manifestPath)
  const reviewPath = join(runDirectory, REVIEW_FILE)
  const packet: CandidatePacket = {
    version: 1,
    planId,
    scenes: matches.map((match, index) => ({
      index,
      runId: match.runId,
      candidates: match.candidates.map(candidateForReview),
    })),
  }
  const reviewTemplate: ReviewedVideoRunInput = {
    version: 1,
    quote: { trackId: quote.trackId, cueIndex: quote.cueIndex, captionZh: '' },
    scenes: tuple4(matches.map((match, index) => ({
      index: index as 0 | 1 | 2 | 3,
      runId: match.runId,
      providerResourceId: 0,
      note: '',
      sourceInMs: 0,
    }))) as ReviewedVideoRunInput['scenes'],
  }

  await dependencies.writeManifest(manifestPath, manifest)
  await writeJson(join(runDirectory, CANDIDATE_FILE), packet)
  await writeJson(reviewPath, reviewTemplate)
  const paths = { planId, manifestPath, reviewPath }
  if (input.writeLatestPlan === true) await writeLatestPlan(input.artifactRoot, paths)
  dependencies.output(`plan ${planId}: 4 scenes, ${matches.reduce((sum, match) => sum + match.candidates.length, 0)} candidates, manifest.json, review-input.json`)
  return paths
}

export async function produceVideo(
  input: ProduceVideoInput,
  dependencies: VideoPipelineDependencies,
): Promise<VideoProductionResult> {
  if (input.maxDownloads !== 4) throw new Error('max downloads must equal 4')
  const manifest = await dependencies.readManifest(input.manifestPath)
  assertOwnedPlanPaths(input.artifactRoot, input.manifestPath, input.reviewPath, manifest)
  if (manifest.stage !== 'review' || manifest.renderId !== null) throw new Error('manifest is not ready for review')

  const review = parseReviewedInput(await readJson(input.reviewPath))
  const packet = parseCandidatePacket(await readJson(join(dirname(input.reviewPath), CANDIDATE_FILE)))
  assertReviewMatchesPlan(review, packet, manifest)
  const downloadInfo = await preflightDownloads(review, dependencies)

  const selections = await Promise.all(review.scenes.map(scene => dependencies.productionApi.selectCandidate({
    runId: scene.runId,
    providerResourceId: scene.providerResourceId,
    note: scene.note,
  })))
  const storyboard = buildStoryboard(selectedQuoteFrom(manifest), review.quote.captionZh)
  const selectedScenes = storyboard.scenes.map((scene, index) => ({
    ...scene,
    runId: review.scenes[index].runId,
    providerResourceId: review.scenes[index].providerResourceId,
    selectionId: selections[index].selectionId,
    note: review.scenes[index].note,
    sourceInMs: review.scenes[index].sourceInMs,
  }))
  const requestDigest = canonicalRequestDigest({
    version: 1,
    theme: manifest.theme,
    quote: {
      trackId: manifest.quote.trackId,
      cueIndex: manifest.quote.cueIndex,
      text: manifest.quote.text,
      captionZh: review.quote.captionZh,
    },
    storyboard: selectedScenes,
    render: PRODUCTION_RENDER,
    selections: review.scenes.map(scene => ({
      index: scene.index,
      runId: scene.runId,
      providerResourceId: scene.providerResourceId,
    })),
  })
  const reviewedManifest: VideoRunManifest = {
    ...manifest,
    requestDigest,
    quote: { ...manifest.quote, captionZh: review.quote.captionZh },
    scenes: selectedScenes,
    updatedAt: dependencies.now(),
  }
  await dependencies.writeManifest(manifestPathFor(input.artifactRoot, manifest.planId), reviewedManifest)

  const started = await dependencies.productionApi.start({ requestDigest, theme: manifest.theme })
  const attached = await attachAuthoritativeRun(
    input.artifactRoot,
    input.manifestPath,
    input.reviewPath,
    reviewedManifest,
    started.renderId,
    dependencies,
  )
  await writeLatestPlan(input.artifactRoot, attached.paths)

  if (started.isExisting === true && started.status === 'completed') {
    dependencies.output(`render ${started.renderId}: completed job already exists; no provider download`)
    return { ...attached.paths, renderId: started.renderId, stage: 'completed' }
  }
  if (started.isExisting === true && started.status === 'failed') {
    await dependencies.productionApi.retry(started.renderId)
  }
  return continueProduction(
    input.artifactRoot,
    attached.manifest,
    attached.paths,
    dependencies,
    downloadInfo,
  )
}

export async function resumeVideo(
  input: ResumeVideoInput,
  dependencies: VideoPipelineDependencies,
): Promise<VideoProductionResult> {
  const manifest = await dependencies.readManifest(input.manifestPath)
  if (manifest.renderId === null) throw new Error('manifest has no render ownership')
  const expectedPath = manifestPathFor(input.artifactRoot, manifest.renderId)
  if (resolve(input.manifestPath) !== resolve(expectedPath)) throw new Error('manifest run ownership mismatch')
  const paths = {
    planId: manifest.planId,
    manifestPath: expectedPath,
    reviewPath: join(dirname(expectedPath), REVIEW_FILE),
  }
  await writeLatestPlan(input.artifactRoot, paths)
  const state = await readProductionState(dirname(expectedPath), manifest)

  if (manifest.stage === 'completed') {
    const currentHash = await sha256File(expectedPath)
    const completion = state.completion ?? buildCompletionRequest(manifest, state.downloads, currentHash)
    if (completion.output.manifestSha256 !== currentHash) throw new Error('completion manifest hash mismatch')
    try {
      await dependencies.productionApi.complete(completion)
    } catch {
      throw new Error('video metadata completion failed')
    }
    dependencies.output(`render ${manifest.renderId}: completion metadata confirmed for final.mp4`)
    return { ...paths, renderId: manifest.renderId, stage: 'completed' }
  }
  if (manifest.stage === 'review') throw new Error('review must be completed before resume')
  if (manifest.stage === 'failed') await dependencies.productionApi.retry(manifest.renderId)
  return continueProduction(input.artifactRoot, manifest, paths, dependencies)
}

async function continueProduction(
  artifactRoot: string,
  initialManifest: VideoRunManifest,
  paths: VideoPlanPaths,
  dependencies: VideoPipelineDependencies,
  preflight?: VecteezyDownloadInfo[],
): Promise<VideoProductionResult> {
  if (initialManifest.renderId === null) throw new Error('manifest has no render ownership')
  const renderId = initialManifest.renderId
  let manifest = initialManifest
  let state = await readProductionState(dirname(paths.manifestPath), manifest)
  const validDownloads = await matchingDownloads(artifactRoot, manifest, state.downloads)
  const missingScenes = manifest.scenes.filter(scene => !validDownloads.has(scene.index))

  if (missingScenes.length > 0) {
    const infoByResource = new Map((preflight ?? await preflightManifestDownloads(manifest, dependencies))
      .map(info => [info.resourceId, info]))
    const budget = new FormalDownloadBudget(4)
    let requests: Awaited<ReturnType<VecteezyDownloadClient['requestDownload']>>[]
    try {
      requests = await Promise.all(missingScenes.map(scene => dependencies.downloads.requestDownload(
        requiredPositiveInteger(scene.providerResourceId, 'scene resource ID'),
        budget,
      )))
    } catch {
      return failProduction('download_failure', 'video source download failed')
    }

    for (const [requestIndex, scene] of missingScenes.entries()) {
      try {
        const ready = await dependencies.downloads.waitForDownload(requests[requestIndex])
        const key = artifactKey(renderId, `assets/scene-${String(scene.index + 1).padStart(2, '0')}.mp4`)
        const destination = resolveArtifactPath(artifactRoot, key)
        const relativeDestination = relative(process.cwd(), destination)
        if (relativeDestination === '' || relativeDestination === '..' || relativeDestination.startsWith(`..${sep}`)) {
          throw new Error('artifact root must be beneath the working directory')
        }
        const completed = await dependencies.downloads.transferSignedUrl(ready, relativeDestination)
        const probe = await dependencies.probeMedia(destination)
        const selectionId = requiredPositiveInteger(scene.selectionId, 'scene selection ID')
        const info = infoByResource.get(requiredPositiveInteger(scene.providerResourceId, 'scene resource ID'))
        if (info === undefined) throw new Error('download preflight state is unavailable')
        const recorded = await dependencies.productionApi.recordDownload({
          renderId,
          selectionId,
          artifactKey: key,
          fileType: 'mp4',
          sourceSizeBytes: completed.sourceSizeBytes,
          sourceSha256: completed.sourceSha256,
          width: probe.width,
          height: probe.height,
          durationMs: probe.durationMs,
          frameRate: probe.frameRate,
          videoCodec: probe.videoCodec,
          audioCodec: probe.audioCodec,
          requiresAttribution: completed.requiresAttribution,
          requiredAttributionUrl: completed.requiredAttributionUrl,
          quotaLimit: completed.quota.limit ?? info.quota.limit,
          quotaRemaining: completed.quota.remaining ?? info.quota.remaining,
        })
        const source: VideoRunSource = {
          artifactKey: key,
          sha256: completed.sourceSha256,
          selectionId,
          sizeBytes: completed.sourceSizeBytes,
          width: probe.width,
          height: probe.height,
          durationMs: probe.durationMs,
          frameRate: probe.frameRate,
          videoCodec: probe.videoCodec,
          audioCodec: probe.audioCodec,
          requiresAttribution: completed.requiresAttribution,
          requiredAttributionUrl: completed.requiredAttributionUrl,
          quotaLimit: completed.quota.limit ?? info.quota.limit,
          quotaRemaining: completed.quota.remaining ?? info.quota.remaining,
        }
        state = {
          ...state,
          downloads: [...state.downloads.filter(item => item.index !== scene.index), {
            index: scene.index,
            selectionId,
            downloadId: recorded.downloadId,
            source,
          }].sort((left, right) => left.index - right.index),
        }
        manifest = {
          ...manifest,
          sources: state.downloads.map(item => item.source),
          stage: 'downloading',
          updatedAt: dependencies.now(),
        }
        await writeProductionState(dirname(paths.manifestPath), state)
        await dependencies.writeManifest(manifestPathFor(artifactRoot, renderId), manifest)
      } catch {
        return failProduction('download_failure', 'video source download failed')
      }
    }
  }

  if (state.downloads.length !== 4) return failProduction('source_validation_failure', 'video source validation failed')

  try {
    await dependencies.productionApi.beginRender(renderId)
    manifest = { ...manifest, stage: 'rendering', updatedAt: dependencies.now() }
    await dependencies.writeManifest(manifestPathFor(artifactRoot, renderId), manifest)
    const sourcePaths = tuple4(state.downloads.map(item => resolveArtifactPath(artifactRoot, item.source.artifactKey)))
    const normalizedPaths = tuple4([0, 1, 2, 3].map(index => resolveArtifactPath(
      artifactRoot,
      artifactKey(renderId, `normalized/scene-${String(index + 1).padStart(2, '0')}.mp4`),
    )))
    const subtitlesPath = resolveArtifactPath(artifactRoot, artifactKey(renderId, 'subtitles.ass'))
    const finalPath = resolveArtifactPath(artifactRoot, artifactKey(renderId, 'final.mp4'))
    const contactSheetPath = resolveArtifactPath(artifactRoot, artifactKey(renderId, 'contact-sheet.jpg'))
    const scenes = manifest.scenes as StoryboardScene[]
    await mkdir(dirname(subtitlesPath), { recursive: true })
    await writeFile(subtitlesPath, buildAssSubtitles(scenes), 'utf8')
    const rendered = await dependencies.renderVideo({
      sourcePaths,
      sourceInPointsMs: tuple4(manifest.scenes.map(scene => requiredNonnegativeInteger(scene.sourceInMs, 'source in-point'))),
      scenes,
      normalizedPaths,
      subtitlesPath,
      finalPath,
      contactSheetPath,
    })
    const finalMedia = validateFinalMediaProbe(await dependencies.probeMedia(rendered.finalPath))
    const outputHash = await sha256File(rendered.finalPath)
    const completedManifest: VideoRunManifest = {
      ...manifest,
      output: {
        artifactKey: artifactKey(renderId, 'final.mp4'),
        sha256: outputHash,
        sizeBytes: finalMedia.sizeBytes,
        durationMs: finalMedia.durationMs,
        videoCodec: finalMedia.videoCodec,
        audioCodec: requiredText(finalMedia.audioCodec, 'final audio codec'),
        pixelFormat: finalMedia.pixelFormat,
        ffmpegVersion: 'ffmpeg (validated local renderer)',
      },
      stage: 'completed',
      updatedAt: dependencies.now(),
    }
    await dependencies.writeManifest(manifestPathFor(artifactRoot, renderId), completedManifest)
    try {
      const manifestHash = await sha256File(paths.manifestPath)
      const completion = buildCompletionRequest(completedManifest, state.downloads, manifestHash)
      state = { ...state, completion }
      await writeProductionState(dirname(paths.manifestPath), state)
      await dependencies.productionApi.complete(completion)
    } catch {
      throw new MetadataCompletionError()
    }
    dependencies.output(`render ${renderId}: 4 sources completed, final.mp4`)
    return { ...paths, renderId, stage: 'completed' }
  } catch (error) {
    if (error instanceof MetadataCompletionError) throw new Error('video metadata completion failed')
    return failProduction('render_failure', 'video render failed')
  }

  async function failProduction(
    failureCode: 'download_failure' | 'source_validation_failure' | 'render_failure',
    failureMessage: string,
  ): Promise<never> {
    const failed = { ...manifest, stage: 'failed' as const, updatedAt: dependencies.now() }
    await dependencies.writeManifest(manifestPathFor(artifactRoot, renderId), failed).catch(() => undefined)
    await dependencies.productionApi.fail({ renderId, failureCode, failureMessage }).catch(() => undefined)
    dependencies.output(`render ${renderId}: failed; ${state.downloads.length} sources retained`)
    throw new Error('video production failed')
  }
}

function buildCompletionRequest(
  manifest: VideoRunManifest,
  downloads: PersistedDownload[],
  manifestHash: string,
): CompleteRenderRequest {
  if (manifest.renderId === null || manifest.output === undefined) throw new Error('completed manifest is invalid')
  const boundaries = [0, 7_350, 14_700, 22_050, 30_000]
  return {
    renderId: manifest.renderId,
    segments: manifest.scenes.map((scene, index) => {
      const download = downloads.find(item => item.index === index)
      if (download === undefined) throw new Error('download state is incomplete')
      const sourceInMs = requiredNonnegativeInteger(scene.sourceInMs, 'source in-point')
      return {
        segmentIndex: index as 0 | 1 | 2 | 3,
        downloadId: download.downloadId,
        timelineStartMs: boundaries[index],
        timelineEndMs: boundaries[index + 1],
        sourceInMs,
        sourceOutMs: sourceInMs + 7_950,
        captionKind: scene.captionKind,
        captionEn: scene.captionEn,
        captionZh: scene.captionZh,
        sourceTrackId: scene.sourceTrackId ?? null,
        sourceCueIndex: scene.sourceCueIndex ?? null,
      }
    }),
    output: {
      artifactKey: manifest.output.artifactKey,
      outputSha256: manifest.output.sha256,
      outputSizeBytes: requiredPositiveInteger(manifest.output.sizeBytes, 'output size'),
      outputDurationMs: requiredPositiveInteger(manifest.output.durationMs, 'output duration'),
      videoCodec: requiredText(manifest.output.videoCodec ?? null, 'final video codec'),
      audioCodec: requiredText(manifest.output.audioCodec ?? null, 'final audio codec'),
      pixelFormat: requiredText(manifest.output.pixelFormat ?? null, 'final pixel format'),
      ffmpegVersion: manifest.output.ffmpegVersion ?? 'ffmpeg (validated local renderer)',
      manifestSha256: manifestHash,
    },
  }
}

async function preflightDownloads(
  review: ReviewedVideoRunInput,
  dependencies: VideoPipelineDependencies,
): Promise<VecteezyDownloadInfo[]> {
  const info = await Promise.all(review.scenes.map(scene => dependencies.downloads.getDownloadInfo(scene.providerResourceId)))
  assertDownloadSizes(info)
  return info
}

async function preflightManifestDownloads(
  manifest: VideoRunManifest,
  dependencies: VideoPipelineDependencies,
): Promise<VecteezyDownloadInfo[]> {
  const info = await Promise.all(manifest.scenes.map(scene => dependencies.downloads.getDownloadInfo(
    requiredPositiveInteger(scene.providerResourceId, 'scene resource ID'),
  )))
  assertDownloadSizes(info)
  return info
}

function assertDownloadSizes(info: VecteezyDownloadInfo[]): void {
  if (info.some(item => item.sourceSizeBytes > MAX_FILE_SIZE_BYTES)
    || info.reduce((sum, item) => sum + item.sourceSizeBytes, 0) > MAX_AGGREGATE_SIZE_BYTES) {
    throw new Error('candidate exceeds local download limit')
  }
}

async function attachAuthoritativeRun(
  artifactRoot: string,
  sourceManifestPath: string,
  sourceReviewPath: string,
  manifest: VideoRunManifest,
  renderId: string,
  dependencies: VideoPipelineDependencies,
): Promise<{ manifest: VideoRunManifest; paths: VideoPlanPaths }> {
  if (!uuidPattern.test(renderId)) throw new Error('invalid render ownership')
  const sourceDirectory = dirname(sourceManifestPath)
  const destinationManifestPath = manifestPathFor(artifactRoot, renderId)
  const destinationDirectory = dirname(destinationManifestPath)
  let attachedManifest: VideoRunManifest

  if (await exists(destinationManifestPath)) {
    const destination = await dependencies.readManifest(destinationManifestPath)
    assertCompatibleRun(destination, manifest, renderId)
    attachedManifest = destination
    if (resolve(sourceDirectory) !== resolve(destinationDirectory)) {
      await rm(sourceDirectory, { recursive: true, force: true })
    }
  } else {
    const backupManifestPath = join(sourceDirectory, 'plan-manifest.json')
    await rename(sourceManifestPath, backupManifestPath)
    try {
      await rename(sourceDirectory, destinationDirectory)
    } catch (error) {
      await rename(backupManifestPath, sourceManifestPath).catch(() => undefined)
      if (!await exists(destinationManifestPath)) throw error
      const destination = await dependencies.readManifest(destinationManifestPath)
      assertCompatibleRun(destination, manifest, renderId)
      attachedManifest = destination
      await rm(sourceDirectory, { recursive: true, force: true })
      return {
        manifest: attachedManifest,
        paths: {
          planId: manifest.planId,
          manifestPath: destinationManifestPath,
          reviewPath: join(destinationDirectory, basename(sourceReviewPath)),
        },
      }
    }
    attachedManifest = {
      ...manifest,
      renderId,
      stage: 'downloading',
      updatedAt: dependencies.now(),
    }
    await dependencies.writeManifest(destinationManifestPath, attachedManifest)
    await rm(join(destinationDirectory, 'plan-manifest.json'), { force: true })
  }

  const paths = {
    planId: manifest.planId,
    manifestPath: destinationManifestPath,
    reviewPath: join(destinationDirectory, basename(sourceReviewPath)),
  }
  return { manifest: attachedManifest, paths }
}

function assertCompatibleRun(destination: VideoRunManifest, source: VideoRunManifest, renderId: string): void {
  const sourceSelections = source.scenes.map(scene => ({
    index: scene.index,
    runId: scene.runId,
    providerResourceId: scene.providerResourceId,
    selectionId: scene.selectionId,
  }))
  const destinationSelections = destination.scenes.map(scene => ({
    index: scene.index,
    runId: scene.runId,
    providerResourceId: scene.providerResourceId,
    selectionId: scene.selectionId,
  }))
  if (destination.renderId !== renderId
    || destination.requestDigest !== source.requestDigest
    || destination.theme !== source.theme
    || JSON.stringify(destination.quote) !== JSON.stringify(source.quote)
    || JSON.stringify(destinationSelections) !== JSON.stringify(sourceSelections)) {
    throw new Error('existing render does not match reviewed plan')
  }
  const sourceHashes = new Map((source.sources ?? []).map(item => [item.selectionId, item.sha256]))
  if ((destination.sources ?? []).some(item => sourceHashes.has(item.selectionId)
    && sourceHashes.get(item.selectionId) !== item.sha256)) {
    throw new Error('existing render artifact hash mismatch')
  }
}

async function matchingDownloads(
  artifactRoot: string,
  manifest: VideoRunManifest,
  downloads: PersistedDownload[],
): Promise<Map<number, PersistedDownload>> {
  const matches = new Map<number, PersistedDownload>()
  for (const download of downloads) {
    const scene = manifest.scenes[download.index]
    if (scene === undefined || scene.selectionId !== download.selectionId) continue
    const source = (manifest.sources ?? []).find(item => item.selectionId === download.selectionId)
    if (source === undefined || source.sha256 !== download.source.sha256) continue
    const path = resolveArtifactPath(artifactRoot, source.artifactKey)
    if (await exists(path) && await sha256File(path) === source.sha256) matches.set(download.index, download)
  }
  return matches
}

function assertOwnedPlanPaths(
  artifactRoot: string,
  manifestPath: string,
  reviewPath: string,
  manifest: VideoRunManifest,
): void {
  const expectedManifest = manifestPathFor(artifactRoot, manifest.planId)
  if (resolve(manifestPath) !== resolve(expectedManifest)
    || resolve(reviewPath) !== resolve(join(dirname(expectedManifest), REVIEW_FILE))) {
    throw new Error('manifest run ownership mismatch')
  }
}

function assertReviewMatchesPlan(
  review: ReviewedVideoRunInput,
  packet: CandidatePacket,
  manifest: VideoRunManifest,
): void {
  if (packet.planId !== manifest.planId
    || review.quote.trackId !== manifest.quote.trackId
    || review.quote.cueIndex !== manifest.quote.cueIndex
    || review.quote.captionZh.trim() === '') {
    throw new Error('review does not match plan')
  }
  for (const scene of review.scenes) {
    const candidateScene = packet.scenes[scene.index]
    const manifestScene = manifest.scenes[scene.index]
    if (candidateScene === undefined
      || manifestScene === undefined
      || scene.runId !== candidateScene.runId
      || scene.runId !== manifestScene.runId
      || !candidateScene.candidates.some(candidate => candidate.providerResourceId === scene.providerResourceId)) {
      throw new Error('review does not match plan')
    }
  }
}

function parseReviewedInput(value: unknown): ReviewedVideoRunInput {
  try {
    const input = record(value)
    exactKeys(input, ['version', 'quote', 'scenes'])
    if (input.version !== 1) throw new Error()
    const quote = record(input.quote)
    exactKeys(quote, ['trackId', 'cueIndex', 'captionZh'])
    if (!positiveInteger(quote.trackId) || !nonnegativeInteger(quote.cueIndex) || !boundedText(quote.captionZh, 300)) throw new Error()
    if (!Array.isArray(input.scenes) || input.scenes.length !== 4) throw new Error()
    const scenes = input.scenes.map((value, index) => {
      const scene = record(value)
      exactKeys(scene, ['index', 'runId', 'providerResourceId', 'note', 'sourceInMs'])
      if (scene.index !== index
        || !uuidPattern.test(String(scene.runId))
        || !positiveInteger(scene.providerResourceId)
        || !boundedText(scene.note, 500)
        || !nonnegativeInteger(scene.sourceInMs)) throw new Error()
      return {
        index: index as 0 | 1 | 2 | 3,
        runId: scene.runId as string,
        providerResourceId: scene.providerResourceId,
        note: scene.note as string,
        sourceInMs: scene.sourceInMs,
      }
    })
    return {
      version: 1,
      quote: quote as ReviewedVideoRunInput['quote'],
      scenes: tuple4(scenes) as ReviewedVideoRunInput['scenes'],
    }
  } catch {
    throw new Error('invalid reviewed video input')
  }
}

function parseCandidatePacket(value: unknown): CandidatePacket {
  try {
    const packet = record(value)
    if (packet.version !== 1 || !uuidPattern.test(String(packet.planId)) || !Array.isArray(packet.scenes) || packet.scenes.length !== 4) throw new Error()
    const scenes = packet.scenes.map((value, index) => {
      const scene = record(value)
      if (scene.index !== index || !uuidPattern.test(String(scene.runId)) || !Array.isArray(scene.candidates)) throw new Error()
      const candidates = scene.candidates.filter((candidate): candidate is VideoAssetCandidate => {
        return typeof candidate === 'object' && candidate !== null
          && positiveInteger((candidate as Record<string, unknown>).providerResourceId)
      })
      if (candidates.length !== scene.candidates.length) throw new Error()
      return { index, runId: scene.runId as string, candidates }
    })
    return { version: 1, planId: packet.planId as string, scenes }
  } catch {
    throw new Error('invalid review candidate packet')
  }
}

async function readProductionState(directory: string, manifest: VideoRunManifest): Promise<ProductionState> {
  const path = join(directory, STATE_FILE)
  if (!await exists(path)) {
    if (manifest.renderId === null) throw new Error('manifest has no render ownership')
    return { version: 1, renderId: manifest.renderId, requestDigest: manifest.requestDigest, downloads: [] }
  }
  const value = await readJson(path) as ProductionState
  if (value.version !== 1
    || value.renderId !== manifest.renderId
    || value.requestDigest !== manifest.requestDigest
    || !Array.isArray(value.downloads)) {
    throw new Error('invalid production state')
  }
  return value
}

async function writeProductionState(directory: string, state: ProductionState): Promise<void> {
  await writeJsonAtomic(join(directory, STATE_FILE), state)
}

function candidateForReview(candidate: VideoAssetCandidate): VideoAssetCandidate {
  return {
    provider: candidate.provider,
    providerResourceId: candidate.providerResourceId,
    title: candidate.title,
    licenseType: candidate.licenseType,
    aiGenerated: candidate.aiGenerated,
    orientation: candidate.orientation,
    fileTypes: candidate.fileTypes.map(item => ({ ...item })),
    downloadSizes: candidate.downloadSizes.map(item => ({ ...item })),
    score: candidate.score,
    bestRank: candidate.bestRank,
    matchedBy: [...candidate.matchedBy],
    previewUrl: candidate.previewUrl,
  }
}

function selectedQuoteFrom(manifest: VideoRunManifest) {
  const quoteScene = manifest.scenes.find(scene => scene.captionKind === 'quote')
  if (quoteScene === undefined
    || quoteScene.sourceMovieId === undefined
    || quoteScene.sourceStartMs === undefined
    || quoteScene.sourceEndMs === undefined
    || quoteScene.sourceTimestamp === undefined
    || quoteScene.movieTitle === undefined
    || quoteScene.releaseYear === undefined) {
    throw new Error('manifest quote source is incomplete')
  }
  return {
    text: manifest.quote.text,
    similarity: 0,
    movieId: quoteScene.sourceMovieId,
    movieTitle: quoteScene.movieTitle,
    releaseYear: quoteScene.releaseYear,
    trackId: manifest.quote.trackId,
    cueIndex: manifest.quote.cueIndex,
    startMs: quoteScene.sourceStartMs,
    endMs: quoteScene.sourceEndMs,
    timestamp: quoteScene.sourceTimestamp,
  }
}

function manifestPathFor(artifactRoot: string, ownerId: string): ResolvedArtifactPath {
  return resolveArtifactPath(artifactRoot, artifactKey(ownerId, 'manifest.json'))
}

async function writeLatestPlan(artifactRoot: string, paths: VideoPlanPaths): Promise<void> {
  await mkdir(resolve(artifactRoot), { recursive: true })
  const destination = join(resolve(artifactRoot), LATEST_PLAN_FILE)
  const temporary = `${destination}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(paths, null, 2)}\n`, 'utf8')
  await rename(temporary, destination)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new Error('invalid local video state')
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function validatePlanInput(input: PlanVideoInput): void {
  if (input.theme.trim() === '' || input.theme.length > 300) throw new Error('invalid video theme')
  if (!Number.isSafeInteger(input.candidateCount) || input.candidateCount < 5 || input.candidateCount > 10) {
    throw new Error('candidate count must be between 5 and 10')
  }
}

function exactKeys(value: Record<string, unknown>, required: string[]): void {
  if (Object.keys(value).length !== required.length || !required.every(key => key in value)) throw new Error()
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error()
  return value as Record<string, unknown>
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maximum
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (!positiveInteger(value)) throw new Error(`invalid ${name}`)
  return value
}

function requiredNonnegativeInteger(value: unknown, name: string): number {
  if (!nonnegativeInteger(value)) throw new Error(`invalid ${name}`)
  return value
}

function requiredText(value: string | null, name: string): string {
  if (value === null || value.trim() === '') throw new Error(`invalid ${name}`)
  return value
}

function tuple4<T>(values: T[]): [T, T, T, T] {
  if (values.length !== 4) throw new Error('expected four values')
  return values as [T, T, T, T]
}

class MetadataCompletionError extends Error {}
