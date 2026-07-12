export interface Cue {
  index: number
  startMs: number
  endMs: number
  text: string
}

export interface SubtitleChunk {
  index: number
  startMs: number
  endMs: number
  firstCueIndex: number
  lastCueIndex: number
  text: string
}
