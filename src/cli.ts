import { access, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Command } from 'commander'
import 'dotenv/config'
import { buildChunks } from './chunks.js'
import type { Cue, SubtitleChunk } from './domain.js'
import { OpenSubtitlesClient } from './opensubtitles.js'
import { SubtitleApi } from './supabase-api.js'
import { formatTimestamp, parseSubtitle } from './subtitles.js'

type OpenSubtitlesCommands = Pick<OpenSubtitlesClient, 'searchEnglishByImdb' | 'downloadFile'>
type SubtitleApiCommands = Pick<SubtitleApi, 'startImport' | 'sendBatch' | 'finalizeImport' | 'search'>

export interface CliDependencies {
  env: Record<string, string | undefined>
  openSubtitles?: OpenSubtitlesCommands
  subtitleApi?: SubtitleApiCommands
  fileExists: (path: string) => Promise<boolean>
  readFile: (path: string) => Promise<Buffer>
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>
  output: (text: string) => void
  parseSubtitleFn: (content: string, extension: string) => Cue[]
  buildChunksFn: (cues: Cue[]) => SubtitleChunk[]
}

export function createProgram(overrides: Partial<CliDependencies> = {}): Command {
  const dependencies: CliDependencies = {
    env: process.env,
    fileExists,
    readFile,
    writeFile,
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
      if (await dependencies.fileExists(options.output)) {
        throw new Error(`refusing to overwrite existing output: ${options.output}`)
      }

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
      await dependencies.writeFile(options.output, download.bytes)
      dependencies.output(`Downloaded ${download.fileName} to ${options.output}.\n`)
    })

  program
    .command('import <subtitleFile>')
    .requiredOption('--title <title>', 'movie title')
    .requiredOption('--year <year>', 'release year', parseInteger)
    .requiredOption('--imdb <id>', 'IMDb title ID')
    .requiredOption('--source <source>', 'subtitle provenance source')
    .action(async (subtitleFile: string, options: { title: string; year: number; imdb: string; source: string }) => {
      const bytes = await dependencies.readFile(subtitleFile)
      const cues = dependencies.parseSubtitleFn(bytes.toString('utf8'), extname(subtitleFile))
      const chunks = dependencies.buildChunksFn(cues)
      const api = dependencies.subtitleApi ?? new SubtitleApi({
        supabaseUrl: requireEnvironment(dependencies.env, 'SUPABASE_URL'),
        publishableKey: requireEnvironment(dependencies.env, 'SUPABASE_PUBLISHABLE_KEY'),
        personalToken: requireEnvironment(dependencies.env, 'SUBTITLE_PERSONAL_TOKEN'),
      })
      const sourceSha256 = createHash('sha256').update(bytes).digest('hex')
      const started = await api.startImport({
        movie: { title: options.title, releaseYear: options.year, imdbId: options.imdb },
        track: { languageCode: 'en', source: options.source, sourceSha256 },
      })

      for (let cueStart = 0, chunkStart = 0; cueStart < cues.length || chunkStart < chunks.length;) {
        const cueBatch = cues.slice(cueStart, cueStart + 100)
        const chunkBatch = chunks.slice(chunkStart, chunkStart + 8)
        await api.sendBatch({ trackId: started.trackId, cues: cueBatch, chunks: chunkBatch })
        cueStart += cueBatch.length
        chunkStart += chunkBatch.length
      }

      await api.finalizeImport(started.trackId)
      dependencies.output(`Imported ${cues.length} cues and ${chunks.length} chunks.\n`)
    })

  program
    .command('search <query>')
    .option('--limit <count>', 'maximum results', parseInteger, 10)
    .action(async (query: string, options: { limit: number }) => {
      const api = dependencies.subtitleApi ?? new SubtitleApi({
        supabaseUrl: requireEnvironment(dependencies.env, 'SUPABASE_URL'),
        publishableKey: requireEnvironment(dependencies.env, 'SUPABASE_PUBLISHABLE_KEY'),
        personalToken: requireEnvironment(dependencies.env, 'SUBTITLE_PERSONAL_TOKEN'),
      })
      const results = await api.search({ query, limit: options.limit })

      if (results.length === 0) {
        dependencies.output('No matching dialogue found.\n')
        return
      }

      for (const result of results) {
        dependencies.output(`${result.similarity.toFixed(3)}  ${formatTimestamp(result.startMs)} --> ${formatTimestamp(result.endMs)}\n${result.text}\n`)
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

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

const entryPoint = process.argv[1]
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  void createProgram().parseAsync().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
