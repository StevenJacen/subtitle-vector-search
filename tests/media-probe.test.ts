import { describe, expect, it, vi } from 'vitest'
import {
  parseMediaProbe,
  probeMedia,
  validateFinalMediaProbe,
  type ProcessRunner,
} from '../src/media-probe.js'

const validProbeJson = {
  format: { duration: '12.500000', size: '123456' },
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      pix_fmt: 'yuv420p',
      avg_frame_rate: '30000/1001',
    },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
  ],
}

describe('parseMediaProbe', () => {
  it('parses a real ffprobe JSON shape', () => {
    const probe = parseMediaProbe(validProbeJson)

    expect(probe.durationMs).toBe(12_500)
    expect(probe.sizeBytes).toBe(123_456)
    expect(probe.frameRate).toBeCloseTo(29.97, 2)
    expect(probe).toMatchObject({
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
      pixelFormat: 'yuv420p',
      audioSampleRate: 48_000,
      audioChannels: 2,
    })
  })

  it.each([
    ['missing video', { ...validProbeJson, streams: validProbeJson.streams.slice(1) }],
    ['zero duration', { ...validProbeJson, format: { ...validProbeJson.format, duration: '0' } }],
    ['zero width', { ...validProbeJson, streams: [{ ...validProbeJson.streams[0], width: 0 }, validProbeJson.streams[1]] }],
    ['zero height', { ...validProbeJson, streams: [{ ...validProbeJson.streams[0], height: 0 }, validProbeJson.streams[1]] }],
    ['nonfinite frame-rate fraction', { ...validProbeJson, streams: [{ ...validProbeJson.streams[0], avg_frame_rate: '1/0' }, validProbeJson.streams[1]] }],
    ['implausibly small size', { ...validProbeJson, format: { ...validProbeJson.format, size: '999' } }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseMediaProbe(value)).toThrow('invalid media probe')
  })

  it('runs ffprobe through the injected process boundary', async () => {
    const run = vi.fn<ProcessRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(validProbeJson),
      stderr: '',
    })

    await expect(probeMedia('C:\\media\\source.mp4', run)).resolves.toMatchObject({ durationMs: 12_500 })
    expect(run).toHaveBeenCalledWith('ffprobe', [
      '-v', 'error',
      '-show_format',
      '-show_streams',
      '-of', 'json',
      'C:\\media\\source.mp4',
    ])
  })

  it('rejects failed and malformed ffprobe output', async () => {
    const failed: ProcessRunner = async () => ({ exitCode: 1, stdout: '', stderr: 'bad input' })
    const malformed: ProcessRunner = async () => ({ exitCode: 0, stdout: '{', stderr: '' })

    await expect(probeMedia('source.mp4', failed)).rejects.toThrow('ffprobe failed')
    await expect(probeMedia('source.mp4', malformed)).rejects.toThrow('invalid media probe')
  })
})

describe('validateFinalMediaProbe', () => {
  const finalProbe = parseMediaProbe({
    ...validProbeJson,
    format: { duration: '30.000000', size: '1234567' },
  })

  it('accepts the production output contract', () => {
    expect(validateFinalMediaProbe(finalProbe)).toBe(finalProbe)
  })

  it.each([
    ['width', { width: 1919 }],
    ['height', { height: 1079 }],
    ['low frame rate', { frameRate: 29.49 }],
    ['high frame rate', { frameRate: 30.51 }],
    ['short duration', { durationMs: 28_999 }],
    ['long duration', { durationMs: 31_001 }],
    ['video codec', { videoCodec: 'hevc' }],
    ['audio codec', { audioCodec: 'opus' }],
    ['audio sample rate', { audioSampleRate: 44_100 }],
    ['audio channels', { audioChannels: 1 }],
    ['pixel format', { pixelFormat: 'yuv444p' }],
  ])('rejects final output with invalid %s', (_name, change) => {
    expect(() => validateFinalMediaProbe({ ...finalProbe, ...change })).toThrow('invalid final media')
  })
})

describe('validate silent workbench output', () => {
  const silentProbe = parseMediaProbe({
    format: { duration: '16.000000', size: '1234567' },
    streams: [validProbeJson.streams[0]],
  })

  it('requires a null audio codec and null audio properties', () => {
    expect(validateFinalMediaProbe(silentProbe, {
      width: 1920,
      height: 1080,
      fps: 30,
      durationSeconds: 16,
      audioCodec: null,
    })).toBe(silentProbe)

    expect(() => validateFinalMediaProbe({
      ...silentProbe,
      audioCodec: 'aac',
      audioSampleRate: 48_000,
      audioChannels: 2,
    }, {
      width: 1920,
      height: 1080,
      fps: 30,
      durationSeconds: 16,
      audioCodec: null,
    })).toThrow('invalid final media')
  })
})
