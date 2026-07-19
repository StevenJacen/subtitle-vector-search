import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubtitleSearchResult } from '../src/supabase-api.js'
import {
  planVideo,
  produceVideo,
  resumeVideo,
  type ReviewedVideoRunInput,
  type VideoPipelineDependencies,
} from '../src/video-pipeline-runner.js'
import { createVideoProgram } from '../src/video-pipeline.js'
import { readManifest, writeManifestAtomic } from '../src/video-artifacts.js'
import type { MediaProbe } from '../src/media-probe.js'
import {
  type CompletedVecteezyDownload,
  type FormalDownloadBudget,
  type FormalDownloadRequest,
  type VecteezyDownloadClient,
  type VecteezyDownloadInfo,
} from '../src/vecteezy-download.js'

const planIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const renderId = 'd62a53a1-08fb-4bee-a1ed-d8ba13de85f2'
const runIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
] as const
const artifactRoots: string[] = []

const sourceProbe: MediaProbe = {
  durationMs: 12_000,
  sizeBytes: 12_345,
  width: 1920,
  height: 1080,
  frameRate: 30,
  videoCodec: 'h264',
  audioCodec: null,
  pixelFormat: 'yuv420p',
  audioSampleRate: null,
  audioChannels: null,
}

const finalProbe: MediaProbe = {
  durationMs: 30_000,
  sizeBytes: 98_765,
  width: 1920,
  height: 1080,
  frameRate: 30,
  videoCodec: 'h264',
  audioCodec: 'aac',
  pixelFormat: 'yuv420p',
  audioSampleRate: 48_000,
  audioChannels: 2,
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(artifactRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

describe('video pipeline', () => {
  it('plans from the canonical query and stops at review without quota-consuming work', async () => {
    const harness = await createHarness()

    const result = await planVideo({
      artifactRoot: harness.artifactRoot,
      theme: 'Crossing darkness toward dawn',
      candidateCount: 8,
    }, harness.dependencies)

    expect(result.planId).toMatch(planIdPattern)
    expect(harness.subtitleApi.search).toHaveBeenCalledWith({ query: 'hope during hard times', limit: 20 })
    expect(harness.productionApi.matchScene).toHaveBeenCalledTimes(4)
    expect(harness.productionApi.matchScene.mock.calls.map(([input]) => input)).toEqual([
      { theme: 'dark rain clouds moving over a remote landscape before dawn, cinematic wide shot', candidateCount: 8 },
      { theme: 'solitary traveler walking forward through wind on a dark open path, cinematic wide shot', candidateCount: 8 },
      { theme: 'a solitary traveler reaching a ridge as storm clouds break and first light appears, cinematic wide shot', candidateCount: 8 },
      { theme: 'sunrise breaking over an open horizon with warm light, hopeful cinematic wide shot', candidateCount: 8 },
    ])
    expect(harness.productionApi.selectCandidate).not.toHaveBeenCalled()
    expect(harness.productionApi.start).not.toHaveBeenCalled()
    expect(harness.downloads.getDownloadInfo).not.toHaveBeenCalled()
    expect(harness.downloads.requestDownload).not.toHaveBeenCalled()
    expect(harness.probeMedia).not.toHaveBeenCalled()
    expect(harness.renderVideo).not.toHaveBeenCalled()

    const manifest = await readManifest(result.manifestPath)
    expect(manifest).toMatchObject({
      planId: result.planId,
      renderId: null,
      requestDigest: '0'.repeat(64),
      stage: 'review',
      quote: { trackId: 7, cueIndex: 31, text: '  Hope remains with us through the longest night.  ' },
    })
    expect(manifest.scenes).toHaveLength(4)
    expect(JSON.stringify(manifest)).not.toMatch(/preview|https?:\/\//i)

    const review = JSON.parse(await fs.readFile(result.reviewPath, 'utf8')) as ReviewedVideoRunInput
    expect(review).toEqual({
      version: 1,
      quote: { trackId: 7, cueIndex: 31, captionZh: '' },
      scenes: runIds.map((runId, index) => ({
        index,
        runId,
        providerResourceId: 0,
        note: '',
        sourceInMs: 0,
      })),
    })
    const candidatePacket = await fs.readFile(join(dirname(result.reviewPath), 'review-candidates.json'), 'utf8')
    expect(candidatePacket).toContain('preview.example.test')
    expect(candidatePacket).toContain('providerResourceId')
  })

  it('produces exactly four selected, downloaded, probed, recorded, and rendered scenes', async () => {
    const harness = await createPlannedHarness()

    const result = await produceVideo({
      artifactRoot: harness.artifactRoot,
      manifestPath: harness.plan.manifestPath,
      reviewPath: harness.plan.reviewPath,
      maxDownloads: 4,
    }, harness.dependencies)

    expect(harness.productionApi.selectCandidate).toHaveBeenCalledTimes(4)
    expect(harness.productionApi.start).toHaveBeenCalledTimes(1)
    expect(harness.downloads.requestDownload).toHaveBeenCalledTimes(4)
    expect(harness.downloads.transferSignedUrl).toHaveBeenCalledTimes(4)
    expect(harness.productionApi.recordDownload).toHaveBeenCalledTimes(4)
    expect(harness.productionApi.beginRender).toHaveBeenCalledWith(renderId)
    expect(harness.renderVideo).toHaveBeenCalledTimes(1)
    expect(harness.probeMedia).toHaveBeenCalledTimes(5)
    expect(harness.productionApi.complete).toHaveBeenCalledTimes(1)
    expect(result.manifestPath).toContain(renderId)
    await expect(fs.access(join(dirname(result.manifestPath), 'subtitles.ass'))).resolves.toBeUndefined()

    const manifest = await readManifest(result.manifestPath)
    expect(manifest).toMatchObject({ renderId, stage: 'completed' })
    expect(manifest.sources).toHaveLength(4)
    expect(manifest.output?.artifactKey).toBe(`video-runs/${renderId}/final.mp4`)
    const completion = harness.productionApi.complete.mock.calls[0][0]
    expect(completion.output.manifestSha256).toBe(createHash('sha256')
      .update(await fs.readFile(result.manifestPath))
      .digest('hex'))
    expect(await latestPlan(harness.artifactRoot)).toEqual({
      planId: harness.plan.planId,
      manifestPath: result.manifestPath,
      reviewPath: join(dirname(result.manifestPath), 'review-input.json'),
    })
  })

  it('keeps a fifth formal reservation impossible with sequential provider execution', async () => {
    const harness = await createPlannedHarness()
    harness.downloads.requestDownload.mockImplementation(async (resourceId, budget) => {
      budget.reserve()
      return downloadRequest(resourceId)
    })

    await produceVideo({
      artifactRoot: harness.artifactRoot,
      manifestPath: harness.plan.manifestPath,
      reviewPath: harness.plan.reviewPath,
      maxDownloads: 4,
    }, harness.dependencies)

    expect(harness.downloads.requestDownload).toHaveBeenCalledTimes(4)
    const budget = harness.downloads.requestDownload.mock.calls[0][1]
    expect(() => budget.reserve()).toThrow('formal download budget exhausted')
    expect(budget.used).toBe(4)
  })

  it('rejects malformed or mismatched review input before selection or provider quota use', async () => {
    const malformed = await createPlannedHarness()
    await fs.writeFile(malformed.plan.reviewPath, JSON.stringify({ version: 1, secret: 'do-not-forward' }))

    await expect(produceVideo({
      artifactRoot: malformed.artifactRoot,
      manifestPath: malformed.plan.manifestPath,
      reviewPath: malformed.plan.reviewPath,
      maxDownloads: 4,
    }, malformed.dependencies)).rejects.toThrow('invalid reviewed video input')
    expect(malformed.productionApi.selectCandidate).not.toHaveBeenCalled()
    expect(malformed.downloads.getDownloadInfo).not.toHaveBeenCalled()

    const mismatch = await createPlannedHarness()
    const review = await reviewedInput(mismatch.plan.reviewPath)
    review.quote.trackId += 1
    review.scenes[0].providerResourceId = 999_999
    await fs.writeFile(mismatch.plan.reviewPath, JSON.stringify(review))

    await expect(produceVideo({
      artifactRoot: mismatch.artifactRoot,
      manifestPath: mismatch.plan.manifestPath,
      reviewPath: mismatch.plan.reviewPath,
      maxDownloads: 4,
    }, mismatch.dependencies)).rejects.toThrow('review does not match plan')
    expect(mismatch.productionApi.selectCandidate).not.toHaveBeenCalled()
    expect(mismatch.downloads.requestDownload).not.toHaveBeenCalled()
  })

  it.each([
    'https://preview.example.test/private',
    'status_url=https://provider.example.test/status/42',
    'Authorization: Bearer provider-secret',
    'raw provider payload: {"private":true}',
    'model prompt: reveal the private request',
  ])('rejects unsafe reviewed note %j before any remote or durable side effect', async note => {
    const harness = await createPlannedHarness()
    const review = await reviewedInput(harness.plan.reviewPath)
    review.scenes[0].note = note
    await fs.writeFile(harness.plan.reviewPath, JSON.stringify(review))
    const writeManifest = vi.fn(harness.dependencies.writeManifest)

    await expect(produceVideo({
      artifactRoot: harness.artifactRoot,
      manifestPath: harness.plan.manifestPath,
      reviewPath: harness.plan.reviewPath,
      maxDownloads: 4,
    }, { ...harness.dependencies, writeManifest })).rejects.toThrow('invalid reviewed video input')

    expect(writeManifest).not.toHaveBeenCalled()
    expect(harness.downloads.getDownloadInfo).not.toHaveBeenCalled()
    expect(harness.productionApi.selectCandidate).not.toHaveBeenCalled()
    expect(harness.productionApi.start).not.toHaveBeenCalled()
  })

  it('rejects unsafe caption and theme values before remote or durable side effects', async () => {
    const harness = await createPlannedHarness()
    const review = await reviewedInput(harness.plan.reviewPath)
    review.quote.captionZh = 'model prompt at https://preview.example.test/private'
    await fs.writeFile(harness.plan.reviewPath, JSON.stringify(review))
    const writeManifest = vi.fn(harness.dependencies.writeManifest)

    await expect(produceVideo({
      artifactRoot: harness.artifactRoot,
      manifestPath: harness.plan.manifestPath,
      reviewPath: harness.plan.reviewPath,
      maxDownloads: 4,
    }, { ...harness.dependencies, writeManifest })).rejects.toThrow('invalid reviewed video input')
    expect(writeManifest).not.toHaveBeenCalled()
    expect(harness.productionApi.selectCandidate).not.toHaveBeenCalled()

    const fresh = await createHarness()
    await expect(planVideo({
      artifactRoot: fresh.artifactRoot,
      theme: 'Bearer provider-secret at https://preview.example.test',
      candidateCount: 8,
    }, fresh.dependencies)).rejects.toThrow('invalid video theme')
    expect(fresh.subtitleApi.search).not.toHaveBeenCalled()
    expect(fresh.productionApi.matchScene).not.toHaveBeenCalled()
  })

  it('returns an oversized candidate to review before selection, start, or formal reservation', async () => {
    const harness = await createPlannedHarness()
    harness.downloads.getDownloadInfo.mockImplementation(async resourceId => ({
      ...downloadInfo(resourceId),
      sourceSizeBytes: resourceId === 100 ? 512 * 1024 * 1024 + 1 : 10_000,
    }))

    await expect(produceVideo({
      artifactRoot: harness.artifactRoot,
      manifestPath: harness.plan.manifestPath,
      reviewPath: harness.plan.reviewPath,
      maxDownloads: 4,
    }, harness.dependencies)).rejects.toThrow('candidate exceeds local download limit')

    expect(harness.productionApi.selectCandidate).not.toHaveBeenCalled()
    expect(harness.productionApi.start).not.toHaveBeenCalled()
    expect(harness.downloads.requestDownload).not.toHaveBeenCalled()
    expect((await readManifest(harness.plan.manifestPath)).stage).toBe('review')
  })

  it('fails metadata after transfer failure, preserves completed source state, and never renders', async () => {
    const harness = await createPlannedHarness()
    harness.downloads.transferSignedUrl.mockImplementation(async (ready, destination) => {
      if (ready.resourceId === 200) throw new Error('signed URL with secret payload')
      return transfer(destination)
    })

    await expect(produceVideo({
      artifactRoot: harness.artifactRoot,
      manifestPath: harness.plan.manifestPath,
      reviewPath: harness.plan.reviewPath,
      maxDownloads: 4,
    }, harness.dependencies)).rejects.toThrow('video production failed')

    expect(harness.productionApi.fail).toHaveBeenCalledWith({
      renderId,
      failureCode: 'download_failure',
      failureMessage: 'video source download failed',
    })
    expect(harness.productionApi.beginRender).not.toHaveBeenCalled()
    expect(harness.renderVideo).not.toHaveBeenCalled()
    expect(harness.productionApi.complete).not.toHaveBeenCalled()
    const active = await latestPlan(harness.artifactRoot)
    const manifest = await readManifest(active.manifestPath)
    expect(manifest.stage).toBe('failed')
    expect(manifest.sources).toHaveLength(1)
  })

  it('durably checkpoints formal reservations and never spends again after transfer failure and restart', async () => {
    const harness = await createPlannedHarness()
    harness.downloads.transferSignedUrl.mockImplementation(async (ready, destination) => {
      if (ready.resourceId === 200) throw new Error('terminal synthetic transfer failure')
      return transfer(destination)
    })

    await expect(produceVideo({
      artifactRoot: harness.artifactRoot,
      manifestPath: harness.plan.manifestPath,
      reviewPath: harness.plan.reviewPath,
      maxDownloads: 4,
    }, harness.dependencies)).rejects.toThrow('video production failed')
    const active = await latestPlan(harness.artifactRoot)
    const callsBeforeRestart = harness.downloads.requestDownload.mock.calls.length
    const state = JSON.parse(await fs.readFile(join(dirname(active.manifestPath), 'production-state.json'), 'utf8'))
    expect(state.formalReservations).toEqual([
      { index: 0, selectionId: 1_100, providerResourceId: 100 },
      { index: 1, selectionId: 1_200, providerResourceId: 200 },
    ])
    expect(JSON.stringify(state)).not.toMatch(/signed|statusUrl|previewUrl|https?:\/\//i)
    harness.downloads.transferSignedUrl.mockImplementation(async (_ready, destination) => transfer(destination))

    await expect(resumeVideo({
      artifactRoot: harness.artifactRoot,
      manifestPath: active.manifestPath,
    }, harness.dependencies)).rejects.toThrow('formal download reservation already spent')

    expect(harness.downloads.requestDownload).toHaveBeenCalledTimes(callsBeforeRestart)
    expect(harness.productionApi.beginRender).not.toHaveBeenCalled()
  })

  it('resumes a render failure from retained downloads without another formal call or metadata record', async () => {
    const harness = await createPlannedHarness()
    harness.renderVideo.mockRejectedValueOnce(new Error('prompt and URL must stay private'))

    await expect(produceVideo({
      artifactRoot: harness.artifactRoot,
      manifestPath: harness.plan.manifestPath,
      reviewPath: harness.plan.reviewPath,
      maxDownloads: 4,
    }, harness.dependencies)).rejects.toThrow('video production failed')
    const active = await latestPlan(harness.artifactRoot)
    const formalCalls = harness.downloads.requestDownload.mock.calls.length
    const recordCalls = harness.productionApi.recordDownload.mock.calls.length

    await resumeVideo({ artifactRoot: harness.artifactRoot, manifestPath: active.manifestPath }, harness.dependencies)

    expect(harness.productionApi.retry).toHaveBeenCalledWith(renderId)
    expect(harness.downloads.requestDownload).toHaveBeenCalledTimes(formalCalls)
    expect(harness.productionApi.recordDownload).toHaveBeenCalledTimes(recordCalls)
    expect(harness.renderVideo).toHaveBeenCalledTimes(2)
    expect(harness.productionApi.complete).toHaveBeenCalledTimes(1)
    expect((await readManifest(active.manifestPath)).stage).toBe('completed')
  })

  it('reuses an existing matching source hash without provider or duplicate metadata work', async () => {
    const harness = await createPlannedHarness()
    harness.renderVideo.mockRejectedValueOnce(new Error('render failed'))
    await expect(produceVideo({
      artifactRoot: harness.artifactRoot,
      manifestPath: harness.plan.manifestPath,
      reviewPath: harness.plan.reviewPath,
      maxDownloads: 4,
    }, harness.dependencies)).rejects.toThrow('video production failed')
    const active = await latestPlan(harness.artifactRoot)
    const beforeDownloads = harness.downloads.requestDownload.mock.calls.length
    const beforeRecords = harness.productionApi.recordDownload.mock.calls.length

    await resumeVideo({ artifactRoot: harness.artifactRoot, manifestPath: active.manifestPath }, harness.dependencies)

    expect(harness.downloads.requestDownload).toHaveBeenCalledTimes(beforeDownloads)
    expect(harness.productionApi.recordDownload).toHaveBeenCalledTimes(beforeRecords)
  })

  it('keeps a completed manifest immutable and retries only completion metadata with the same hash', async () => {
    const harness = await createPlannedHarness()
    harness.productionApi.complete
      .mockRejectedValueOnce(new Error('remote completion failed with provider payload'))
      .mockResolvedValueOnce({ renderId, status: 'completed' })

    await expect(produceVideo({
      artifactRoot: harness.artifactRoot,
      manifestPath: harness.plan.manifestPath,
      reviewPath: harness.plan.reviewPath,
      maxDownloads: 4,
    }, harness.dependencies)).rejects.toThrow('video metadata completion failed')
    const active = await latestPlan(harness.artifactRoot)
    const manifestBytes = await fs.readFile(active.manifestPath)
    const expectedHash = createHash('sha256').update(manifestBytes).digest('hex')
    expect((await readManifest(active.manifestPath)).stage).toBe('completed')
    expect(harness.productionApi.fail).not.toHaveBeenCalled()
    const boundaryCounts = counts(harness)

    await resumeVideo({ artifactRoot: harness.artifactRoot, manifestPath: active.manifestPath }, harness.dependencies)

    expect(counts(harness)).toEqual({ ...boundaryCounts, complete: boundaryCounts.complete + 1 })
    expect(harness.productionApi.complete.mock.calls[0][0].output.manifestSha256).toBe(expectedHash)
    expect(harness.productionApi.complete.mock.calls[1][0].output.manifestSha256).toBe(expectedHash)
    expect(await fs.readFile(active.manifestPath)).toEqual(manifestBytes)
  })

  it('refuses to attach an identical digest owned by another plan and preserves both directories', async () => {
    const harness = await createPlannedHarness()
    const first = await produceVideo({
      artifactRoot: harness.artifactRoot,
      manifestPath: harness.plan.manifestPath,
      reviewPath: harness.plan.reviewPath,
      maxDownloads: 4,
    }, harness.dependencies)
    const secondPlan = await planOnHarness(harness)
    harness.productionApi.start.mockResolvedValueOnce({
      renderId,
      status: 'completed',
      isExisting: true,
    })

    await expect(produceVideo({
      artifactRoot: harness.artifactRoot,
      manifestPath: secondPlan.manifestPath,
      reviewPath: secondPlan.reviewPath,
      maxDownloads: 4,
    }, harness.dependencies)).rejects.toThrow('existing render does not match reviewed plan')

    expect(secondPlan.planId).not.toBe(harness.plan.planId)
    await expect(fs.access(secondPlan.manifestPath)).resolves.toBeUndefined()
    expect((await readManifest(first.manifestPath)).planId).toBe(harness.plan.planId)
    expect(harness.downloads.requestDownload).toHaveBeenCalledTimes(4)
  })

  it.each([
    ['after start before checkpoint', 'after-start', 'produce', 2],
    ['before directory rename', 'before-rename', 'resume', 1],
    ['after rename before render-owned manifest write', 'before-manifest', 'produce', 1],
    ['after manifest write before latest-plan update', 'before-latest', 'resume', 1],
  ] as const)('recovers deterministically %s', async (_label, window, recoveryCommand, expectedStartCalls) => {
    const harness = await createPlannedHarness()
    const interrupted = interruptTransition(window, harness, harness.plan)

    await expect(produceVideo({
      artifactRoot: harness.artifactRoot,
      manifestPath: harness.plan.manifestPath,
      reviewPath: harness.plan.reviewPath,
      maxDownloads: 4,
    }, interrupted)).rejects.toThrow('synthetic transition interruption')
    harness.productionApi.start.mockResolvedValue({
      renderId,
      status: 'downloading',
      isExisting: true,
    })

    const recovered = recoveryCommand === 'produce'
      ? await produceVideo({
          artifactRoot: harness.artifactRoot,
          manifestPath: harness.plan.manifestPath,
          reviewPath: harness.plan.reviewPath,
          maxDownloads: 4,
        }, harness.dependencies)
      : await resumeVideo({
          artifactRoot: harness.artifactRoot,
          manifestPath: harness.plan.manifestPath,
        }, harness.dependencies)

    expect(recovered).toMatchObject({ renderId, stage: 'completed' })
    expect(harness.productionApi.start).toHaveBeenCalledTimes(expectedStartCalls)
    expect((await latestPlan(harness.artifactRoot)).manifestPath).toBe(recovered.manifestPath)
    expect((await readManifest(recovered.manifestPath)).planId).toBe(harness.plan.planId)
  })

  it('redacts dialogue, model/provider data, secrets, and URLs from operator output', async () => {
    const harness = await createPlannedHarness()
    await produceVideo({
      artifactRoot: harness.artifactRoot,
      manifestPath: harness.plan.manifestPath,
      reviewPath: harness.plan.reviewPath,
      maxDownloads: 4,
    }, harness.dependencies)

    const output = harness.output.join('\n')
    expect(output).toContain(renderId)
    expect(output).toMatch(/4 (?:scenes|sources|downloads)/)
    expect(output).toContain('final.mp4')
    expect(output).not.toContain('Hope remains with us through the longest night')
    expect(output).not.toContain('provider-secret')
    expect(output).not.toContain('preview.example.test')
    expect(output).not.toContain('signed.example.test')
    expect(output).not.toContain('raw provider payload')
    expect(output).not.toContain('model prompt')
    expect(output).not.toMatch(/https?:\/\//)
  })

  it('retains a stable HTTPS attribution URL in local and remote attribution metadata', async () => {
    const harness = await createPlannedHarness()
    const attributionUrl = 'https://attribution.example.test/licenses/free-video'
    harness.downloads.getDownloadInfo.mockImplementation(async (resourceId: number) => ({
      ...downloadInfo(resourceId),
      requiresAttribution: true,
      requiredAttributionUrl: attributionUrl,
    }))
    harness.downloads.transferSignedUrl.mockImplementation(async (
      _ready: { requestId: number; resourceId: number },
      destination: string,
    ) => ({
      ...await transfer(destination),
      requiresAttribution: true,
      requiredAttributionUrl: attributionUrl,
    }))

    const result = await produceVideo({
      artifactRoot: harness.artifactRoot,
      manifestPath: harness.plan.manifestPath,
      reviewPath: harness.plan.reviewPath,
      maxDownloads: 4,
    }, harness.dependencies)

    expect(harness.productionApi.recordDownload).toHaveBeenCalledTimes(4)
    expect(harness.productionApi.recordDownload.mock.calls.every(
      ([input]) => input.requiredAttributionUrl === attributionUrl,
    )).toBe(true)
    expect((await readManifest(result.manifestPath)).sources?.every(
      source => source.requiredAttributionUrl === attributionUrl,
    )).toBe(true)
  })
})

it('accepts npm 11 forwarded plan options and keeps JSON stdout path-only', async () => {
  const stdout: string[] = []
  const stderr: string[] = []
  const plan = vi.fn(async () => ({
    planId: '11111111-1111-4111-8111-111111111111',
    manifestPath: 'artifacts/video-runs/11111111-1111-4111-8111-111111111111/manifest.json',
    reviewPath: 'artifacts/video-runs/11111111-1111-4111-8111-111111111111/review-input.json',
  }))
  const program = createVideoProgram({
    SUPABASE_URL: 'https://project.example.test',
    SUPABASE_PUBLISHABLE_KEY: 'publishable',
    SUBTITLE_PERSONAL_TOKEN: 'personal',
    npm_config_theme: 'true',
    npm_config_candidate_count: 'true',
    npm_config_json: 'true',
  }, {
    stdout: message => { stdout.push(message) },
    stderr: message => { stderr.push(message) },
  }, {
    dependencies: () => ({} as VideoPipelineDependencies),
    planVideo: plan,
  })

  await program.parseAsync(['node', 'video', 'plan', 'Crossing darkness toward dawn', '8'])

  expect(plan).toHaveBeenCalledWith(expect.objectContaining({
    theme: 'Crossing darkness toward dawn',
    candidateCount: 8,
    writeLatestPlan: true,
  }), expect.any(Object))
  expect(stdout).toEqual([JSON.stringify(await plan.mock.results[0].value)])
  expect(stderr).toEqual([])
})

it('accepts exact npm-forwarded produce and resume arguments', async () => {
  const dependencies = vi.fn(() => ({} as VideoPipelineDependencies))
  const produce = vi.fn(async () => ({
    planId: runIds[0],
    renderId,
    manifestPath: 'manifest.json',
    reviewPath: 'review-input.json',
    stage: 'completed' as const,
  }))
  const resume = vi.fn(produce)
  const baseEnvironment = {
    SUPABASE_URL: 'https://project.example.test',
    SUPABASE_PUBLISHABLE_KEY: 'publishable',
    SUBTITLE_PERSONAL_TOKEN: 'personal',
    VECTEEZY_ACCOUNT: 'account',
    VECTEEZY_API_KEY: 'key',
  }
  const produceProgram = createVideoProgram({
    ...baseEnvironment,
    npm_config_manifest: 'true',
    npm_config_review: 'true',
    npm_config_max_downloads: 'true',
  }, undefined, { dependencies, produceVideo: produce })
  await produceProgram.parseAsync(['node', 'video', 'produce', 'plan.json', 'review.json', '4'])
  expect(produce).toHaveBeenCalledWith(expect.objectContaining({
    manifestPath: 'plan.json',
    reviewPath: 'review.json',
    maxDownloads: 4,
  }), expect.any(Object))

  const resumeProgram = createVideoProgram({
    ...baseEnvironment,
    npm_config_manifest: 'true',
  }, undefined, { dependencies, resumeVideo: resume })
  await resumeProgram.parseAsync(['node', 'video', 'resume', 'active.json'])
  expect(resume).toHaveBeenCalledWith(expect.objectContaining({ manifestPath: 'active.json' }), expect.any(Object))
})

it.each([
  ['plan partial forwarding', ['plan', 'Crossing darkness toward dawn'], { npm_config_theme: 'true', npm_config_candidate_count: 'true' }],
  ['plan boolean placeholder', ['plan'], { npm_config_theme: 'true', npm_config_candidate_count: 'true' }],
  ['plan excess positional', ['plan', 'Crossing darkness toward dawn', '8', 'extra'], { npm_config_theme: 'true', npm_config_candidate_count: 'true' }],
  ['produce partial forwarding', ['produce', 'manifest.json', 'review.json'], { npm_config_manifest: 'true', npm_config_review: 'true', npm_config_max_downloads: 'true' }],
  ['produce excess positional', ['produce', 'manifest.json', 'review.json', '4', 'extra'], { npm_config_manifest: 'true', npm_config_review: 'true', npm_config_max_downloads: 'true' }],
  ['resume boolean placeholder', ['resume'], { npm_config_manifest: 'true' }],
  ['resume excess positional', ['resume', 'manifest.json', 'extra'], { npm_config_manifest: 'true' }],
] as const)('rejects %s before constructing live dependencies', async (_label, args, forwarded) => {
  const dependencies = vi.fn(() => ({} as VideoPipelineDependencies))
  const plan = vi.fn()
  const produce = vi.fn()
  const resume = vi.fn()
  const program = createVideoProgram({
    SUPABASE_URL: 'https://project.example.test',
    SUPABASE_PUBLISHABLE_KEY: 'publishable',
    SUBTITLE_PERSONAL_TOKEN: 'personal',
    VECTEEZY_ACCOUNT: 'account',
    VECTEEZY_API_KEY: 'key',
    ...forwarded,
  }, undefined, {
    dependencies,
    planVideo: plan,
    produceVideo: produce,
    resumeVideo: resume,
  })

  await expect(program.parseAsync(['node', 'video', ...args])).rejects.toThrow('invalid command arguments')
  expect(dependencies).not.toHaveBeenCalled()
  expect(plan).not.toHaveBeenCalled()
  expect(produce).not.toHaveBeenCalled()
  expect(resume).not.toHaveBeenCalled()
})

async function createPlannedHarness() {
  const harness = await createHarness()
  const plan = await planOnHarness(harness)
  return { ...harness, plan }
}

async function planOnHarness(harness: Awaited<ReturnType<typeof createHarness>>) {
  const plan = await planVideo({
    artifactRoot: harness.artifactRoot,
    theme: 'Crossing darkness toward dawn',
    candidateCount: 8,
  }, harness.dependencies)
  const review = await reviewedInput(plan.reviewPath)
  await fs.writeFile(plan.reviewPath, `${JSON.stringify(review, null, 2)}\n`)
  return plan
}

async function createHarness() {
  await fs.mkdir(resolve('artifacts'), { recursive: true })
  const artifactRoot = await fs.mkdtemp(resolve('artifacts', 'pipeline-test-'))
  artifactRoots.push(artifactRoot)
  const output: string[] = []
  const subtitleApi = {
    search: vi.fn(async () => [searchResult()]),
  }
  let matchIndex = 0
  const productionApi = {
    matchScene: vi.fn(async (_input: Parameters<VideoPipelineDependencies['productionApi']['matchScene']>[0]) => matchResponse(matchIndex++ % 4)),
    selectCandidate: vi.fn(async ({ providerResourceId }: Parameters<VideoPipelineDependencies['productionApi']['selectCandidate']>[0]) => ({ selectionId: providerResourceId + 1_000 })),
    start: vi.fn(async (_input: Parameters<VideoPipelineDependencies['productionApi']['start']>[0]) => ({
      renderId,
      status: 'planned' as 'planned' | 'downloading' | 'rendering' | 'failed' | 'completed',
      isExisting: false,
    })),
    recordDownload: vi.fn(async ({ renderId: id, selectionId }: Parameters<VideoPipelineDependencies['productionApi']['recordDownload']>[0]) => ({ renderId: id, downloadId: selectionId + 2_000 })),
    beginRender: vi.fn(async (_id: string) => ({ renderId, status: 'rendering' as const })),
    complete: vi.fn(async (_input: Parameters<VideoPipelineDependencies['productionApi']['complete']>[0]) => ({ renderId, status: 'completed' as const })),
    fail: vi.fn(async (_input: Parameters<VideoPipelineDependencies['productionApi']['fail']>[0]) => ({ renderId, status: 'failed' as const })),
    retry: vi.fn(async (_id: string) => ({ renderId, status: 'downloading' as const })),
  }
  const downloads = {
    getDownloadInfo: vi.fn(async (resourceId: number) => downloadInfo(resourceId)),
    requestDownload: vi.fn(async (resourceId: number, _budget: FormalDownloadBudget) => downloadRequest(resourceId)),
    waitForDownload: vi.fn(async (request: FormalDownloadRequest) => ({ requestId: request.requestId, resourceId: request.resourceId })),
    transferSignedUrl: vi.fn(async (_ready: { requestId: number; resourceId: number }, destination: string) => transfer(destination)),
  }
  const probeMedia = vi.fn(async (path: string) => path.endsWith('final.mp4') ? finalProbe : sourceProbe)
  const renderVideo = vi.fn(async input => {
    await fs.mkdir(dirname(input.finalPath), { recursive: true })
    await fs.writeFile(input.finalPath, 'rendered final bytes')
    await fs.writeFile(input.contactSheetPath, 'contact sheet')
    return {
      sourceProbes: [sourceProbe, sourceProbe, sourceProbe, sourceProbe] as const,
      normalizedPaths: input.normalizedPaths,
      subtitlesPath: input.subtitlesPath,
      finalPath: input.finalPath,
      blackFrames: [],
      contactSheetPath: input.contactSheetPath,
      finalProbe,
    }
  })
  const dependencies: VideoPipelineDependencies = {
    subtitleApi,
    productionApi,
    downloads: downloads as unknown as VecteezyDownloadClient,
    probeMedia,
    renderVideo,
    readManifest,
    writeManifest: writeManifestAtomic,
    output: message => { output.push(message) },
    now: () => '2026-07-19T00:00:00.000Z',
  }
  return { artifactRoot, output, subtitleApi, productionApi, downloads, probeMedia, renderVideo, dependencies }
}

function searchResult(): SubtitleSearchResult {
  return {
    similarity: 0.83,
    movie: { id: 2, title: 'Synthetic Film', releaseYear: 1994 },
    trackId: 7,
    chunkIndex: 5,
    startMs: 120_000,
    endMs: 125_000,
    timestamp: '00:02:00.000 --> 00:02:05.000',
    text: 'full chunk that must never be logged with provider-secret',
    cues: [{ index: 31, startMs: 120_000, endMs: 125_000, text: '  Hope remains with us through the longest night.  ' }],
  }
}

function matchResponse(index: number) {
  return {
    runId: runIds[index],
    status: 'completed' as const,
    planner: { model: 'private-model', promptVersion: 'model prompt v1', fallbackUsed: false },
    visualIntent: {
      subject: 'landscape', action: 'changing', setting: 'outdoors', mood: 'hopeful', lighting: 'dawn', shot: 'wide',
    },
    queries: [{ kind: 'literal' as const, term: 'generic landscape', status: 'completed' as const }],
    candidates: Array.from({ length: 8 }, (_, candidateIndex) => ({
      provider: 'vecteezy' as const,
      providerResourceId: index * 100 + candidateIndex + 100,
      title: `Synthetic candidate ${candidateIndex + 1}`,
      licenseType: 'free',
      aiGenerated: false,
      orientation: 'landscape',
      fileTypes: [{ extension: 'mp4', sizeInBytes: 10_000 }],
      downloadSizes: [{ id: 'hd', width: 1920, height: 1080 }],
      score: 1 - candidateIndex / 10,
      bestRank: candidateIndex + 1,
      matchedBy: ['literal' as const],
      previewUrl: `https://preview.example.test/${index}/${candidateIndex}?provider-secret=raw`,
    })),
  }
}

async function reviewedInput(reviewPath: string): Promise<ReviewedVideoRunInput> {
  const review = JSON.parse(await fs.readFile(reviewPath, 'utf8')) as ReviewedVideoRunInput
  review.quote.captionZh = '希望仍与我们同在。'
  review.scenes.forEach((scene, index) => {
    scene.providerResourceId = index * 100 + 100
    scene.note = 'selected after local review'
    scene.sourceInMs = index * 250
  })
  return review
}

function downloadInfo(resourceId: number): VecteezyDownloadInfo {
  return {
    resourceId,
    sourceSizeBytes: 10_000,
    requiresAttribution: false,
    requiredAttributionUrl: null,
    quota: { limit: 100, remaining: 96 },
  }
}

function downloadRequest(resourceId: number) {
  return { ...downloadInfo(resourceId), requestId: resourceId + 5_000 }
}

async function transfer(destination: string): Promise<CompletedVecteezyDownload> {
  const absolute = resolve(destination)
  await fs.mkdir(dirname(absolute), { recursive: true })
  const bytes = Buffer.from(`source bytes for ${destination}`)
  await fs.writeFile(absolute, bytes)
  return {
    artifactKey: destination,
    sourceSizeBytes: bytes.byteLength,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    requiresAttribution: false,
    requiredAttributionUrl: null,
    quota: { limit: 100, remaining: 96 },
  }
}

async function latestPlan(artifactRoot: string): Promise<{ planId: string; manifestPath: string; reviewPath: string }> {
  return JSON.parse(await fs.readFile(join(artifactRoot, 'latest-plan.json'), 'utf8'))
}

function counts(harness: Awaited<ReturnType<typeof createHarness>>) {
  return {
    select: harness.productionApi.selectCandidate.mock.calls.length,
    start: harness.productionApi.start.mock.calls.length,
    info: harness.downloads.getDownloadInfo.mock.calls.length,
    request: harness.downloads.requestDownload.mock.calls.length,
    transfer: harness.downloads.transferSignedUrl.mock.calls.length,
    record: harness.productionApi.recordDownload.mock.calls.length,
    begin: harness.productionApi.beginRender.mock.calls.length,
    render: harness.renderVideo.mock.calls.length,
    probe: harness.probeMedia.mock.calls.length,
    retry: harness.productionApi.retry.mock.calls.length,
    fail: harness.productionApi.fail.mock.calls.length,
    complete: harness.productionApi.complete.mock.calls.length,
  }
}

function interruptTransition(
  window: 'after-start' | 'before-rename' | 'before-manifest' | 'before-latest',
  harness: Awaited<ReturnType<typeof createHarness>>,
  plan: Awaited<ReturnType<typeof planOnHarness>>,
): VideoPipelineDependencies {
  let interrupted = false
  const fileOperations = {
    access: fs.access,
    mkdir: fs.mkdir,
    readFile: fs.readFile,
    rm: fs.rm,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      const [path, data, options] = args
      if (!interrupted
        && window === 'after-start'
        && String(path).includes('video-transitions')
        && String(data).includes('"phase": "started"')) {
        interrupted = true
        throw new Error('synthetic transition interruption')
      }
      await fs.writeFile(path, data, options)
    },
    rename: async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
      const source = String(from)
      const destination = String(to)
      if (!interrupted
        && window === 'before-rename'
        && source === dirname(plan.manifestPath)
        && destination.includes(renderId)) {
        interrupted = true
        throw new Error('synthetic transition interruption')
      }
      if (!interrupted
        && window === 'before-latest'
        && destination.endsWith('latest-plan.json')) {
        interrupted = true
        throw new Error('synthetic transition interruption')
      }
      await fs.rename(from, to)
    },
  }
  const writeManifest = vi.fn(async (...args: Parameters<typeof writeManifestAtomic>) => {
    if (!interrupted && window === 'before-manifest' && String(args[0]).includes(renderId)) {
      interrupted = true
      throw new Error('synthetic transition interruption')
    }
    await writeManifestAtomic(...args)
  })
  return {
    ...harness.dependencies,
    writeManifest,
    fileOperations,
  } as VideoPipelineDependencies
}
