import type { StoryboardScene } from './storyboard.js'
import type {
  DynamicRenderConfiguration,
  DynamicScene,
  TimelineScene,
} from './workbench/render-plan.js'

export interface CaptionWindow {
  startSeconds: number
  endSeconds: number
}

export interface CaptionTimingConfiguration {
  sceneDurationSeconds: number
  transitionSeconds: number
  totalDurationSeconds: number
}

const productionCaptionTiming: CaptionTimingConfiguration = {
  sceneDurationSeconds: 7.95,
  transitionSeconds: 0.60,
  totalDurationSeconds: 30,
}

export function buildCaptionWindows(
  timing: CaptionTimingConfiguration = productionCaptionTiming,
): [CaptionWindow, CaptionWindow, CaptionWindow, CaptionWindow] {
  const stride = timing.sceneDurationSeconds - timing.transitionSeconds
  const boundaries = [0, stride, stride * 2, stride * 3, timing.totalDurationSeconds]
    .map(roundSeconds)
  if (stride <= 0 || boundaries.some((value, index) => !Number.isFinite(value)
    || value < 0
    || value > timing.totalDurationSeconds
    || (index > 0 && value < boundaries[index - 1]))) {
    throw new Error('invalid subtitle timing')
  }
  return [0, 1, 2, 3].map(index => ({
    startSeconds: boundaries[index],
    endSeconds: boundaries[index + 1],
  })) as [CaptionWindow, CaptionWindow, CaptionWindow, CaptionWindow]
}

export function escapeAssText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/\r\n|\r|\n/g, '\\N')
}

export function buildAssSubtitles(
  scenes: readonly StoryboardScene[],
  timing: CaptionTimingConfiguration = productionCaptionTiming,
  resolution: { width: number; height: number } = { width: 1920, height: 1080 },
): string {
  validateScenes(scenes)
  const windows = buildCaptionWindows(timing)
  const events = scenes.map((scene, index) => {
    const source = scene.captionKind === 'quote'
      ? `\\N${escapeAssText(`${scene.movieTitle} (${scene.releaseYear}) · ${sourceStart(scene.sourceTimestamp)}`)}`
      : ''
    const text = `${escapeAssText(scene.captionEn)}\\N${escapeAssText(scene.captionZh)}${source}`
    return `Dialogue: 0,${assTime(windows[index].startSeconds)},${assTime(windows[index].endSeconds)},Default,,0,0,0,,${text}`
  })

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${resolution.width}`,
    `PlayResY: ${resolution.height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Microsoft YaHei,60,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,192,192,108,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n')
}

export const generateAssSubtitles = buildAssSubtitles

export interface DynamicAssSource {
  movieTitle: string
  releaseYear: number
}

export function buildDynamicAssSubtitles(
  scenes: readonly DynamicScene[],
  timeline: readonly TimelineScene[],
  config: DynamicRenderConfiguration,
  source: DynamicAssSource,
): string {
  if (scenes.length !== timeline.length
    || scenes.length < 5
    || scenes.length > 10
    || source.movieTitle.trim() === ''
    || !Number.isSafeInteger(source.releaseYear)
    || timeline.some((entry, index) => entry.index !== index
      || entry.captionEn !== scenes[index]?.captionEn
      || entry.captionZh !== scenes[index]?.captionZh
      || entry.startMs !== (index === 0 ? 0 : timeline[index - 1]?.endMs)
      || entry.endMs - entry.startMs !== scenes[index]?.durationMs)) {
    throw new Error('invalid dynamic subtitle scenes')
  }

  const portrait = config.width < config.height
  const styleName = portrait ? 'Portrait' : 'Landscape'
  const fontSize = portrait ? 52 : 60
  const marginL = Math.ceil(config.width * 0.10)
  const marginV = Math.ceil(config.height * 0.10)
  const events = timeline.map(scene => {
    const sourceLine = `${source.movieTitle} (${source.releaseYear})`
    const text = [scene.captionEn, scene.captionZh, sourceLine].map(escapeAssText).join('\\N')
    return `Dialogue: 0,${assTimeMs(scene.startMs)},${assTimeMs(scene.endMs)},${styleName},,0,0,0,,${text}`
  })

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${config.width}`,
    `PlayResY: ${config.height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ${styleName},Microsoft YaHei,${fontSize},&H00FFFFFF,&H000000FF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,${marginL},${marginL},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n')
}

function validateScenes(scenes: readonly StoryboardScene[]): void {
  if (scenes.length !== 4
    || scenes.some((scene, index) => scene.index !== index
      || scene.captionEn.trim() === ''
      || scene.captionZh.trim() === '')
    || scenes.filter(scene => scene.captionKind === 'quote').length !== 1) {
    throw new Error('invalid subtitle scenes')
  }
  const quote = scenes.find(scene => scene.captionKind === 'quote')
  if (quote === undefined
    || typeof quote.movieTitle !== 'string'
    || quote.movieTitle.trim() === ''
    || !Number.isSafeInteger(quote.releaseYear)
    || quote.releaseYear === null
    || typeof quote.sourceTimestamp !== 'string'
    || !/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->/.test(quote.sourceTimestamp)) {
    throw new Error('invalid subtitle scenes')
  }
}

function sourceStart(timestamp: string | undefined): string {
  return timestamp?.split(/\s+-->\s+/)[0] ?? ''
}

function assTime(seconds: number): string {
  const centiseconds = Math.round(seconds * 100)
  const hours = Math.floor(centiseconds / 360_000)
  const minutes = Math.floor(centiseconds % 360_000 / 6_000)
  const wholeSeconds = Math.floor(centiseconds % 6_000 / 100)
  const remainder = centiseconds % 100
  return `${hours}:${pad(minutes)}:${pad(wholeSeconds)}.${pad(remainder)}`
}

function assTimeMs(milliseconds: number): string {
  return assTime(milliseconds / 1_000)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function roundSeconds(value: number): number {
  return Number(value.toFixed(6))
}
