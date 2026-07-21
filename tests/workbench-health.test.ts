import { describe, expect, it, vi } from 'vitest'
import {
  OLLAMA_PLAINTEXT_DIALOGUE_WARNING,
  runWorkbenchHealthChecks,
  type HealthCheckId,
  type WorkbenchHealthDependencies,
} from '../src/workbench/health.js'

const gibibyte = 1024 ** 3

describe('workbench health checks', () => {
  it('probes every remote and local dependency without exposing connection details', async () => {
    const dependencies = healthyDependencies()

    const report = await runWorkbenchHealthChecks({
      ollamaModel: 'gemma4:12b',
      minimumDiskFreeBytes: 2 * gibibyte,
      minimumVecteezyQuotaRemaining: 5,
    }, dependencies)

    expect(report.status).toBe('ok')
    expect(report.checks.map(check => [check.id, check.status])).toEqual([
      ['supabase', 'ok'],
      ['ollama', 'ok'],
      ['vecteezy', 'ok'],
      ['ffmpeg', 'ok'],
      ['ffprobe', 'ok'],
      ['font', 'ok'],
      ['disk', 'ok'],
    ])
    expect(report.checks.find(check => check.id === 'ollama')?.details).toEqual({
      model: 'gemma4:12b',
    })
    expect(report.checks.find(check => check.id === 'vecteezy')?.details).toEqual({
      quotaLimit: 500,
      quotaRemaining: 480,
    })
    expect(report.checks.find(check => check.id === 'disk')?.details).toEqual({
      freeBytes: 8 * gibibyte,
    })
    expect(report.warnings).toEqual([{
      code: 'ollama_plaintext_dialogue',
      message: OLLAMA_PLAINTEXT_DIALOGUE_WARNING,
    }])
    expect(OLLAMA_PLAINTEXT_DIALOGUE_WARNING).toMatch(/exact movie dialogue/i)
    expect(OLLAMA_PLAINTEXT_DIALOGUE_WARNING).toMatch(/plaintext/i)
    expect(OLLAMA_PLAINTEXT_DIALOGUE_WARNING).toMatch(/unauthenticated HTTP/i)
    expect(OLLAMA_PLAINTEXT_DIALOGUE_WARNING).toMatch(/internal Ollama/i)

    expect(dependencies.probeSupabase).toHaveBeenCalledOnce()
    expect(dependencies.fetchOllamaTags).toHaveBeenCalledWith(expect.objectContaining({
      path: '/api/tags',
    }))
    expect(dependencies.probeVecteezyAccount).toHaveBeenCalledOnce()
    expect(dependencies.runProcess).toHaveBeenCalledWith(expect.objectContaining({
      command: 'ffmpeg',
      args: ['-version'],
    }))
    expect(dependencies.runProcess).toHaveBeenCalledWith(expect.objectContaining({
      command: 'ffprobe',
      args: ['-version'],
    }))
    expect(dependencies.probeFont).toHaveBeenCalledWith(expect.objectContaining({
      family: 'Microsoft YaHei',
    }))
    expect(dependencies.probeDisk).toHaveBeenCalledOnce()

    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('https://project-secret.supabase.co')
    expect(serialized).not.toContain('VECTEEZY-SECRET-KEY')
    expect(serialized).not.toContain('C:\\private\\artifacts')
  })

  it('reports reachable but constrained dependencies as degraded', async () => {
    const dependencies = healthyDependencies()
    dependencies.probeVecteezyAccount = vi.fn(async () => ({
      active: true,
      quota: { limit: 500, remaining: 3 },
      accountId: '161976',
    }))
    dependencies.probeDisk = vi.fn(async () => ({
      freeBytes: gibibyte,
      path: 'C:\\private\\artifacts',
    }))

    const report = await runWorkbenchHealthChecks({
      ollamaModel: 'gemma4:12b',
      minimumDiskFreeBytes: 2 * gibibyte,
      minimumVecteezyQuotaRemaining: 5,
    }, dependencies)

    expect(report.status).toBe('degraded')
    expect(report.checks.find(check => check.id === 'vecteezy')).toMatchObject({
      status: 'degraded',
      message: 'Download quota is low',
      details: { quotaLimit: 500, quotaRemaining: 3 },
    })
    expect(report.checks.find(check => check.id === 'disk')).toMatchObject({
      status: 'degraded',
      message: 'Disk space is low',
    })
    expect(JSON.stringify(report)).not.toContain('161976')
    expect(JSON.stringify(report)).not.toContain('C:\\private\\artifacts')
  })

  it('reports unavailable required capabilities as errors', async () => {
    const dependencies = healthyDependencies()
    dependencies.fetchOllamaTags = vi.fn(async () => ({
      models: [{ name: 'qwen3:30b' }],
    }))
    dependencies.probeVecteezyAccount = vi.fn(async () => ({
      active: false,
      quota: { limit: 500, remaining: 480 },
    }))
    dependencies.runProcess = vi.fn(async ({ command }) => ({
      exitCode: command === 'ffprobe' ? 1 : 0,
      stdout: '',
      stderr: '',
    }))
    dependencies.probeFont = vi.fn(async () => false)

    const report = await runWorkbenchHealthChecks({ ollamaModel: 'gemma4:12b' }, dependencies)

    expect(report.status).toBe('error')
    expect(report.checks.find(check => check.id === 'ollama')).toMatchObject({
      status: 'error',
      message: 'Configured model is unavailable',
    })
    expect(report.checks.find(check => check.id === 'vecteezy')).toMatchObject({
      status: 'error',
      message: 'Account is unavailable',
    })
    expect(report.checks.find(check => check.id === 'ffprobe')).toMatchObject({
      status: 'error',
      message: 'Executable is unavailable',
    })
    expect(report.checks.find(check => check.id === 'font')).toMatchObject({
      status: 'error',
      message: 'Required font is unavailable',
    })
  })

  it('maps probe failures to controlled errors without leaking provider or filesystem details', async () => {
    const dependencies = healthyDependencies()
    dependencies.probeSupabase = vi.fn(async () => {
      throw new Error('https://project-secret.supabase.co service-role-key')
    })
    dependencies.fetchOllamaTags = vi.fn(async () => {
      throw new Error('http://internal-ollama.local/api/tags RAW MODEL BODY')
    })
    dependencies.probeVecteezyAccount = vi.fn(async () => {
      throw new Error('VECTEEZY-SECRET-KEY account 161976')
    })
    dependencies.runProcess = vi.fn(async ({ command }) => {
      throw new Error(`${command} at C:\\private\\bin\\${command}.exe`)
    })
    dependencies.probeFont = vi.fn(async () => {
      throw new Error('C:\\Windows\\Fonts\\msyh.ttc')
    })
    dependencies.probeDisk = vi.fn(async () => {
      throw new Error('C:\\private\\artifacts')
    })

    const report = await runWorkbenchHealthChecks({ ollamaModel: 'gemma4:12b' }, dependencies)

    expect(report.status).toBe('error')
    expect(report.checks.every(check => check.status === 'error')).toBe(true)
    expect(report.checks.every(check => check.message === 'Probe failed')).toBe(true)
    const serialized = JSON.stringify(report)
    for (const forbidden of [
      'project-secret', 'service-role-key', 'internal-ollama.local', 'RAW MODEL BODY',
      'VECTEEZY-SECRET-KEY', '161976', 'C:\\private', 'C:\\Windows',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it.each<HealthCheckId>([
    'supabase',
    'ollama',
    'vecteezy',
    'ffmpeg',
    'ffprobe',
    'font',
    'disk',
  ])('enforces the independently configured %s timeout and aborts its probe', async checkId => {
    vi.useFakeTimers()
    try {
      let capturedSignal: AbortSignal | undefined
      const dependencies = hangingDependency(checkId, signal => { capturedSignal = signal })
      const reportPromise = runWorkbenchHealthChecks({
        ollamaModel: 'gemma4:12b',
        defaultTimeoutMs: 10_000,
        timeoutMs: { [checkId]: 37 },
      }, dependencies)

      await vi.advanceTimersByTimeAsync(36)
      expect(capturedSignal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)

      const report = await reportPromise
      expect(report.checks.find(check => check.id === checkId)).toMatchObject({
        status: 'error',
        message: 'Probe timed out',
      })
      expect(capturedSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats invalid provider and disk payloads as controlled probe errors', async () => {
    const dependencies = healthyDependencies()
    dependencies.fetchOllamaTags = vi.fn(async () => ({ models: 'not-an-array' }))
    dependencies.probeVecteezyAccount = vi.fn(async () => ({
      active: true,
      quota: { limit: 10, remaining: 11 },
    }))
    dependencies.probeDisk = vi.fn(async () => ({ freeBytes: -1 }))

    const report = await runWorkbenchHealthChecks({ ollamaModel: 'gemma4:12b' }, dependencies)

    expect(report.checks.find(check => check.id === 'ollama')?.message).toBe('Probe failed')
    expect(report.checks.find(check => check.id === 'vecteezy')?.message).toBe('Probe failed')
    expect(report.checks.find(check => check.id === 'disk')?.message).toBe('Probe failed')
  })
})

function healthyDependencies(): WorkbenchHealthDependencies & Record<string, ReturnType<typeof vi.fn>> {
  return {
    probeSupabase: vi.fn(async () => ({
      url: 'https://project-secret.supabase.co',
    })),
    fetchOllamaTags: vi.fn(async () => ({
      models: [{ name: 'gemma4:12b', model: 'gemma4:12b' }],
      endpoint: 'http://internal-ollama.local/api/tags',
    })),
    probeVecteezyAccount: vi.fn(async () => ({
      active: true,
      quota: { limit: 500, remaining: 480 },
      accountId: '161976',
      key: 'VECTEEZY-SECRET-KEY',
    })),
    runProcess: vi.fn(async ({ command }) => ({
      exitCode: 0,
      stdout: `${command} version at C:\\private\\bin`,
      stderr: '',
    })),
    probeFont: vi.fn(async () => ({
      available: true,
      path: 'C:\\Windows\\Fonts\\msyh.ttc',
    })),
    probeDisk: vi.fn(async () => ({
      freeBytes: 8 * gibibyte,
      path: 'C:\\private\\artifacts',
    })),
  }
}

function hangingDependency(
  checkId: HealthCheckId,
  capture: (signal: AbortSignal) => void,
): WorkbenchHealthDependencies {
  const dependencies = healthyDependencies()
  const hang = (signal: AbortSignal): Promise<never> => {
    capture(signal)
    return new Promise(() => undefined)
  }

  if (checkId === 'supabase') dependencies.probeSupabase = vi.fn(({ signal }) => hang(signal))
  if (checkId === 'ollama') dependencies.fetchOllamaTags = vi.fn(({ signal }) => hang(signal))
  if (checkId === 'vecteezy') dependencies.probeVecteezyAccount = vi.fn(({ signal }) => hang(signal))
  if (checkId === 'font') dependencies.probeFont = vi.fn(({ signal }) => hang(signal))
  if (checkId === 'disk') dependencies.probeDisk = vi.fn(({ signal }) => hang(signal))
  if (checkId === 'ffmpeg' || checkId === 'ffprobe') {
    const runProcess = dependencies.runProcess
    dependencies.runProcess = vi.fn(input => input.command === checkId
      ? hang(input.signal)
      : runProcess(input))
  }
  return dependencies
}
