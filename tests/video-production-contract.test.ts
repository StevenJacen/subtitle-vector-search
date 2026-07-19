import { describe, expect, it } from 'vitest'
import {
  parseVideoProductionRequest,
  VideoProductionError,
  type VideoProductionRequest,
} from '../supabase/functions/_shared/video-production.js'

const renderId = 'd62a53a1-08fb-4bee-a1ed-d8ba13de85f2'
const sha256 = 'a'.repeat(64)
const artifactKey = `video-runs/${renderId}/sources/opening.mp4`

function request(action: 'start'): Extract<VideoProductionRequest, { action: 'start' }>
function request(action: 'recordDownload'): Extract<VideoProductionRequest, { action: 'recordDownload' }>
function request(action: 'beginRender'): Extract<VideoProductionRequest, { action: 'beginRender' }>
function request(action: 'complete'): Extract<VideoProductionRequest, { action: 'complete' }>
function request(action: 'fail'): Extract<VideoProductionRequest, { action: 'fail' }>
function request(action: 'retry'): Extract<VideoProductionRequest, { action: 'retry' }>
function request(action: VideoProductionRequest['action']): VideoProductionRequest
function request(action: VideoProductionRequest['action']): VideoProductionRequest {
  const metadata = {
    artifactKey,
    fileType: 'mp4' as const,
    sourceSizeBytes: 1_024,
    sourceSha256: sha256,
    width: 1920,
    height: 1080,
    durationMs: 10_000,
    frameRate: 30,
    videoCodec: 'h264',
    audioCodec: 'aac',
    requiresAttribution: true,
    requiredAttributionUrl: 'https://example.test/license',
    quotaLimit: 100,
    quotaRemaining: 99,
  }
  const segments = [0, 1, 2, 3].map(segmentIndex => ({
    segmentIndex: segmentIndex as 0 | 1 | 2 | 3,
    downloadId: segmentIndex + 1,
    timelineStartMs: segmentIndex * 5_000,
    timelineEndMs: (segmentIndex + 1) * 5_000,
    sourceInMs: 0,
    sourceOutMs: 5_000,
    captionKind: segmentIndex === 1 ? 'quote' as const : 'original' as const,
    captionEn: segmentIndex === 1 ? 'source quote' : 'original caption',
    captionZh: '字幕',
    sourceTrackId: segmentIndex === 1 ? 7 : null,
    sourceCueIndex: segmentIndex === 1 ? 12 : null,
  }))

  switch (action) {
    case 'start':
      return { action, requestDigest: sha256, theme: 'Classic cinema' }
    case 'recordDownload':
      return { action, renderId, selectionId: 12, ...metadata }
    case 'beginRender':
      return { action, renderId }
    case 'complete':
      return {
        action,
        renderId,
        segments,
        output: {
          artifactKey: `video-runs/${renderId}/output/final.mp4`,
          outputSha256: sha256,
          outputSizeBytes: 2_048,
          outputDurationMs: 20_000,
          videoCodec: 'h264',
          audioCodec: 'aac',
          pixelFormat: 'yuv420p',
          ffmpegVersion: '7.1',
          manifestSha256: sha256,
        },
      }
    case 'fail':
      return { action, renderId, failureCode: 'render_failure', failureMessage: 'video render failed' }
    case 'retry':
      return { action, renderId }
  }
}

function invalid(value: unknown): void {
  expect(() => parseVideoProductionRequest(value)).toThrow(
    new VideoProductionError(400, 'invalid_request', 'invalid request'),
  )
}

describe('video production request contract', () => {
  it.each(['start', 'recordDownload', 'beginRender', 'complete', 'fail', 'retry'] as const)(
    'parses the valid %s action',
    action => expect(parseVideoProductionRequest(request(action))).toEqual(request(action)),
  )

  it('rejects unknown action and nested keys', () => {
    invalid({ ...request('start'), unexpected: true })
    invalid({ ...request('complete'), output: { ...request('complete').output, unexpected: true } })
    invalid({ ...request('complete'), segments: [{ ...request('complete').segments[0], unexpected: true }] })
  })

  it.each([
    ['a URL-shaped artifact key', { ...request('recordDownload'), artifactKey: 'https://provider.test/a.mp4' }],
    ['an absolute artifact path', { ...request('recordDownload'), artifactKey: '/tmp/a.mp4' }],
    ['an artifact outside its render prefix', { ...request('recordDownload'), artifactKey: 'video-runs/other/file.mp4' }],
    ['a signed URL key at any depth', { ...request('complete'), output: { ...request('complete').output, signedUrl: 'https://x.test' } }],
    ['a status URL key at any depth', { ...request('complete'), output: { ...request('complete').output, nested: { statusUrl: 'https://x.test' } } }],
    ['a download URL key at any depth', { ...request('complete'), output: { ...request('complete').output, nested: { downloadUrl: 'https://x.test' } } }],
    ['a provider resource field', { ...request('recordDownload'), providerResourceId: 10 }],
    ['a malformed render UUID', { ...request('beginRender'), renderId: 'not-a-uuid' }],
    ['a malformed SHA-256', { ...request('start'), requestDigest: 'ABC' }],
    ['a nonpositive media value', { ...request('recordDownload'), width: 0 }],
    ['a non-finite frame rate', { ...request('recordDownload'), frameRate: Infinity }],
    ['an unsafe frame rate', { ...request('recordDownload'), frameRate: Number.MAX_SAFE_INTEGER + 1 }],
    ['a non-https attribution URL', { ...request('recordDownload'), requiredAttributionUrl: 'http://example.test/license' }],
    ['a signed attribution query', { ...request('recordDownload'), requiredAttributionUrl: 'https://example.test/license?X-Amz-Signature=private' }],
    ['an encoded signed attribution path', { ...request('recordDownload'), requiredAttributionUrl: 'https://example.test/%73igned/license' }],
    ['an attribution URL with user information', { ...request('recordDownload'), requiredAttributionUrl: 'https://user:secret@example.test/license' }],
    ['an attribution URL fragment', { ...request('recordDownload'), requiredAttributionUrl: 'https://example.test/license#private' }],
    ['unpaired quota metadata', { ...request('recordDownload'), quotaLimit: 5, quotaRemaining: null }],
    ['failure text longer than 500 characters', { ...request('fail'), failureMessage: 'x'.repeat(501) }],
  ])('rejects %s', (_label, value) => invalid(value))

  it.each([
    ['a post-render suffix that starts with a slash', `video-runs/${renderId}//tmp/file.mp4`],
    ['a post-render suffix with an empty segment', `video-runs/${renderId}/tmp//file.mp4`],
    ['a post-render suffix with a dot segment', `video-runs/${renderId}/tmp/./file.mp4`],
  ])('rejects %s for download and output artifacts', (_label, invalidArtifactKey) => {
    invalid({ ...request('recordDownload'), artifactKey: invalidArtifactKey })
    invalid({ ...request('complete'), output: { ...request('complete').output, artifactKey: invalidArtifactKey } })
  })

  it('requires exactly four ordered segments and valid quote sources', () => {
    const complete = request('complete')
    invalid({ ...complete, segments: complete.segments.slice(0, 3) })
    invalid({ ...complete, segments: [...complete.segments, complete.segments[3]] })
    invalid({ ...complete, segments: complete.segments.map((segment, index) => ({ ...segment, segmentIndex: index === 3 ? 2 : segment.segmentIndex })) })
    invalid({ ...complete, segments: complete.segments.map(segment => segment.captionKind === 'quote'
      ? { ...segment, sourceTrackId: null }
      : segment) })
    invalid({ ...complete, segments: complete.segments.map(segment => segment.captionKind === 'original'
      ? { ...segment, sourceTrackId: 7, sourceCueIndex: 12 }
      : segment) })
  })

  it('rejects complete requests with zero quote segments', () => {
    const complete = request('complete')
    invalid({
      ...complete,
      segments: complete.segments.map(segment => ({
        ...segment,
        captionKind: 'original' as const,
        sourceTrackId: null,
        sourceCueIndex: null,
      })),
    })
  })

  it('rejects complete requests with multiple quote segments', () => {
    const complete = request('complete')
    invalid({
      ...complete,
      segments: complete.segments.map((segment, index) => index < 2
        ? { ...segment, captionKind: 'quote' as const, sourceTrackId: 7, sourceCueIndex: 12 }
        : segment),
    })
  })
})
