import { spawn } from 'node:child_process'

export interface ProcessResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type ProcessRunner = (command: string, args: string[]) => Promise<ProcessResult>

export interface MediaProbe {
  durationMs: number
  sizeBytes: number
  width: number
  height: number
  frameRate: number
  videoCodec: string
  audioCodec: string | null
  pixelFormat: string
  audioSampleRate: number | null
  audioChannels: number | null
}

export interface FinalMediaExpectations {
  width: number
  height: number
  fps: number
  durationSeconds: number
  frameRateTolerance?: number
  durationToleranceMs?: number
}

const minimumPlausibleMediaSizeBytes = 1_000

export const defaultProcessRunner: ProcessRunner = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { shell: false, windowsHide: true })
  let stdout = ''
  let stderr = ''

  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.once('error', reject)
  child.once('close', exitCode => resolve({ exitCode: exitCode ?? -1, stdout, stderr }))
})

export function parseMediaProbe(value: unknown): MediaProbe {
  try {
    const root = record(value)
    const format = record(root.format)
    const streams = array(root.streams).map(record)
    const video = streams.find(stream => stream.codec_type === 'video')
    if (video === undefined) throw new Error()
    const audio = streams.find(stream => stream.codec_type === 'audio')

    const durationSeconds = positiveFiniteNumber(format.duration)
    const sizeBytes = positiveInteger(format.size)
    const width = positiveInteger(video.width)
    const height = positiveInteger(video.height)
    const frameRate = positiveFraction(video.avg_frame_rate)
    const videoCodec = nonblankString(video.codec_name)
    const pixelFormat = nonblankString(video.pix_fmt)
    if (durationSeconds === null
      || sizeBytes === null
      || sizeBytes < minimumPlausibleMediaSizeBytes
      || width === null
      || height === null
      || frameRate === null
      || videoCodec === null
      || pixelFormat === null) {
      throw new Error()
    }

    let audioCodec: string | null = null
    let audioSampleRate: number | null = null
    let audioChannels: number | null = null
    if (audio !== undefined) {
      audioCodec = nonblankString(audio.codec_name)
      audioSampleRate = positiveInteger(audio.sample_rate)
      audioChannels = positiveInteger(audio.channels)
      if (audioCodec === null || audioSampleRate === null || audioChannels === null) throw new Error()
    }

    return {
      durationMs: Math.round(durationSeconds * 1_000),
      sizeBytes,
      width,
      height,
      frameRate,
      videoCodec,
      audioCodec,
      pixelFormat,
      audioSampleRate,
      audioChannels,
    }
  } catch {
    throw invalidMediaProbe()
  }
}

export async function probeMedia(path: string, run: ProcessRunner = defaultProcessRunner): Promise<MediaProbe> {
  const result = await run('ffprobe', [
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-of', 'json',
    path,
  ])
  if (result.exitCode !== 0) throw new Error('ffprobe failed')

  try {
    return parseMediaProbe(JSON.parse(result.stdout))
  } catch {
    throw invalidMediaProbe()
  }
}

export function validateFinalMediaProbe(
  probe: MediaProbe,
  expected: FinalMediaExpectations = {
    width: 1920,
    height: 1080,
    fps: 30,
    durationSeconds: 30,
  },
): MediaProbe {
  const frameRateTolerance = expected.frameRateTolerance ?? 0.5
  const durationToleranceMs = expected.durationToleranceMs ?? 1_000
  if (probe.width !== expected.width
    || probe.height !== expected.height
    || probe.frameRate < expected.fps - frameRateTolerance
    || probe.frameRate > expected.fps + frameRateTolerance
    || probe.durationMs < expected.durationSeconds * 1_000 - durationToleranceMs
    || probe.durationMs > expected.durationSeconds * 1_000 + durationToleranceMs
    || probe.videoCodec !== 'h264'
    || probe.audioCodec !== 'aac'
    || probe.pixelFormat !== 'yuv420p') {
    throw new Error('invalid final media')
  }
  return probe
}

function positiveFraction(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?\/\d+(?:\.\d+)?$/.test(value)) return null
  const [numeratorText, denominatorText] = value.split('/')
  const numerator = Number(numeratorText)
  const denominator = Number(denominatorText)
  const result = numerator / denominator
  return Number.isFinite(result) && result > 0 ? result : null
}

function positiveFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) return null
  const result = Number(value)
  return Number.isFinite(result) && result > 0 ? result : null
}

function positiveInteger(value: unknown): number | null {
  const result = positiveFiniteNumber(value)
  return result !== null && Number.isSafeInteger(result) ? result : null
}

function nonblankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error()
  return value as Record<string, unknown>
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error()
  return value
}

function invalidMediaProbe(): Error {
  return new Error('invalid media probe')
}
