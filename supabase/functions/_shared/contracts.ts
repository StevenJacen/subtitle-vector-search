export interface MovieInput {
  title: string
  releaseYear?: number
  imdbId: string
}

export interface TrackInput {
  languageCode: string
  source: string
  sourceRef?: string
  sourceFileName?: string
  sourceSha256: string
  rightsStatus: 'personal_research' | 'licensed' | 'unverified'
}

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

export type IngestRequest =
  | { action: 'start'; movie: MovieInput; track: TrackInput }
  | { action: 'batch'; trackId: number; cues: Cue[]; chunks: SubtitleChunk[] }
  | { action: 'finalize'; trackId: number }

export class ContractError extends Error {
  constructor() {
    super('invalid request')
    this.name = 'ContractError'
  }
}

export function parseIngestRequest(value: unknown): IngestRequest {
  const request = object(value)
  const action = request.action

  if (action === 'start') {
    return { action, movie: movieInput(request.movie), track: trackInput(request.track) }
  }
  if (action === 'batch') {
    const cues = array(request.cues).map(cue)
    const chunks = array(request.chunks).map(chunk)
    if (cues.length > 100 || chunks.length > 8 || !uniqueIndexes(cues) || !uniqueIndexes(chunks)) {
      throw new ContractError()
    }
    return { action, trackId: positiveInteger(request.trackId), cues, chunks }
  }
  if (action === 'finalize') {
    return { action, trackId: positiveInteger(request.trackId) }
  }

  throw new ContractError()
}

function movieInput(value: unknown): MovieInput {
  const input = object(value)
  const releaseYear = input.releaseYear === undefined ? undefined : integerInRange(input.releaseYear, 1888, 2200)
  return {
    title: nonBlankString(input.title),
    ...(releaseYear === undefined ? {} : { releaseYear }),
    imdbId: nonBlankString(input.imdbId),
  }
}

function trackInput(value: unknown): TrackInput {
  const input = object(value)
  const rightsStatus = input.rightsStatus ?? 'personal_research'
  if (rightsStatus !== 'personal_research' && rightsStatus !== 'licensed' && rightsStatus !== 'unverified') {
    throw new ContractError()
  }
  const sourceRef = optionalString(input.sourceRef)
  const sourceFileName = optionalString(input.sourceFileName)
  return {
    languageCode: nonBlankString(input.languageCode),
    source: nonBlankString(input.source),
    ...(sourceRef === undefined ? {} : { sourceRef }),
    ...(sourceFileName === undefined ? {} : { sourceFileName }),
    sourceSha256: nonBlankString(input.sourceSha256),
    rightsStatus,
  }
}

function cue(value: unknown): Cue {
  const input = object(value)
  const startMs = nonNegativeInteger(input.startMs)
  const endMs = positiveInteger(input.endMs)
  if (endMs <= startMs) {
    throw new ContractError()
  }
  return { index: nonNegativeInteger(input.index), startMs, endMs, text: string(input.text) }
}

function chunk(value: unknown): SubtitleChunk {
  const input = object(value)
  const startMs = nonNegativeInteger(input.startMs)
  const endMs = positiveInteger(input.endMs)
  const firstCueIndex = nonNegativeInteger(input.firstCueIndex)
  const lastCueIndex = nonNegativeInteger(input.lastCueIndex)
  if (endMs <= startMs || lastCueIndex < firstCueIndex) {
    throw new ContractError()
  }
  return {
    index: nonNegativeInteger(input.index),
    startMs,
    endMs,
    firstCueIndex,
    lastCueIndex,
    text: string(input.text),
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractError()
  }
  return value as Record<string, unknown>
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new ContractError()
  }
  return value
}

function string(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ContractError()
  }
  return value
}

function nonBlankString(value: unknown): string {
  const result = string(value)
  if (result.trim() === '') {
    throw new ContractError()
  }
  return result
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : string(value)
}

function nonNegativeInteger(value: unknown): number {
  const result = integer(value)
  if (result < 0) {
    throw new ContractError()
  }
  return result
}

function positiveInteger(value: unknown): number {
  const result = integer(value)
  if (result <= 0) {
    throw new ContractError()
  }
  return result
}

function integerInRange(value: unknown, minimum: number, maximum: number): number {
  const result = integer(value)
  if (result < minimum || result > maximum) {
    throw new ContractError()
  }
  return result
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ContractError()
  }
  return value
}

function uniqueIndexes(values: Array<{ index: number }>): boolean {
  return new Set(values.map(value => value.index)).size === values.length
}
