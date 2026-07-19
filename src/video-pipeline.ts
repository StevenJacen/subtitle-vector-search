import 'dotenv/config'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { Command } from 'commander'
import { probeMedia } from './media-probe.js'
import { SubtitleApi } from './supabase-api.js'
import { readManifest, writeManifestAtomic } from './video-artifacts.js'
import { VecteezyDownloadClient } from './vecteezy-download.js'
import { VideoProductionApi } from './video-production-api.js'
import {
  planVideo as runPlanVideo,
  produceVideo as runProduceVideo,
  resumeVideo as runResumeVideo,
  type VideoPipelineDependencies,
} from './video-pipeline-runner.js'
import { renderVideo } from './video-renderer.js'

interface VideoCliIo {
  stdout: (message: string) => void
  stderr: (message: string) => void
}

export interface VideoCliOverrides {
  dependencies?: typeof dependenciesFor
  planVideo?: typeof runPlanVideo
  produceVideo?: typeof runProduceVideo
  resumeVideo?: typeof runResumeVideo
}

const defaultIo: VideoCliIo = {
  stdout: message => console.log(message),
  stderr: message => console.error(message),
}

export function createVideoProgram(
  environment: NodeJS.ProcessEnv = process.env,
  io: VideoCliIo = defaultIo,
  overrides: VideoCliOverrides = {},
): Command {
  const dependencyFactory = overrides.dependencies ?? dependenciesFor
  const planVideo = overrides.planVideo ?? runPlanVideo
  const produceVideo = overrides.produceVideo ?? runProduceVideo
  const resumeVideo = overrides.resumeVideo ?? runResumeVideo
  const program = new Command()
    .name('video')
    .description('Plan and run resumable local video production')

  program.command('plan')
    .allowExcessArguments(true)
    .option('--theme <theme>')
    .option('--candidate-count <count>', 'candidate count', integerOption)
    .option('--json', 'emit one path-only JSON object')
    .action(async (options, command: Command) => {
      const configuration = baseConfiguration(environment)
      const jsonMode = options.json === true || environment.npm_config_json === 'true'
      const theme = requiredCliOption(options.theme ?? forwardedText(command.args[0], environment.npm_config_theme), '--theme')
      const candidateCount = forwardedInteger(
        options.candidateCount,
        forwardedText(command.args[1], environment.npm_config_candidate_count),
        8,
      )
      const dependencies = dependencyFactory(configuration, undefined, jsonMode ? io.stderr : io.stdout)
      const result = await planVideo({
        artifactRoot: 'artifacts',
        theme,
        candidateCount,
        writeLatestPlan: jsonMode,
      }, dependencies)
      if (jsonMode) io.stdout(JSON.stringify(result))
    })

  program.command('produce')
    .allowExcessArguments(true)
    .option('--manifest <path>')
    .option('--review <path>')
    .option('--max-downloads <count>', 'hard production download budget', integerOption)
    .action(async (options, command: Command) => {
      const manifestPath = requiredCliOption(options.manifest ?? forwardedText(command.args[0], environment.npm_config_manifest), '--manifest')
      const reviewPath = requiredCliOption(options.review ?? forwardedText(command.args[1], environment.npm_config_review), '--review')
      const maxDownloads = forwardedInteger(
        options.maxDownloads,
        forwardedText(command.args[2], environment.npm_config_max_downloads),
      )
      if (maxDownloads !== 4) throw new Error('--max-downloads must equal 4')
      const configuration = baseConfiguration(environment)
      const vecteezy = vecteezyConfiguration(environment)
      await produceVideo({
        artifactRoot: 'artifacts',
        manifestPath,
        reviewPath,
        maxDownloads,
      }, dependencyFactory(configuration, vecteezy, io.stdout))
    })

  program.command('resume')
    .allowExcessArguments(true)
    .option('--manifest <path>')
    .action(async (options, command: Command) => {
      const manifestPath = requiredCliOption(options.manifest ?? forwardedText(command.args[0], environment.npm_config_manifest), '--manifest')
      const configuration = baseConfiguration(environment)
      const vecteezy = vecteezyConfiguration(environment)
      await resumeVideo({
        artifactRoot: 'artifacts',
        manifestPath,
      }, dependencyFactory(configuration, vecteezy, io.stdout))
    })

  return program
}

export async function runVideoCli(
  argv: string[] = process.argv,
  environment: NodeJS.ProcessEnv = process.env,
  io: VideoCliIo = defaultIo,
): Promise<void> {
  try {
    await createVideoProgram(environment, io).parseAsync(argv)
  } catch (error) {
    io.stderr(publicErrorMessage(error))
    process.exitCode = 1
  }
}

function dependenciesFor(
  configuration: ReturnType<typeof baseConfiguration>,
  vecteezy: ReturnType<typeof vecteezyConfiguration> | undefined,
  output: (message: string) => void,
): VideoPipelineDependencies {
  const apiConfiguration = {
    supabaseUrl: configuration.supabaseUrl,
    publishableKey: configuration.publishableKey,
    personalToken: configuration.personalToken,
  }
  return {
    subtitleApi: new SubtitleApi(apiConfiguration),
    productionApi: new VideoProductionApi(apiConfiguration),
    downloads: vecteezy === undefined
      ? unavailableDownloads()
      : new VecteezyDownloadClient({
          accountId: vecteezy.accountId,
          apiKey: vecteezy.apiKey,
          fetcher: fetch,
        }),
    probeMedia,
    renderVideo,
    readManifest,
    writeManifest: writeManifestAtomic,
    output,
    now: () => new Date().toISOString(),
  }
}

function baseConfiguration(environment: NodeJS.ProcessEnv) {
  return {
    supabaseUrl: requiredEnvironment(environment, 'SUPABASE_URL'),
    publishableKey: requiredEnvironment(environment, 'SUPABASE_PUBLISHABLE_KEY'),
    personalToken: requiredEnvironment(environment, 'SUBTITLE_PERSONAL_TOKEN'),
  }
}

function vecteezyConfiguration(environment: NodeJS.ProcessEnv) {
  return {
    accountId: requiredEnvironment(environment, 'VECTEEZY_ACCOUNT'),
    apiKey: requiredEnvironment(environment, 'VECTEEZY_API_KEY'),
  }
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`)
  return value
}

function integerOption(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('option must be an integer')
  return Number(value)
}

function forwardedInteger(value: unknown, forwarded: string | undefined, fallback?: number): number {
  if (typeof value === 'number') return value
  if (forwarded !== undefined) return integerOption(forwarded)
  if (fallback !== undefined) return fallback
  throw new Error('option must be an integer')
}

function forwardedText(positional: string | undefined, configured: string | undefined): string | undefined {
  return positional !== undefined && positional.trim() !== '' ? positional : configured
}

function requiredCliOption(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`)
  return value
}

function unavailableDownloads(): VecteezyDownloadClient {
  return new Proxy({}, {
    get() {
      return () => Promise.reject(new Error('Vecteezy credentials are required for downloads'))
    },
  }) as VecteezyDownloadClient
}

function publicErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'video command failed'
  if (/^[A-Z][A-Z0-9_]+ is required$/.test(error.message)
    || error.message === '--max-downloads must equal 4'
    || /^--(?:theme|manifest|review) is required$/.test(error.message)
    || error.message === 'option must be an integer'
    || error.message === 'candidate count must be between 5 and 10'
    || error.message === 'invalid video theme'
    || error.message === 'max downloads must equal 4'
    || error.message === 'candidate exceeds local download limit'
    || error.message === 'invalid reviewed video input'
    || error.message === 'review does not match plan'
    || error.message === 'review must be completed before resume'
    || error.message === 'video production failed'
    || error.message === 'video metadata completion failed') {
    return error.message
  }
  return 'video command failed'
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runVideoCli()
}
