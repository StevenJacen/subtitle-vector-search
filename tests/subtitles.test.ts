import { describe, expect, it } from 'vitest'
import { formatTimestamp, parseSubtitle } from '../src/subtitles.js'

describe('parseSubtitle', () => {
  it('preserves SRT timestamps and joins multiline dialogue', () => {
    const cues = parseSubtitle(
      '1\n00:00:01,250 --> 00:00:03,500\nHello.\nAre you there?\n',
      '.srt',
    )
    expect(cues).toEqual([{ index: 0, startMs: 1250, endMs: 3500, text: 'Hello. Are you there?' }])
  })

  it('parses WebVTT and removes formatting tags', () => {
    const cues = parseSubtitle(
      'WEBVTT\n\n00:00:02.000 --> 00:00:04.000\n<i>Keep hope alive.</i>\n',
      '.vtt',
    )
    expect(cues[0]).toMatchObject({ startMs: 2000, endMs: 4000, text: 'Keep hope alive.' })
  })

  it('rejects backward timestamps', () => {
    expect(() => parseSubtitle('1\n00:00:03,000 --> 00:00:02,000\nBad\n', '.srt'))
      .toThrow('end time must be greater than start time')
  })
})

it('formats milliseconds for search output', () => {
  expect(formatTimestamp(3723004)).toBe('01:02:03.004')
})
