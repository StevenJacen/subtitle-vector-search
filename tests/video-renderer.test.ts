import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { StoryboardScene } from '../src/storyboard.js'
import { artifactKey, resolveArtifactPath } from '../src/video-artifacts.js'
import {
  PRODUCTION_RENDER,
  buildContactSheetArgs,
  buildFinalRenderArgs,
  buildNormalizationArgs,
  buildTransitionOffsets,
  parseBlackFrameFindings,
  renderVideo,
  type RenderConfiguration,
} from '../src/video-renderer.js'
import { probeMedia, type MediaProbe, type ProcessResult } from '../src/media-probe.js'

const sourceProbe: MediaProbe = {
  durationMs: 8_000,
  sizeBytes: 123_456,
  width: 1280,
  height: 720,
  frameRate: 25,
  videoCodec: 'h264',
  audioCodec: null,
  pixelFormat: 'yuv420p',
  audioSampleRate: null,
  audioChannels: null,
}

const scenes: StoryboardScene[] = [0, 1, 2, 3].map(index => ({
  index,
  captionKind: index === 2 ? 'quote' : 'original',
  captionEn: index === 2 ? 'Hope remains with us.' : `Line ${index + 1}`,
  captionZh: index === 2 ? '希望仍与我们同在。' : `字幕${index + 1}`,
  visualTheme: `scene ${index + 1}`,
  ...(index === 2 ? {
    sourceTimestamp: '00:02:00.000 --> 00:02:05.000',
    movieTitle: 'Movie Title',
    releaseYear: 1994,
  } : {}),
}))

describe('FFmpeg argument builders', () => {
  it('uses the exact production render contract and transition formula', () => {
    expect(PRODUCTION_RENDER).toEqual({
      width: 1920,
      height: 1080,
      fps: 30,
      sceneDurationSeconds: 7.95,
      transitionSeconds: 0.60,
      totalDurationSeconds: 30,
    })
    expect(buildTransitionOffsets(PRODUCTION_RENDER)).toEqual([7.35, 14.7, 22.05])
  })

  it('normalizes with fill scaling, center crop, square pixels, fps, time base, and no audio', () => {
    const args = buildNormalizationArgs('source.mp4', 'normalized.mp4', 2_000, sourceProbe, PRODUCTION_RENDER)
    const filter = args[args.indexOf('-vf') + 1]

    expect(args).toEqual(expect.arrayContaining(['-ss', '2', '-i', 'source.mp4', '-an', '-t', '7.95']))
    expect(filter).toContain('scale=1920:1080:force_original_aspect_ratio=increase')
    expect(filter).toContain('crop=1920:1080:(iw-ow)/2:(ih-oh)/2')
    expect(filter).toContain('setsar=1')
    expect(filter).toContain('fps=30')
    expect(filter).toContain('settb=AVTB')
    expect(filter).toContain('setpts=PTS-STARTPTS')
    expect(args).not.toContain('-stream_loop')
  })

  it('loops a source only when its probe duration is shorter than the scene duration', () => {
    const shortArgs = buildNormalizationArgs('short.mp4', 'out.mp4', 0, { ...sourceProbe, durationMs: 7_949 }, PRODUCTION_RENDER)
    const exactArgs = buildNormalizationArgs('exact.mp4', 'out.mp4', 0, { ...sourceProbe, durationMs: 7_950 }, PRODUCTION_RENDER)

    expect(shortArgs.slice(0, 2)).toEqual(['-stream_loop', '-1'])
    expect(exactArgs).not.toContain('-stream_loop')
  })

  it('builds the final xfade, ASS, pink-noise, and production encoding options', () => {
    const args = buildFinalRenderArgs(
      ['n0.mp4', 'n1.mp4', 'n2.mp4', 'n3.mp4'],
      'C:\\run\\subtitles.ass',
      'C:\\Windows\\Fonts\\msyh.ttc',
      'final.mp4',
      PRODUCTION_RENDER,
    )
    const graph = args[args.indexOf('-filter_complex') + 1]

    expect(graph).toContain('xfade=transition=fade:duration=0.6:offset=7.35')
    expect(graph).toContain('xfade=transition=fade:duration=0.6:offset=14.7')
    expect(graph).toContain('xfade=transition=fade:duration=0.6:offset=22.05')
    expect(graph).toContain('ass=')
    expect(graph).toContain('fontsdir=')
    expect(graph).toContain('C\\:/Windows/Fonts')
    expect(graph).toContain('anoisesrc=color=pink')
    expect(graph).toContain('highpass=')
    expect(graph).toContain('lowpass=')
    expect(graph).toContain('volume=')
    expect(graph.match(/afade=/g)).toHaveLength(2)
    expect(args).toEqual(expect.arrayContaining([
      '-c:v', 'libx264',
      '-crf', '18',
      '-preset', 'medium',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '48000',
      '-movflags', '+faststart',
      '-t', '30',
    ]))
  })

  it('samples the production contact sheet at 0, 7.5, 15, and 22.5 seconds', () => {
    const args = buildContactSheetArgs('final.mp4', 'contact-sheet.jpg', PRODUCTION_RENDER)
    const seeks = args.flatMap((arg, index) => arg === '-ss' ? [args[index + 1]] : [])

    expect(seeks).toEqual(['0', '7.5', '15', '22.5'])
    expect(args).toEqual(expect.arrayContaining(['-frames:v', '1', '-q:v', '2', 'contact-sheet.jpg']))
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('hstack')
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('vstack')
  })
})

describe('black frame detection', () => {
  it('parses findings and rejects an interval longer than one second', () => {
    expect(parseBlackFrameFindings('[blackdetect] black_start:0 black_end:0.75 black_duration:0.75')).toEqual([
      { startSeconds: 0, endSeconds: 0.75, durationSeconds: 0.75 },
    ])
    expect(() => parseBlackFrameFindings('[blackdetect] black_start:1 black_end:2.01 black_duration:1.01'))
      .toThrow('black interval exceeds one second')
  })
})

describe('real local FFmpeg render', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => fs.rm(path, { recursive: true, force: true })))
  })

  it('renders four clips, bilingual subtitles, AAC audio, contact sheet, and no long black frame', async ctx => {
    if (!await commandAvailable('ffmpeg') || !await commandAvailable('ffprobe')) {
      ctx.skip()
      return
    }

    const root = await fs.mkdtemp(join(tmpdir(), 'subtitle-renderer-'))
    temporaryDirectories.push(root)
    const renderId = '123e4567-e89b-42d3-a456-426614174000'
    const sourcePaths = tuple4([0, 1, 2, 3].map(index => resolveArtifactPath(
      root,
      artifactKey(renderId, `source-${index}.mp4`),
    )))
    const normalizedPaths = tuple4([0, 1, 2, 3].map(index => resolveArtifactPath(
      root,
      artifactKey(renderId, `normalized-${index}.mp4`),
    )))
    const subtitlesPath = resolveArtifactPath(root, artifactKey(renderId, 'subtitles.ass'))
    const finalPath = resolveArtifactPath(root, artifactKey(renderId, 'final.mp4'))
    const contactSheetPath = resolveArtifactPath(root, artifactKey(renderId, 'contact-sheet.jpg'))
    await fs.mkdir(dirname(sourcePaths[0]), { recursive: true })

    for (const [index, path] of sourcePaths.entries()) {
      const generated = await runProcess('ffmpeg', [
        '-y', '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=30:duration=1`,
        '-vf', `hue=h=${index * 45}`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path,
      ])
      expect(generated.exitCode, generated.stderr).toBe(0)
    }

    const render: RenderConfiguration = {
      width: 320,
      height: 180,
      fps: 30,
      sceneDurationSeconds: 1.075,
      transitionSeconds: 0.10,
      totalDurationSeconds: 4,
    }
    const result = await renderVideo({
      sourcePaths,
      sourceInPointsMs: [0, 0, 0, 0],
      scenes,
      normalizedPaths,
      subtitlesPath,
      finalPath,
      contactSheetPath,
      fontFilePath: 'C:\\Windows\\Fonts\\msyh.ttc',
      render,
    })

    const finalProbe = await probeMedia(finalPath)
    expect(finalProbe).toMatchObject({ width: 320, height: 180, videoCodec: 'h264', audioCodec: 'aac' })
    expect(finalProbe.durationMs).toBeGreaterThanOrEqual(3_900)
    expect(finalProbe.durationMs).toBeLessThanOrEqual(4_100)
    expect((await fs.stat(contactSheetPath)).size).toBeGreaterThan(0)
    expect(result.blackFrames.every(frame => frame.durationSeconds <= 1)).toBe(true)
    expect(result.finalProbe.audioCodec).toBe('aac')
  }, 120_000)
})

function tuple4<T>(values: T[]): [T, T, T, T] {
  if (values.length !== 4) throw new Error('expected four values')
  return values as [T, T, T, T]
}

async function commandAvailable(command: string): Promise<boolean> {
  try {
    return (await runProcess(command, ['-version'])).exitCode === 0
  } catch {
    return false
  }
}

function runProcess(command: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', exitCode => resolve({ exitCode: exitCode ?? -1, stdout, stderr }))
  })
}
