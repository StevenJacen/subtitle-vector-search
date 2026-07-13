import { open, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Command } from 'commander'
import 'dotenv/config'
import { buildChunks } from './chunks.js'
import type { Cue, SubtitleChunk } from './domain.js'
import { OpenSubtitlesClient } from './opensubtitles.js'
import { SubtitleApi } from './supabase-api.js'
import { parseSubtitle } from './subtitles.js'

type OpenSubtitlesCommands = Pick<OpenSubtitlesClient, 'searchEnglishByImdb' | 'downloadFile'>
type SubtitleApiCommands = Pick<SubtitleApi, 'startImport' | 'sendBatch' | 'finalizeImport' | 'failImport' | 'search'>

export interface CliDependencies {
  env: Record<string, string | undefined>
  openSubtitles?: OpenSubtitlesCommands
  subtitleApi?: SubtitleApiCommands
  readFile: (path: string) => Promise<Buffer>
  writeFileExclusive: (path: string, bytes: Uint8Array) => Promise<void>
  output: (text: string) => void
  parseSubtitleFn: (content: string, extension: string) => Cue[]
  buildChunksFn: (cues: Cue[]) => SubtitleChunk[]
}

export function createProgram(overrides: Partial<CliDependencies> = {}): Command {
  const dependencies: CliDependencies = {
    env: process.env,
    readFile,
    writeFileExclusive,
    output: text => process.stdout.write(text),
    parseSubtitleFn: parseSubtitle,
    buildChunksFn: buildChunks,
    ...overrides,
  }

  const program = new Command()
  program
    .name('subtitle')
    .description('Download, import, and search private English subtitles')

  program
    .command('download')
    .requiredOption('--imdb <id>', 'IMDb title ID')
    .requiredOption('--output <path>', 'destination subtitle path')
    .action(async (options: { imdb: string; output: string }) => {
      const client = dependencies.openSubtitles ?? new OpenSubtitlesClient({
        apiKey: requireEnvironment(dependencies.env, 'OPENSUBTITLES_API_KEY'),
        token: requireEnvironment(dependencies.env, 'OPENSUBTITLES_TOKEN'),
        userAgent: requireEnvironment(dependencies.env, 'OPENSUBTITLES_USER_AGENT'),
      })
      const candidate = (await client.searchEnglishByImdb(options.imdb))[0]
      if (candidate === undefined) {
        throw new Error('no English subtitles found for the supplied IMDb ID')
      }

      const download = await client.downloadFile(candidate.fileId)
      try {
        await dependencies.writeFileExclusive(options.output, download.bytes)
      } catch (error) {
        if (isFileExistsError(error)) {
          throw new Error(`refusing to overwrite existing output: ${options.output}`)
        }
        throw error
      }
      dependencies.output(`Downloaded ${download.fileName} to ${options.output}.\n`)
    })

  program
    .command('import <subtitleFile>')
    .requiredOption('--title <title>', 'movie title')
    .requiredOption('--year <year>', 'release year', parseInteger)
    .requiredOption('--imdb <id>', 'IMDb title ID')
    .requiredOption('--source <source>', 'subtitle provenance source')
    .option('--source-ref <reference>', 'source-specific subtitle reference')
    .action(async (subtitleFile: string, options: { title: string; year: number; imdb: string; source: string; sourceRef?: string }) => {
      const bytes = await dependencies.readFile(subtitleFile)
      const cues = dependencies.parseSubtitleFn(bytes.toString('utf8'), extname(subtitleFile))
      const chunks = dependencies.buildChunksFn(cues)
      if (chunks.length === 0) {
        throw new Error('subtitle contains no usable chunks')
      }
      const api = dependencies.subtitleApi ?? new SubtitleApi({
        supabaseUrl: requireEnvironment(dependencies.env, 'SUPABASE_URL'),
        publishableKey: requireEnvironment(dependencies.env, 'SUPABASE_PUBLISHABLE_KEY'),
        personalToken: requireEnvironment(dependencies.env, 'SUBTITLE_PERSONAL_TOKEN'),
      })
      const sourceSha256 = createHash('sha256').update(bytes).digest('hex')
      const started = await api.startImport({
        movie: { title: options.title, releaseYear: options.year, imdbId: options.imdb },
        track: {
          languageCode: 'en',
          source: options.source,
          sourceRef: options.sourceRef,
          sourceFileName: basename(subtitleFile),
          sourceSha256,
          rightsStatus: 'personal_research',
        },
      })

      let acceptedCueCount = 0
      let acceptedChunkCount = 0
      try {
        for (let cueStart = 0, chunkStart = 0; cueStart < cues.length || chunkStart < chunks.length;) {
          const cueBatch = cues.slice(cueStart, cueStart + 100)
          const chunkBatch = chunks.slice(chunkStart, chunkStart + 8)
          const accepted = await api.sendBatch({ trackId: started.trackId, cues: cueBatch, chunks: chunkBatch })
          acceptedCueCount += accepted.acceptedCueCount
          acceptedChunkCount += accepted.acceptedChunkCount
          cueStart += cueBatch.length
          chunkStart += chunkBatch.length
        }
      } catch (error) {
        await api.failImport(started.trackId).catch(() => undefined)
        throw error
      }

      await api.finalizeImport(started.trackId)
      dependencies.output(`Imported ${acceptedCueCount} cues and ${acceptedChunkCount} chunks.\n`)
    })

  program
    .command('search <query>')
    .option('--limit <count>', 'maximum results', parseInteger, 10)
    .option('--movie-id <id>', 'limit results to a movie ID', parseInteger)
    .action(async (query: string, options: { limit: number; movieId?: number }) => {
      const api = dependencies.subtitleApi ?? new SubtitleApi({
        supabaseUrl: requireEnvironment(dependencies.env, 'SUPABASE_URL'),
        publishableKey: requireEnvironment(dependencies.env, 'SUPABASE_PUBLISHABLE_KEY'),
        personalToken: requireEnvironment(dependencies.env, 'SUBTITLE_PERSONAL_TOKEN'),
      })
      const results = await api.search({
        query,
        limit: options.limit,
        ...(options.movieId === undefined ? {} : { movieId: options.movieId }),
      })

      if (results.length === 0) {
        dependencies.output('No matching dialogue found.\n')
        return
      }

      for (const result of results) {
        dependencies.output(`${result.similarity.toFixed(3)}  ${result.timestamp}\n${result.text}\n`)
      }
    })

  return program
}

function parseInteger(value: string): number {
  const number = Number(value)
  if (!Number.isInteger(number)) {
    throw new Error(`expected an integer, received: ${value}`)
  }
  return number
}

function requireEnvironment(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`missing environment variable: ${name}`)
  }
  return value
}

async function writeFileExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const file = await open(path, 'wx')
  try {
    await file.writeFile(bytes)
  } finally {
    await file.close()
  }
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

const entryPoint = process.argv[1]
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  void createProgram().parseAsync().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
