import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, win32 } from 'node:path'
import { buildAssSubtitles } from './ass-subtitles.js'
import {
  defaultProcessRunner,
  probeMedia,
  validateFinalMediaProbe,
  type MediaProbe,
  type ProcessRunner,
} from './media-probe.js'
import type { StoryboardScene } from './storyboard.js'
import type { ResolvedArtifactPath } from './video-artifacts.js'
import {
  buildDynamicTimeline,
  type DynamicRenderConfiguration,
  type TimelineScene,
} from './workbench/render-plan.js'

export interface RenderConfiguration {
  width: number
  height: number
  fps: number
  sceneDurationSeconds: number
  transitionSeconds: number
  totalDurationSeconds: number
}

export const PRODUCTION_RENDER: RenderConfiguration = Object.freeze({
  width: 1920,
  height: 1080,
  fps: 30,
  sceneDurationSeconds: 7.95,
  transitionSeconds: 0.60,
  totalDurationSeconds: 30,
})

export interface RenderCommands {
  ffmpeg: string
  ffprobe: string
}

export interface RenderVideoInput {
  sourcePaths: readonly [ResolvedArtifactPath, ResolvedArtifactPath, ResolvedArtifactPath, ResolvedArtifactPath]
  sourceInPointsMs: readonly [number, number, number, number]
  scenes: readonly StoryboardScene[]
  normalizedPaths: readonly [ResolvedArtifactPath, ResolvedArtifactPath, ResolvedArtifactPath, ResolvedArtifactPath]
  subtitlesPath: ResolvedArtifactPath
  finalPath: ResolvedArtifactPath
  contactSheetPath: ResolvedArtifactPath
  fontFilePath?: string
  render?: RenderConfiguration
  commands?: Partial<RenderCommands>
}

export interface BlackFrameFinding {
  startSeconds: number
  endSeconds: number
  durationSeconds: number
}

export interface RenderVideoResult {
  sourceProbes: readonly [MediaProbe, MediaProbe, MediaProbe, MediaProbe]
  normalizedPaths: RenderVideoInput['normalizedPaths']
  subtitlesPath: ResolvedArtifactPath
  finalPath: ResolvedArtifactPath
  blackFrames: BlackFrameFinding[]
  contactSheetPath: ResolvedArtifactPath
  finalProbe: MediaProbe
}

export interface SilentWorkbenchRenderInput {
  sourcePaths: readonly string[]
  assPath: string
  finalPath: string
  timeline: readonly TimelineScene[]
  config: DynamicRenderConfiguration
  commands?: RenderCommands
}

export interface SilentWorkbenchRenderResult {
  sourceProbes: readonly MediaProbe[]
  normalizedPaths: readonly string[]
  subtitlesPath: string
  finalPath: string
  blackFrames: BlackFrameFinding[]
  finalProbe: MediaProbe
}

const defaultFontFilePath = 'C:\\Windows\\Fonts\\msyh.ttc'

export function buildTransitionOffsets(render: RenderConfiguration): [number, number, number] {
  validateRenderConfiguration(render)
  const stride = render.sceneDurationSeconds - render.transitionSeconds
  return [1, 2, 3].map(index => roundSeconds(index * stride)) as [number, number, number]
}

export function buildNormalizationArgs(
  sourcePath: string,
  destinationPath: string,
  sourceInPointMs: number,
  probe: MediaProbe,
  render: RenderConfiguration = PRODUCTION_RENDER,
): string[] {
  validateRenderConfiguration(render)
  if (!Number.isSafeInteger(sourceInPointMs) || sourceInPointMs < 0) throw new Error('invalid source in-point')
  const args: string[] = []
  if (probe.durationMs < render.sceneDurationSeconds * 1_000) args.push('-stream_loop', '-1')
  args.push(
    '-ss', formatNumber(sourceInPointMs / 1_000),
    '-i', sourcePath,
    '-an',
    '-vf', [
      `scale=${render.width}:${render.height}:force_original_aspect_ratio=increase`,
      `crop=${render.width}:${render.height}:(iw-ow)/2:(ih-oh)/2`,
      'setsar=1',
      `fps=${render.fps}`,
      'settb=AVTB',
      'setpts=PTS-STARTPTS',
      'format=yuv420p',
    ].join(','),
    '-t', formatNumber(render.sceneDurationSeconds),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-y',
    destinationPath,
  )
  return args
}

export function buildDynamicNormalizationArgs(
  sourcePath: string,
  destinationPath: string,
  scene: TimelineScene,
  probe: MediaProbe,
  config: DynamicRenderConfiguration,
): string[] {
  const args: string[] = []
  if (probe.durationMs < scene.sourceInMs + scene.sourceDurationMs) args.push('-stream_loop', '-1')
  args.push(
    '-ss', formatNumber(scene.sourceInMs / 1_000),
    '-i', sourcePath,
    '-an',
    '-vf', [
      `scale=${config.width}:${config.height}:force_original_aspect_ratio=increase`,
      `crop=${config.width}:${config.height}:(iw-ow)/2:(ih-oh)/2`,
      'setsar=1',
      `fps=${config.frameRate}`,
      'settb=AVTB',
      'setpts=PTS-STARTPTS',
      'format=yuv420p',
    ].join(','),
    '-t', formatNumber(scene.sourceDurationMs / 1_000),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-y',
    destinationPath,
  )
  return args
}

export function buildSilentRenderArgs(input: {
  sourcePaths: readonly string[]
  assPath: string
  finalPath: string
  timeline: readonly TimelineScene[]
  config: DynamicRenderConfiguration
}): string[] {
  validateSilentRenderArguments(input)
  const filters: string[] = []
  let current = '[0:v]'
  for (let index = 0; index < input.timeline.length - 1; index += 1) {
    const scene = input.timeline[index]
    if (scene.xfadeOffsetMs === null || scene.transitionOutMs <= 0) throw new Error('invalid silent render timeline')
    const output = `[x${index + 1}]`
    filters.push(`${current}[${index + 1}:v]xfade=transition=fade:duration=${formatNumber(scene.transitionOutMs / 1_000)}:offset=${formatNumber(scene.xfadeOffsetMs / 1_000)}${output}`)
    current = output
  }
  filters.push(`${current}ass=filename='${filterPath(input.assPath)}'[vout]`)
  const totalDurationMs = input.timeline.at(-1)?.endMs
  if (totalDurationMs === undefined) throw new Error('invalid silent render timeline')

  return [
    ...input.sourcePaths.flatMap(path => ['-i', path]),
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-c:v', 'libx264',
    '-crf', '18',
    '-preset', 'medium',
    '-pix_fmt', 'yuv420p',
    '-r', String(input.config.frameRate),
    '-movflags', '+faststart',
    '-t', formatNumber(totalDurationMs / 1_000),
    '-y',
    input.finalPath,
  ]
}

export async function renderSilentWorkbenchVideo(
  input: SilentWorkbenchRenderInput,
  run: ProcessRunner = defaultProcessRunner,
): Promise<SilentWorkbenchRenderResult> {
  validateSilentWorkbenchInput(input)
  const ffmpegCommand = input.commands?.ffmpeg ?? 'ffmpeg'
  const ffprobeCommand = input.commands?.ffprobe ?? 'ffprobe'
  const probeRunner: ProcessRunner = (_command, args) => run(ffprobeCommand, args)
  const sourceProbes = await Promise.all(input.sourcePaths.map(path => probeMedia(path, probeRunner)))
  const normalizedDirectory = join(dirname(input.finalPath), 'normalized-v2')
  const normalizedPaths = input.timeline.map(scene => join(
    normalizedDirectory,
    `scene-${String(scene.index + 1).padStart(2, '0')}.mp4`,
  ))
  await Promise.all([
    mkdir(normalizedDirectory, { recursive: true }),
    mkdir(dirname(input.finalPath), { recursive: true }),
  ])

  for (let index = 0; index < input.timeline.length; index += 1) {
    await runChecked(run, ffmpegCommand, buildDynamicNormalizationArgs(
      input.sourcePaths[index],
      normalizedPaths[index],
      input.timeline[index],
      sourceProbes[index],
      input.config,
    ), 'source normalization')
  }
  await runChecked(run, ffmpegCommand, buildSilentRenderArgs({
    sourcePaths: normalizedPaths,
    assPath: input.assPath,
    finalPath: input.finalPath,
    timeline: input.timeline,
    config: input.config,
  }), 'final render')

  const totalDurationMs = input.timeline[input.timeline.length - 1].endMs
  const finalProbe = validateFinalMediaProbe(await probeMedia(input.finalPath, probeRunner), {
    width: input.config.width,
    height: input.config.height,
    fps: input.config.frameRate,
    durationSeconds: totalDurationMs / 1_000,
    durationToleranceMs: 50,
    audioCodec: null,
  })
  const blackDetection = await runChecked(
    run,
    ffmpegCommand,
    buildBlackDetectArgs(input.finalPath),
    'black frame detection',
  )
  const blackFrames = parseBlackFrameFindings(`${blackDetection.stdout}\n${blackDetection.stderr}`)

  return {
    sourceProbes,
    normalizedPaths,
    subtitlesPath: input.assPath,
    finalPath: input.finalPath,
    blackFrames,
    finalProbe,
  }
}

export function buildFinalRenderArgs(
  normalizedPaths: readonly [string, string, string, string] | readonly string[],
  subtitlesPath: string,
  fontFilePath: string,
  finalPath: string,
  render: RenderConfiguration = PRODUCTION_RENDER,
): string[] {
  if (normalizedPaths.length !== 4) throw new Error('expected four normalized clips')
  const offsets = buildTransitionOffsets(render)
  const fontDirectory = win32.dirname(fontFilePath)
  const filterGraph = [
    `[0:v][1:v]xfade=transition=fade:duration=${formatNumber(render.transitionSeconds)}:offset=${formatNumber(offsets[0])}[x1]`,
    `[x1][2:v]xfade=transition=fade:duration=${formatNumber(render.transitionSeconds)}:offset=${formatNumber(offsets[1])}[x2]`,
    `[x2][3:v]xfade=transition=fade:duration=${formatNumber(render.transitionSeconds)}:offset=${formatNumber(offsets[2])}[x3]`,
    `[x3]ass=filename='${filterPath(subtitlesPath)}':fontsdir='${filterPath(fontDirectory)}'[vout]`,
    `anoisesrc=color=pink:sample_rate=48000,atrim=duration=${formatNumber(render.totalDurationSeconds)},asetpts=PTS-STARTPTS,highpass=f=120,lowpass=f=6000,volume=0.035,afade=t=in:st=0:d=1,afade=t=out:st=${formatNumber(Math.max(0, render.totalDurationSeconds - 1))}:d=1[aout]`,
  ].join(';')

  return [
    ...normalizedPaths.flatMap(path => ['-i', path]),
    '-filter_complex', filterGraph,
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-crf', '18',
    '-preset', 'medium',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    '-t', formatNumber(render.totalDurationSeconds),
    '-y',
    finalPath,
  ]
}

export function buildContactSheetArgs(
  finalPath: string,
  contactSheetPath: string,
  render: RenderConfiguration = PRODUCTION_RENDER,
): string[] {
  validateRenderConfiguration(render)
  const sampleTimes = [0, 0.25, 0.5, 0.75].map(fraction => formatNumber(render.totalDurationSeconds * fraction))
  const tileWidth = Math.floor(render.width / 2)
  const tileHeight = Math.floor(render.height / 2)
  const graph = [0, 1, 2, 3]
    .map(index => `[${index}:v]scale=${tileWidth}:${tileHeight},setsar=1[t${index}]`)
    .concat('[t0][t1]hstack=inputs=2[top]', '[t2][t3]hstack=inputs=2[bottom]', '[top][bottom]vstack=inputs=2[sheet]')
    .join(';')
  return [
    ...sampleTimes.flatMap(time => ['-ss', time, '-i', finalPath]),
    '-filter_complex', graph,
    '-map', '[sheet]',
    '-frames:v', '1',
    '-q:v', '2',
    '-y',
    contactSheetPath,
  ]
}

export function buildBlackDetectArgs(finalPath: string): string[] {
  return ['-i', finalPath, '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-an', '-f', 'null', '-']
}

export function parseBlackFrameFindings(output: string): BlackFrameFinding[] {
  const findings = Array.from(output.matchAll(
    /black_start:(\d+(?:\.\d+)?)\s+black_end:(\d+(?:\.\d+)?)\s+black_duration:(\d+(?:\.\d+)?)/g,
  )).map(match => ({
    startSeconds: Number(match[1]),
    endSeconds: Number(match[2]),
    durationSeconds: Number(match[3]),
  }))
  if (findings.some(finding => finding.durationSeconds > 1)) {
    throw new Error('black interval exceeds one second')
  }
  return findings
}

export async function renderVideo(
  input: RenderVideoInput,
  run: ProcessRunner = defaultProcessRunner,
): Promise<RenderVideoResult> {
  validateRenderInput(input)
  const render = input.render ?? PRODUCTION_RENDER
  const ffmpegCommand = input.commands?.ffmpeg ?? 'ffmpeg'
  const ffprobeCommand = input.commands?.ffprobe ?? 'ffprobe'
  const fontFilePath = input.fontFilePath ?? defaultFontFilePath
  const probeRunner: ProcessRunner = (_command, args) => run(ffprobeCommand, args)
  const sourceProbes = tuple4(await Promise.all(input.sourcePaths.map(path => probeMedia(path, probeRunner))))

  await Promise.all([
    ...input.normalizedPaths.map(path => mkdir(dirname(path), { recursive: true })),
    mkdir(dirname(input.subtitlesPath), { recursive: true }),
    mkdir(dirname(input.finalPath), { recursive: true }),
    mkdir(dirname(input.contactSheetPath), { recursive: true }),
  ])
  await writeFile(input.subtitlesPath, buildAssSubtitles(input.scenes, render, render), 'utf8')

  for (let index = 0; index < 4; index += 1) {
    await runChecked(run, ffmpegCommand, buildNormalizationArgs(
      input.sourcePaths[index],
      input.normalizedPaths[index],
      input.sourceInPointsMs[index],
      sourceProbes[index],
      render,
    ), 'source normalization')
  }

  await runChecked(run, ffmpegCommand, buildFinalRenderArgs(
    input.normalizedPaths,
    input.subtitlesPath,
    fontFilePath,
    input.finalPath,
    render,
  ), 'final render')
  const finalProbe = validateFinalMediaProbe(await probeMedia(input.finalPath, probeRunner), {
    width: render.width,
    height: render.height,
    fps: render.fps,
    durationSeconds: render.totalDurationSeconds,
  })
  const blackDetection = await runChecked(
    run,
    ffmpegCommand,
    buildBlackDetectArgs(input.finalPath),
    'black frame detection',
  )
  const blackFrames = parseBlackFrameFindings(`${blackDetection.stdout}\n${blackDetection.stderr}`)
  await runChecked(run, ffmpegCommand, buildContactSheetArgs(
    input.finalPath,
    input.contactSheetPath,
    render,
  ), 'contact sheet')

  return {
    sourceProbes,
    normalizedPaths: input.normalizedPaths,
    subtitlesPath: input.subtitlesPath,
    finalPath: input.finalPath,
    blackFrames,
    contactSheetPath: input.contactSheetPath,
    finalProbe,
  }
}

async function runChecked(
  run: ProcessRunner,
  command: string,
  args: string[],
  operation: string,
): Promise<Awaited<ReturnType<ProcessRunner>>> {
  const result = await run(command, args)
  if (result.exitCode !== 0) throw new Error(`${operation} failed`)
  return result
}

function validateRenderInput(input: RenderVideoInput): void {
  validateRenderConfiguration(input.render ?? PRODUCTION_RENDER)
  if (input.sourcePaths.length !== 4
    || input.normalizedPaths.length !== 4
    || input.sourceInPointsMs.length !== 4
    || input.scenes.length !== 4
    || input.sourceInPointsMs.some(value => !Number.isSafeInteger(value) || value < 0)
    || [...input.sourcePaths, ...input.normalizedPaths, input.subtitlesPath, input.finalPath, input.contactSheetPath]
      .some(path => typeof path !== 'string' || path.trim() === '')) {
    throw new Error('invalid render input')
  }
}

function validateSilentWorkbenchInput(input: SilentWorkbenchRenderInput): void {
  validateSilentRenderArguments(input)
}

function validateSilentRenderArguments(input: {
  sourcePaths: readonly string[]
  assPath: string
  finalPath: string
  timeline: readonly TimelineScene[]
  config: DynamicRenderConfiguration
}): void {
  if (typeof input.assPath !== 'string'
    || input.assPath.trim() === ''
    || typeof input.finalPath !== 'string'
    || input.finalPath.trim() === ''
    || input.sourcePaths.length !== input.timeline.length
    || input.sourcePaths.some(path => typeof path !== 'string' || path.trim() === '')
  ) {
    throw new Error('invalid silent render input')
  }

  const expected = buildDynamicTimeline(input.timeline, input.config)
  if (input.timeline.some((scene, index) => {
    const canonical = expected[index]
    return scene.startMs !== canonical.startMs
      || scene.endMs !== canonical.endMs
      || scene.transitionOutMs !== canonical.transitionOutMs
      || scene.sourceDurationMs !== canonical.sourceDurationMs
      || scene.xfadeOffsetMs !== canonical.xfadeOffsetMs
  })) throw new Error('invalid silent render timeline')
}

function validateRenderConfiguration(render: RenderConfiguration): void {
  if (!Number.isSafeInteger(render.width)
    || render.width < 2
    || !Number.isSafeInteger(render.height)
    || render.height < 2
    || !Number.isFinite(render.fps)
    || render.fps <= 0
    || !Number.isFinite(render.sceneDurationSeconds)
    || render.sceneDurationSeconds <= 0
    || !Number.isFinite(render.transitionSeconds)
    || render.transitionSeconds <= 0
    || render.transitionSeconds >= render.sceneDurationSeconds
    || !Number.isFinite(render.totalDurationSeconds)
    || render.totalDurationSeconds <= 0) {
    throw new Error('invalid render configuration')
  }
  const expectedTotal = render.sceneDurationSeconds * 4 - render.transitionSeconds * 3
  if (Math.abs(expectedTotal - render.totalDurationSeconds) > 0.000_001) throw new Error('invalid render configuration')
}

function filterPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

function formatNumber(value: number): string {
  return String(roundSeconds(value))
}

function roundSeconds(value: number): number {
  return Number(value.toFixed(6))
}

function tuple4<T>(values: T[]): [T, T, T, T] {
  if (values.length !== 4) throw new Error('expected four values')
  return values as [T, T, T, T]
}
