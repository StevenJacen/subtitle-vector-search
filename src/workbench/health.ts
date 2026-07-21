export const OLLAMA_PLAINTEXT_DIALOGUE_WARNING =
  'Exact movie dialogue is sent in plaintext over unauthenticated HTTP to the internal Ollama service.'

export type HealthStatus = 'ok' | 'degraded' | 'error'

export type HealthCheckId =
  | 'supabase'
  | 'ollama'
  | 'vecteezy'
  | 'ffmpeg'
  | 'ffprobe'
  | 'font'
  | 'disk'

export interface HealthCheckDetails {
  model?: string
  quotaLimit?: number | null
  quotaRemaining?: number | null
  freeBytes?: number
}

export interface WorkbenchHealthCheck {
  id: HealthCheckId
  status: HealthStatus
  message: string
  details?: HealthCheckDetails
}

export interface WorkbenchHealthReport {
  status: HealthStatus
  checks: WorkbenchHealthCheck[]
  warnings: Array<{
    code: 'ollama_plaintext_dialogue'
    message: string
  }>
}

interface AbortableProbeInput {
  signal: AbortSignal
}

export interface OllamaTagsProbeInput extends AbortableProbeInput {
  path: '/api/tags'
}

export interface ProcessProbeInput extends AbortableProbeInput {
  command: 'ffmpeg' | 'ffprobe'
  args: readonly ['-version']
}

export interface FontProbeInput extends AbortableProbeInput {
  family: 'Microsoft YaHei'
}

export interface WorkbenchHealthDependencies {
  probeSupabase(input: AbortableProbeInput): Promise<unknown>
  fetchOllamaTags(input: OllamaTagsProbeInput): Promise<unknown>
  probeVecteezyAccount(input: AbortableProbeInput): Promise<unknown>
  runProcess(input: ProcessProbeInput): Promise<unknown>
  probeFont(input: FontProbeInput): Promise<unknown>
  probeDisk(input: AbortableProbeInput): Promise<unknown>
}

export interface WorkbenchHealthConfiguration {
  ollamaModel: string
  defaultTimeoutMs?: number
  timeoutMs?: Partial<Record<HealthCheckId, number>>
  minimumDiskFreeBytes?: number
  minimumVecteezyQuotaRemaining?: number
}

const checkOrder: readonly HealthCheckId[] = [
  'supabase',
  'ollama',
  'vecteezy',
  'ffmpeg',
  'ffprobe',
  'font',
  'disk',
]

const defaultTimeoutMs = 5_000
const defaultMinimumDiskFreeBytes = 2 * 1024 ** 3
const defaultMinimumVecteezyQuotaRemaining = 5

export async function runWorkbenchHealthChecks(
  configuration: WorkbenchHealthConfiguration,
  dependencies: WorkbenchHealthDependencies,
): Promise<WorkbenchHealthReport> {
  const settings = normalizeConfiguration(configuration)
  const operations: Record<HealthCheckId, (signal: AbortSignal) => Promise<WorkbenchHealthCheck>> = {
    supabase: signal => probeSupabase(dependencies, signal),
    ollama: signal => probeOllama(dependencies, signal, settings.ollamaModel),
    vecteezy: signal => probeVecteezy(
      dependencies,
      signal,
      settings.minimumVecteezyQuotaRemaining,
    ),
    ffmpeg: signal => probeExecutable(dependencies, signal, 'ffmpeg'),
    ffprobe: signal => probeExecutable(dependencies, signal, 'ffprobe'),
    font: signal => probeRequiredFont(dependencies, signal),
    disk: signal => probeDisk(dependencies, signal, settings.minimumDiskFreeBytes),
  }

  const checks = await Promise.all(checkOrder.map(id => runControlledProbe(
    id,
    settings.timeoutMs[id] ?? settings.defaultTimeoutMs,
    operations[id],
  )))

  return {
    status: overallStatus(checks),
    checks,
    warnings: [{
      code: 'ollama_plaintext_dialogue',
      message: OLLAMA_PLAINTEXT_DIALOGUE_WARNING,
    }],
  }
}

async function probeSupabase(
  dependencies: WorkbenchHealthDependencies,
  signal: AbortSignal,
): Promise<WorkbenchHealthCheck> {
  await dependencies.probeSupabase({ signal })
  return check('supabase', 'ok', 'Connected')
}

async function probeOllama(
  dependencies: WorkbenchHealthDependencies,
  signal: AbortSignal,
  model: string,
): Promise<WorkbenchHealthCheck> {
  const payload = record(await dependencies.fetchOllamaTags({ path: '/api/tags', signal }))
  if (!Array.isArray(payload.models)) throw new Error('invalid Ollama tags payload')
  const models = payload.models.map(modelEntry).filter((value): value is string => value !== null)
  if (models.length !== payload.models.length) throw new Error('invalid Ollama tags payload')

  return models.includes(model)
    ? check('ollama', 'ok', 'Configured model is available', { model })
    : check('ollama', 'error', 'Configured model is unavailable', { model })
}

async function probeVecteezy(
  dependencies: WorkbenchHealthDependencies,
  signal: AbortSignal,
  minimumRemaining: number,
): Promise<WorkbenchHealthCheck> {
  const payload = record(await dependencies.probeVecteezyAccount({ signal }))
  if (typeof payload.active !== 'boolean') throw new Error('invalid Vecteezy account payload')
  if (!payload.active) return check('vecteezy', 'error', 'Account is unavailable')

  const quota = record(payload.quota)
  const quotaLimit = nullableNonnegativeInteger(quota.limit)
  const quotaRemaining = nullableNonnegativeInteger(quota.remaining)
  if (quotaLimit === invalidNumber || quotaRemaining === invalidNumber
    || (typeof quotaLimit === 'number'
      && typeof quotaRemaining === 'number'
      && quotaRemaining > quotaLimit)) {
    throw new Error('invalid Vecteezy quota payload')
  }
  const details = { quotaLimit, quotaRemaining }
  if (quotaRemaining === null) {
    return check('vecteezy', 'degraded', 'Download quota is unavailable', details)
  }
  if (quotaRemaining < minimumRemaining) {
    return check('vecteezy', 'degraded', 'Download quota is low', details)
  }
  return check('vecteezy', 'ok', 'Account and quota are available', details)
}

async function probeExecutable(
  dependencies: WorkbenchHealthDependencies,
  signal: AbortSignal,
  command: 'ffmpeg' | 'ffprobe',
): Promise<WorkbenchHealthCheck> {
  const payload = record(await dependencies.runProcess({ command, args: ['-version'], signal }))
  if (!Number.isSafeInteger(payload.exitCode)) throw new Error('invalid process result')
  return payload.exitCode === 0
    ? check(command, 'ok', 'Executable is available')
    : check(command, 'error', 'Executable is unavailable')
}

async function probeRequiredFont(
  dependencies: WorkbenchHealthDependencies,
  signal: AbortSignal,
): Promise<WorkbenchHealthCheck> {
  const payload = await dependencies.probeFont({ family: 'Microsoft YaHei', signal })
  const available = typeof payload === 'boolean'
    ? payload
    : record(payload).available
  if (typeof available !== 'boolean') throw new Error('invalid font result')
  return available
    ? check('font', 'ok', 'Required font is available')
    : check('font', 'error', 'Required font is unavailable')
}

async function probeDisk(
  dependencies: WorkbenchHealthDependencies,
  signal: AbortSignal,
  minimumFreeBytes: number,
): Promise<WorkbenchHealthCheck> {
  const payload = record(await dependencies.probeDisk({ signal }))
  if (!isNonnegativeInteger(payload.freeBytes)) throw new Error('invalid disk result')
  const details = { freeBytes: payload.freeBytes }
  return payload.freeBytes < minimumFreeBytes
    ? check('disk', 'degraded', 'Disk space is low', details)
    : check('disk', 'ok', 'Disk space is available', details)
}

async function runControlledProbe(
  id: HealthCheckId,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<WorkbenchHealthCheck>,
): Promise<WorkbenchHealthCheck> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(timeoutMarker)
    }, timeoutMs)
  })

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      timeout,
    ])
  } catch (error) {
    return error === timeoutMarker
      ? check(id, 'error', 'Probe timed out')
      : check(id, 'error', 'Probe failed')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function normalizeConfiguration(configuration: WorkbenchHealthConfiguration): Required<
  Omit<WorkbenchHealthConfiguration, 'timeoutMs'>
> & { timeoutMs: Partial<Record<HealthCheckId, number>> } {
  if (!/^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/.test(configuration.ollamaModel)) {
    throw new Error('invalid health configuration')
  }
  const normalized = {
    ollamaModel: configuration.ollamaModel,
    defaultTimeoutMs: configuration.defaultTimeoutMs ?? defaultTimeoutMs,
    timeoutMs: configuration.timeoutMs ?? {},
    minimumDiskFreeBytes: configuration.minimumDiskFreeBytes ?? defaultMinimumDiskFreeBytes,
    minimumVecteezyQuotaRemaining: configuration.minimumVecteezyQuotaRemaining
      ?? defaultMinimumVecteezyQuotaRemaining,
  }
  if (!isPositiveInteger(normalized.defaultTimeoutMs)
    || !isNonnegativeInteger(normalized.minimumDiskFreeBytes)
    || !isNonnegativeInteger(normalized.minimumVecteezyQuotaRemaining)
    || Object.entries(normalized.timeoutMs).some(([id, value]) => (
      !checkOrder.includes(id as HealthCheckId) || !isPositiveInteger(value)
    ))) {
    throw new Error('invalid health configuration')
  }
  return normalized
}

function check(
  id: HealthCheckId,
  status: HealthStatus,
  message: string,
  details?: HealthCheckDetails,
): WorkbenchHealthCheck {
  return {
    id,
    status,
    message,
    ...(details === undefined ? {} : { details }),
  }
}

function overallStatus(checks: readonly WorkbenchHealthCheck[]): HealthStatus {
  if (checks.some(check => check.status === 'error')) return 'error'
  if (checks.some(check => check.status === 'degraded')) return 'degraded'
  return 'ok'
}

function modelEntry(value: unknown): string | null {
  const entry = record(value)
  if (typeof entry.name === 'string' && entry.name !== '') return entry.name
  if (typeof entry.model === 'string' && entry.model !== '') return entry.model
  return null
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid probe result')
  return value as Record<string, unknown>
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0
}

const invalidNumber = Symbol('invalid number')

function nullableNonnegativeInteger(value: unknown): number | null | typeof invalidNumber {
  if (value === null) return null
  return isNonnegativeInteger(value) ? value : invalidNumber
}

const timeoutMarker = Symbol('health probe timeout')
