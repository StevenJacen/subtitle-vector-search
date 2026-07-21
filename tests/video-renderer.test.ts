import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { StoryboardScene } from '../src/storyboard.js'
import { buildDynamicAssSubtitles } from '../src/ass-subtitles.js'
import { artifactKey, resolveArtifactPath } from '../src/video-artifacts.js'
import {
  PRODUCTION_RENDER,
  buildContactSheetArgs,
  buildFinalRenderArgs,
  buildNormalizationArgs,
  buildTransitionOffsets,
  buildDynamicNormalizationArgs,
  buildSilentRenderArgs,
  parseBlackFrameFindings,
  renderSilentWorkbenchVideo,
  renderVideo,
  type RenderConfiguration,
} from '../src/video-renderer.js'
import { buildDynamicTimeline, type DynamicScene } from '../src/workbench/render-plan.js'
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

const mediaCommandsAvailable = await commandAvailable('ffmpeg') && await commandAvailable('ffprobe')

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
      '-ac', '2',
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

describe('dynamic silent FFmpeg argument builders', () => {
  const dynamicScenes: DynamicScene[] = [1_200, 4_000, 1_400, 2_000, 5_000].map((durationMs, index) => ({
    index,
    durationMs,
    captionEn: `Line ${index}`,
    captionZh: `台词 ${index}`,
    sourceInMs: index * 250,
  }))
  const config = { width: 1920 as const, height: 1080 as const, frameRate: 30 as const, transitionMs: 400 }
  const timeline = buildDynamicTimeline(dynamicScenes, config)

  it('normalizes each clip with center-safe cover crop, a nonfinal handle, and no audio', () => {
    const args = buildDynamicNormalizationArgs('source.mp4', 'normalized.mp4', timeline[0], sourceProbe, config)
    const filter = args[args.indexOf('-vf') + 1]

    expect(args).toEqual(expect.arrayContaining(['-ss', '0', '-i', 'source.mp4', '-an', '-t', '1.5']))
    expect(filter).toContain('scale=1920:1080:force_original_aspect_ratio=increase')
    expect(filter).toContain('crop=1920:1080:(iw-ow)/2:(ih-oh)/2')
    expect(filter).toContain('fps=30')
  })

  it('maps only video and builds variable xfade offsets without audio sources or filters', () => {
    const args = buildSilentRenderArgs({
      sourcePaths: timeline.map(scene => `n${scene.index}.mp4`),
      assPath: 'C:\\run\\subtitles.ass',
      finalPath: 'final.mp4',
      timeline,
      config,
    })
    const graph = args[args.indexOf('-filter_complex') + 1]
    const maps = args.flatMap((arg, index) => arg === '-map' ? [args[index + 1]] : [])

    expect(graph).toContain('duration=0.3:offset=1.2')
    expect(graph).toContain('duration=0.35:offset=5.2')
    expect(graph).toContain('duration=0.35:offset=6.6')
    expect(graph).toContain('duration=0.4:offset=8.6')
    expect(maps).toEqual(['[vout]'])
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-t', '13.6']))
    expect(args).not.toContain('-c:a')
    expect(args).not.toContain('-an')
    expect(graph).not.toMatch(/anoise|\[\d+:a\]|\[aout\]|afade|volume|highpass|lowpass/)
  })

  it('independently rejects invalid configuration, timeline, and paths', () => {
    const valid = {
      sourcePaths: timeline.map(scene => `n${scene.index}.mp4`),
      assPath: 'subtitles.ass',
      finalPath: 'final.mp4',
      timeline,
      config,
    }
    const gap = timeline.map(scene => ({ ...scene }))
    gap[2].startMs += 1
    const wrongTransition = timeline.map(scene => ({ ...scene }))
    wrongTransition[0].transitionOutMs = 299
    wrongTransition[0].sourceDurationMs = wrongTransition[0].durationMs + 299

    expect(() => buildSilentRenderArgs({ ...valid, assPath: ' ' })).toThrow('invalid silent render input')
    expect(() => buildSilentRenderArgs({ ...valid, sourcePaths: ['', ...valid.sourcePaths.slice(1)] })).toThrow('invalid silent render input')
    expect(() => buildSilentRenderArgs({ ...valid, config: { ...config, transitionMs: 401 } })).toThrow('invalid dynamic render configuration')
    expect(() => buildSilentRenderArgs({ ...valid, timeline: gap })).toThrow('invalid silent render timeline')
    expect(() => buildSilentRenderArgs({ ...valid, timeline: wrongTransition })).toThrow('invalid silent render timeline')
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
    expect(finalProbe).toMatchObject({
      width: 320,
      height: 180,
      videoCodec: 'h264',
      audioCodec: 'aac',
      audioSampleRate: 48_000,
      audioChannels: 2,
    })
    expect(finalProbe.durationMs).toBeGreaterThanOrEqual(3_900)
    expect(finalProbe.durationMs).toBeLessThanOrEqual(4_100)
    expect((await fs.stat(contactSheetPath)).size).toBeGreaterThan(0)
    expect(result.blackFrames.every(frame => frame.durationSeconds <= 1)).toBe(true)
    expect(result.finalProbe).toMatchObject({ audioCodec: 'aac', audioSampleRate: 48_000, audioChannels: 2 })
  }, 120_000)

  it.skipIf(!mediaCommandsAvailable).each([
    {
      name: 'five unequal landscape scenes',
      config: { width: 1920 as const, height: 1080 as const, frameRate: 30 as const, transitionMs: 400 },
      durations: [2_800, 2_950, 3_050, 3_150, 3_300],
    },
    {
      name: 'ten unequal portrait scenes',
      config: { width: 1080 as const, height: 1920 as const, frameRate: 30 as const, transitionMs: 400 },
      durations: [1_460, 1_470, 1_480, 1_490, 1_500, 1_510, 1_520, 1_530, 1_540, 1_550],
    },
  ])('renders $name as exact silent H.264 video with nonblack samples', async ({ config, durations }) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'subtitle-workbench-renderer-'))
    temporaryDirectories.push(root)
    const dynamicScenes: DynamicScene[] = durations.map((durationMs, index) => ({
      index,
      durationMs,
      captionEn: `Exact subtitle cue ${index + 1}`,
      captionZh: `精确字幕 ${index + 1}`,
      sourceInMs: 0,
    }))
    const timeline = buildDynamicTimeline(dynamicScenes, config)
    const sourcePaths = dynamicScenes.map(scene => join(root, `source-${scene.index}.mp4`))
    const assPath = join(root, 'subtitles.ass')
    const finalPath = join(root, 'final.mp4')
    const colors = ['white', 'yellow', 'cyan', 'lime', 'magenta']

    await Promise.all(sourcePaths.map(async (path, index) => {
      const generated = await runProcess('ffmpeg', [
        '-y', '-f', 'lavfi', '-i', `color=c=${colors[index % colors.length]}:size=320x180:rate=30:duration=1`,
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path,
      ])
      expect(generated.exitCode, generated.stderr).toBe(0)
    }))
    await fs.writeFile(assPath, buildDynamicAssSubtitles(dynamicScenes, timeline, config, {
      movieTitle: 'Classic Film',
      releaseYear: 1994,
      cueTimestamps: durations.map((durationMs, index) => {
        const startMs = 120_000 + index * 10_000
        return `${subtitleTimestamp(startMs)} --> ${subtitleTimestamp(startMs + durationMs)}`
      }),
    }), 'utf8')

    const result = await renderSilentWorkbenchVideo({ sourcePaths, assPath, finalPath, timeline, config })
    const expectedDurationMs = durations.reduce((sum, value) => sum + value, 0)

    expect(result.finalProbe).toMatchObject({
      width: config.width,
      height: config.height,
      frameRate: 30,
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      audioCodec: null,
      audioSampleRate: null,
      audioChannels: null,
    })
    expect(result.finalProbe.durationMs).toBeGreaterThanOrEqual(expectedDurationMs - 50)
    expect(result.finalProbe.durationMs).toBeLessThanOrEqual(expectedDurationMs + 50)
    expect(result.sourceProbes).toHaveLength(durations.length)
    expect(result.normalizedPaths).toHaveLength(durations.length)
    expect(result.blackFrames).toEqual([])

    for (const sampleMs of [250, Math.floor(expectedDurationMs / 2), expectedDurationMs - 250]) {
      const sampled = await runProcess('ffmpeg', [
        '-ss', String(sampleMs / 1_000), '-i', finalPath,
        '-frames:v', '1', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-an', '-f', 'null', '-',
      ])
      expect(sampled.exitCode, sampled.stderr).toBe(0)
      const averageLuma = sampled.stderr.match(/lavfi\.signalstats\.YAVG=(\d+(?:\.\d+)?)/)?.[1]
      expect(Number(averageLuma)).toBeGreaterThan(32)
    }
  }, 240_000)
})

function tuple4<T>(values: T[]): [T, T, T, T] {
  if (values.length !== 4) throw new Error('expected four values')
  return values as [T, T, T, T]
}

function subtitleTimestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000)
  const seconds = Math.floor(milliseconds % 60_000 / 1_000)
  const remainder = milliseconds % 1_000
  return [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':')
    + `.${String(remainder).padStart(3, '0')}`
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
