import { expect, it } from 'vitest'
import { buildChunks } from '../src/chunks.js'

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
