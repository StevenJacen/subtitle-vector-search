import { describe, expect, it } from 'vitest'
import {
  parseVideoProductionV2Request,
  type VideoProductionV2Request,
} from '../supabase/functions/_shared/video-production-v2.js'
import { VideoProductionError } from '../supabase/functions/_shared/video-production.js'

const renderId = 'd62a53a1-08fb-4bee-a1ed-d8ba13de85f2'
const taskId = '8a291fbb-a9e1-42c2-a8d9-fc0817508b7f'
const reservationId = '4f6bfa4b-5d5a-41f5-9084-c9889bba03fd'
const sha256 = 'a'.repeat(64)

function segment(index: number) {
  return {
    segmentIndex: index,
    downloadId: index + 1,
    timelineStartMs: index * 3_000,
    timelineEndMs: (index + 1) * 3_000,
    sourceInMs: 0,
    sourceOutMs: 3_000,
    captionEn: `Exact cue ${index}`,
    captionZh: `字幕 ${index}`,
    sourceTrackId: 7,
    sourceCueIndex: 20 + index,
  }
}

function valid(action: 'startV2'): Extract<VideoProductionV2Request, { action: 'startV2' }>
function valid(action: 'recordDownloadV2'): Extract<VideoProductionV2Request, { action: 'recordDownloadV2' }>
function valid(action: 'beginRenderV2'): Extract<VideoProductionV2Request, { action: 'beginRenderV2' }>
function valid(action: 'completeV2'): Extract<VideoProductionV2Request, { action: 'completeV2' }>
function valid(action: 'failV2'): Extract<VideoProductionV2Request, { action: 'failV2' }>
function valid(action: 'retryV2'): Extract<VideoProductionV2Request, { action: 'retryV2' }>
function valid(action: VideoProductionV2Request['action']): VideoProductionV2Request
function valid(action: VideoProductionV2Request['action']): VideoProductionV2Request {
  const download = {
    artifactKey: `video-runs/${taskId}/sources/0.mp4`,
    fileType: 'mp4' as const,
    sourceSizeBytes: 1_024,
    sourceSha256: sha256,
    width: 1920,
    height: 1080,
    durationMs: 3_000,
    frameRate: 30,
    videoCodec: 'h264',
    audioCodec: null,
    requiresAttribution: false,
    requiredAttributionUrl: null,
    quotaLimit: 100,
    quotaRemaining: 95,
  }
  switch (action) {
    case 'startV2': return { action, requestDigest: sha256, theme: 'hope', aspectRatio: '16:9', width: 1920, height: 1080, sceneCount: 5, sourceTrackId: 7, sourceStartCueIndex: 20, sourceEndCueIndex: 24, expectedDurationMs: 15_000 }
    case 'recordDownloadV2': return { action, renderId, selectionId: 9, reservationId, ...download }
    case 'beginRenderV2': return { action, renderId }
    case 'completeV2': return {
      action,
      renderId,
      segments: Array.from({ length: 5 }, (_, index) => segment(index)),
      output: {
        artifactKey: `video-runs/${taskId}/final.mp4`, outputSha256: sha256,
        outputSizeBytes: 4_096, outputDurationMs: 15_000, width: 1920, height: 1080,
        videoCodec: 'h264', audioCodec: null, pixelFormat: 'yuv420p', ffmpegVersion: '7.1', manifestSha256: sha256,
      },
    }
    case 'failV2': return { action, renderId, failureCode: 'render_failure', failureMessage: 'local diagnostics are not persisted' }
    case 'retryV2': return { action, renderId }
  }
}

function invalid(value: unknown): void {
  expect(() => parseVideoProductionV2Request(value)).toThrow(
    new VideoProductionError(400, 'invalid_request', 'invalid request'),
  )
}

describe('video production v2 request contract', () => {
  it.each(['startV2', 'recordDownloadV2', 'beginRenderV2', 'completeV2', 'failV2', 'retryV2'] as const)(
    'parses the strict %s action',
    action => expect(parseVideoProductionV2Request(valid(action))).toEqual(valid(action)),
  )

  it.each([
    ['four scenes', { ...valid('startV2'), sceneCount: 4, sourceEndCueIndex: 23 }],
    ['eleven scenes', { ...valid('startV2'), sceneCount: 11, sourceEndCueIndex: 30 }],
    ['nonconsecutive range', { ...valid('startV2'), sourceEndCueIndex: 25 }],
    ['short duration', { ...valid('startV2'), expectedDurationMs: 14_999 }],
    ['long duration', { ...valid('startV2'), expectedDurationMs: 60_001 }],
    ['mismatched landscape dimensions', { ...valid('startV2'), width: 1080 }],
    ['mismatched portrait dimensions', { ...valid('startV2'), aspectRatio: '9:16', width: 1920, height: 1080 }],
    ['non-UUID reservation', { ...valid('recordDownloadV2'), reservationId: 'reservation' }],
    ['audio output', { ...valid('completeV2'), output: { ...valid('completeV2').output, audioCodec: 'aac' } }],
    ['wrong video codec', { ...valid('completeV2'), output: { ...valid('completeV2').output, videoCodec: 'hevc' } }],
    ['wrong pixel format', { ...valid('completeV2'), output: { ...valid('completeV2').output, pixelFormat: 'yuv444p' } }],
  ])('rejects %s', (_label, value) => invalid(value))

  it('accepts five through ten ordered all-cue segments', () => {
    for (const sceneCount of [5, 10]) {
      const complete = valid('completeV2')
      const segments = Array.from({ length: sceneCount }, (_, index) => segment(index))
      expect(parseVideoProductionV2Request({ ...complete, segments })).toMatchObject({ segments })
    }
  })

  it('rejects gaps, reordered indices, nullable cue provenance, and extra keys', () => {
    const complete = valid('completeV2')
    invalid({ ...complete, segments: complete.segments.map((item, index) => index === 2 ? { ...item, segmentIndex: 3 } : item) })
    invalid({ ...complete, segments: complete.segments.map((item, index) => index === 0 ? { ...item, sourceTrackId: null } : item) })
    invalid({ ...complete, segments: complete.segments.map((item, index) => index === 0 ? { ...item, sourceCueIndex: null } : item) })
    invalid({ ...complete, output: { ...complete.output, previewUrl: 'https://provider.test/private' } })
    invalid({ ...valid('recordDownloadV2'), downloadUrl: 'https://provider.test/private' })
  })

  it('requires an owned artifact key and strict nullable source audio metadata', () => {
    invalid({ ...valid('recordDownloadV2'), artifactKey: 'video-runs/not-a-uuid/sources/0.mp4' })
    invalid({ ...valid('recordDownloadV2'), audioCodec: '' })
    expect(parseVideoProductionV2Request({ ...valid('recordDownloadV2'), audioCodec: 'aac' })).toMatchObject({ audioCodec: 'aac' })
  })

  it('accepts a task artifact namespace that differs from the server render ID', () => {
    expect(taskId).not.toBe(renderId)
    expect(parseVideoProductionV2Request(valid('recordDownloadV2'))).toMatchObject({
      renderId,
      artifactKey: `video-runs/${taskId}/sources/0.mp4`,
    })
    expect(parseVideoProductionV2Request(valid('completeV2'))).toMatchObject({
      renderId,
      output: { artifactKey: `video-runs/${taskId}/final.mp4` },
    })
  })
})
