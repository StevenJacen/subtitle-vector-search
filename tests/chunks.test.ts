import { expect, it } from 'vitest'
import { buildChunks, estimateTokens } from '../src/chunks.js'

const cues = Array.from({ length: 6 }, (_, index) => ({
  index,
  startMs: index * 1000,
  endMs: index * 1000 + 900,
  text: `line ${index} carries several useful words`,
}))

it('builds deterministic chunks with cue overlap', () => {
  const chunks = buildChunks(cues, { targetTokens: 14, maxTokens: 20, overlapCues: 2 })
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks[1].firstCueIndex).toBe(chunks[0].lastCueIndex - 1)
  expect(chunks[0].startMs).toBe(cues[chunks[0].firstCueIndex].startMs)
  expect(chunks[0].endMs).toBe(cues[chunks[0].lastCueIndex].endMs)
})

it('rejects a single cue above the model-safe maximum', () => {
  const oversized = [{ index: 0, startMs: 0, endMs: 1000, text: 'word '.repeat(500) }]
  expect(() => buildChunks(oversized)).toThrow('cue exceeds the embedding token limit')
})

it('excludes empty-text cues from embedding chunks', () => {
  const chunks = buildChunks([
    { index: 0, startMs: 0, endMs: 900, text: '' },
    { index: 1, startMs: 1000, endMs: 1900, text: 'spoken dialogue' },
  ])

  expect(chunks).toEqual([{
    index: 0,
    startMs: 1000,
    endMs: 1900,
    firstCueIndex: 1,
    lastCueIndex: 1,
    text: 'spoken dialogue',
  }])
})

it('reduces overlap so long model-safe cues reach the coverage frontier', () => {
  const longCues = Array.from({ length: 3 }, (_, index) => ({
    index,
    startMs: index * 1000,
    endMs: index * 1000 + 900,
    text: 'word '.repeat(200),
  }))

  const chunks = buildChunks(longCues)

  expect(chunks.at(-1)?.lastCueIndex).toBe(2)
  expect(chunks.every(chunk => estimateTokens(chunk.text) <= 450)).toBe(true)
})
