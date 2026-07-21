import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type DownloadModule = typeof import('../src/vecteezy-download.js')

let FormalDownloadBudget: DownloadModule['FormalDownloadBudget']
let VecteezyDownloadClient: DownloadModule['VecteezyDownloadClient']
let VecteezyDownloadError: DownloadModule['VecteezyDownloadError']

beforeEach(async () => {
  vi.resetModules()
  ;({ FormalDownloadBudget, VecteezyDownloadClient, VecteezyDownloadError } = await import('../src/vecteezy-download.js'))
})

const credentials = { accountId: '161976', apiKey: 'secret' }
const MiB = 1024 * 1024
const SAFE_STATUS_URL = 'https://api.vecteezy.com/v2/161976/downloads/status/private-ticket'
const PRIVATE_STATUS_URL = 'https://api.vecteezy.com/v2/161976/downloads/status/private-ticket?signature=synthetic-secret'

function downloadInfo(size: number | string, headers: HeadersInit = {}): Response {
  return Response.json({
    data: {
      file_size: size,
      requires_attribution: true,
      required_attribution_url: 'https://attribution.test/license',
    },
  }, { headers })
}

function formalDownload(statusUrl = SAFE_STATUS_URL): Response {
  return Response.json({ data: { download_status_url: statusUrl } })
}

function providerJson(body: unknown | (() => unknown)): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: vi.fn(async () => typeof body === 'function' ? body() : body),
  } as unknown as Response
}

function expectRedactedProviderPayloadError(error: unknown, privateUrl: string): void {
  expect(error).toBeInstanceOf(VecteezyDownloadError)
  expect(error).toMatchObject({
    code: 'invalid_provider_payload',
    message: 'Vecteezy provider payload is invalid',
  })
  expect(String(error)).not.toContain(privateUrl)
  expect(String(error)).not.toContain(credentials.apiKey)
}

function client(
  fetcher: (...args: any[]) => Promise<Response>,
  overrides: Record<string, unknown> = {},
): InstanceType<DownloadModule['VecteezyDownloadClient']> {
  return new VecteezyDownloadClient({ ...credentials, fetcher: fetcher as typeof fetch, ...overrides })
}

function storage() {
  const files = new Map<string, Buffer>()
  const renames: Array<[string, string]> = []
  const readFile = vi.fn(async (path: string) => files.get(path) ?? Buffer.alloc(0))

  return {
    files,
    renames,
    readFile,
    fileOperations: {
      createWriteStream(path: string) {
        const chunks: Buffer[] = []
        return new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk))
            callback()
          },
          final(callback) {
            files.set(path, Buffer.concat(chunks))
            callback()
          },
        })
      },
      async rename(from: string, to: string) {
        const content = files.get(from)
        if (content === undefined) throw new Error('missing part file')
        files.delete(from)
        files.set(to, content)
        renames.push([from, to])
      },
      async rm(path: string) {
        files.delete(path)
      },
      readFile,
    },
  }
}

describe('Vecteezy formal downloads', () => {
  it('uses the exact read-only size endpoint before the formal download endpoint', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(downloadInfo('123'))
      .mockResolvedValueOnce(formalDownload())
    const budget = new FormalDownloadBudget(4)

    const requested = await client(fetcher).requestDownload(42, budget)

    expect(String(fetcher.mock.calls[0][0])).toBe(
      'https://api.vecteezy.com/v2/161976/resources/42/download_info?file_type=mp4',
    )
    expect(String(fetcher.mock.calls[1][0])).toBe(
      'https://api.vecteezy.com/v2/161976/resources/42/download?file_type=mp4',
    )
    expect(fetcher.mock.calls[1][1].headers.authorization).toBe('Bearer secret')
    expect(String(fetcher.mock.calls[0][0])).not.toContain('file_size=')
    expect(String(fetcher.mock.calls[1][0])).not.toContain('file_size=')
    expect(requested).toMatchObject({ resourceId: 42, sourceSizeBytes: 123 })
    expect(JSON.stringify(requested)).not.toContain('status.test')
  })

  it('blocks redirects on every authenticated provider fetch', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(downloadInfo(5))
      .mockResolvedValueOnce(formalDownload())
      .mockResolvedValueOnce(Response.json({ data: { progress: 100, url: 'https://signed.test/ready-secret' } }))
    const downloadClient = client(fetcher)
    const requested = await downloadClient.requestDownload(42, new FormalDownloadBudget(4))

    await downloadClient.waitForDownload(requested)

    expect(fetcher).toHaveBeenCalledTimes(3)
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({
        redirect: 'error',
        headers: { authorization: `Bearer ${credentials.apiKey}` },
      })
    }
  })

  it.each([
    'https://attacker.test/private-status',
    'http://api.vecteezy.com/v2/161976/downloads/status/private-ticket',
    'not a URL',
    'https://api-user:secret@api.vecteezy.com/v2/161976/downloads/status/private-ticket',
  ])('rejects an unsafe formal status URL before it can receive credentials: %s', async statusUrl => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(downloadInfo(5))
      .mockResolvedValueOnce(formalDownload(statusUrl))

    const error = await client(fetcher).requestDownload(42, new FormalDownloadBudget(4)).catch(error => error)

    expect(error).toMatchObject({ code: 'invalid_download_status_url' })
    expect(String(error)).not.toContain(statusUrl)
    expect(String(error)).not.toContain(credentials.apiKey)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.some(([url]) => String(url) === statusUrl)).toBe(false)
    expect(fetcher.mock.calls.every(([, init]) => init.headers.authorization === `Bearer ${credentials.apiKey}`)).toBe(true)
  })

  it('normalizes integer sizes and download quota headers', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(downloadInfo('123', {
        'x-ratelimit-limit': '40',
        'x-ratelimit-remaining': '39',
      }))
      .mockResolvedValueOnce(formalDownload())

    const requested = await client(fetcher).requestDownload(42, new FormalDownloadBudget(4))

    expect(requested).toMatchObject({
      sourceSizeBytes: 123,
      quota: { limit: 40, remaining: 39 },
      requiresAttribution: true,
      requiredAttributionUrl: 'https://attribution.test/license',
    })
  })

  it.each([0, -1, 1.5, '12.5', 'bad', null])('rejects malformed provider file sizes: %j', async size => {
    const fetcher = vi.fn().mockResolvedValue(downloadInfo(size as number | string))

    await expect(client(fetcher).getDownloadInfo(42)).rejects.toMatchObject({ code: 'invalid_provider_payload' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('redacts a rejected provider JSON body while reading download info', async () => {
    const fetcher = vi.fn().mockResolvedValue(providerJson(() => {
      throw new Error(`failed to parse ${PRIVATE_STATUS_URL} with ${credentials.apiKey}`)
    }))

    const error = await client(fetcher).getDownloadInfo(42).catch(error => error)

    expectRedactedProviderPayloadError(error, PRIVATE_STATUS_URL)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('redacts a malformed provider shape while reading the formal download response', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(downloadInfo(5))
      .mockResolvedValueOnce(providerJson({ data: [] }))

    const error = await client(fetcher).requestDownload(42, new FormalDownloadBudget(4)).catch(error => error)

    expectRedactedProviderPayloadError(error, PRIVATE_STATUS_URL)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('redacts a rejected provider JSON body while reading the formal download response', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(downloadInfo(5))
      .mockResolvedValueOnce(providerJson(() => {
        throw new Error(`failed to parse ${PRIVATE_STATUS_URL} with ${credentials.apiKey}`)
      }))

    const error = await client(fetcher).requestDownload(42, new FormalDownloadBudget(4)).catch(error => error)

    expectRedactedProviderPayloadError(error, PRIVATE_STATUS_URL)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([401, 402, 403, 404, 422])('does not retry provider %i responses', async status => {
    const fetcher = vi.fn().mockResolvedValue(new Response('provider message', { status }))

    await expect(client(fetcher).getDownloadInfo(42)).rejects.toMatchObject({ code: `provider_${status}` })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects a provider 4xx formal response without retrying it', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(downloadInfo(123))
      .mockResolvedValueOnce(new Response('provider message', { status: 403 }))

    await expect(client(fetcher).requestDownload(42, new FormalDownloadBudget(4)))
      .rejects.toMatchObject({ code: 'provider_403' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('rejects a file over 512 MiB before the formal download request', async () => {
    const fetcher = vi.fn().mockResolvedValue(downloadInfo(512 * MiB + 1))

    await expect(client(fetcher).requestDownload(42, new FormalDownloadBudget(4)))
      .rejects.toMatchObject({ code: 'file_size_limit_exceeded' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects downloads that would exceed the 2 GiB aggregate limit', async () => {
    const fetcher = vi.fn(url => String(url).includes('/download_info')
      ? Promise.resolve(downloadInfo(511 * MiB))
      : Promise.resolve(formalDownload()))
    const downloadClient = client(fetcher)
    const budget = new FormalDownloadBudget(4)

    for (const id of [1, 2, 3, 4]) {
      await downloadClient.requestDownload(id, budget)
    }

    await expect(downloadClient.requestDownload(5, budget))
      .rejects.toMatchObject({ code: 'aggregate_size_limit_exceeded' })
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/download'))).toHaveLength(9)
    expect(budget.used).toBe(4)
  })

  it('retains the v1 default and maximum of four formal downloads', () => {
    const budget = new FormalDownloadBudget()

    expect(budget.maximum).toBe(4)
    expect(budget.used).toBe(0)
    expect(budget.remaining).toBe(4)
  })

  it.each([5, 10])('allows a v2 formal download limit of %i', maximum => {
    const budget = new FormalDownloadBudget(maximum)

    expect(budget.maximum).toBe(maximum)
    expect(budget.remaining).toBe(maximum)
  })

  it.each([11, Number.MAX_SAFE_INTEGER])('rejects a configured maximum above ten: %i', maximum => {
    expect(() => new FormalDownloadBudget(maximum)).toThrow('formal download maximum cannot exceed ten')
  })

  it('makes reservation IDs process-wide and idempotent across budget instances', () => {
    const firstBudget = new FormalDownloadBudget(5)
    const secondBudget = new FormalDownloadBudget(5)

    firstBudget.reserve('10000000-0000-4000-8000-000000000001')
    secondBudget.reserve('10000000-0000-4000-8000-000000000001')
    secondBudget.reserve('10000000-0000-4000-8000-000000000002')

    expect(firstBudget.used).toBe(2)
    expect(secondBudget.used).toBe(2)
    expect(firstBudget.remaining).toBe(3)
    expect(secondBudget.remaining).toBe(3)
  })

  it('cannot reuse an idempotent reservation to start a second formal provider call', async () => {
    const budget = new FormalDownloadBudget(5)
    const info = {
      resourceId: 42,
      sourceSizeBytes: 123,
      requiresAttribution: false,
      requiredAttributionUrl: null,
      quota: { limit: null, remaining: null },
    }
    const fetcher = vi.fn().mockResolvedValue(formalDownload())
    const downloadClient = client(fetcher)
    const reservationId = '10000000-0000-4000-8000-000000000001'

    await downloadClient.requestDownloadWithInfo(info, budget, reservationId)
    await expect(downloadClient.requestDownloadWithInfo(info, budget, reservationId))
      .rejects.toMatchObject({ code: 'formal_reservation_reused' })

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(budget.used).toBe(1)
  })

  it('seeds verified resume bytes into a new client aggregate before a formal request', async () => {
    const fetcher = vi.fn().mockResolvedValue(formalDownload())
    const downloadClient = client(fetcher)
    downloadClient.seedAggregateSizeBytes(2 * 1024 * MiB)
    const info = {
      resourceId: 42,
      sourceSizeBytes: 1,
      requiresAttribution: false,
      requiredAttributionUrl: null,
      quota: { limit: null, remaining: null },
    }

    await expect(downloadClient.requestDownloadWithInfo(
      info,
      new FormalDownloadBudget(5),
      '10000000-0000-4000-8000-000000000001',
    )).rejects.toMatchObject({ code: 'aggregate_size_limit_exceeded' })

    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reserves synchronously under concurrent scheduling without exceeding the process limit', async () => {
    const budget = new FormalDownloadBudget(5)
    const attempts = Array.from({ length: 6 }, (_, index) => Promise.resolve().then(() => {
      budget.reserve(`10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)
    }))

    const results = await Promise.allSettled(attempts)

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(5)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(budget.used).toBe(5)
    expect(budget.remaining).toBe(0)
  })

  it('shares formal usage across budget instances and rejects the fifth request', async () => {
    const firstBudget = new FormalDownloadBudget(4)
    const secondBudget = new FormalDownloadBudget(4)
    const fetcher = vi.fn((url: string) => url.includes('/download_info')
      ? Promise.resolve(downloadInfo(123))
      : Promise.resolve(formalDownload()))
    const downloadClient = client(fetcher)

    await Promise.all([
      downloadClient.requestDownload(1, firstBudget),
      downloadClient.requestDownload(2, firstBudget),
      downloadClient.requestDownload(3, secondBudget),
      downloadClient.requestDownload(4, secondBudget),
    ])

    await expect(downloadClient.requestDownload(5, secondBudget))
      .rejects.toMatchObject({ code: 'download_budget_exhausted' })
    expect(firstBudget.used).toBe(4)
    expect(secondBudget.used).toBe(4)
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/download?file_type=mp4'))).toHaveLength(4)
  })

  it('makes each synchronous reservation visible before its concurrent fetch starts', async () => {
    const budget = new FormalDownloadBudget(4)
    let releaseFormalFetch!: () => void
    const formalFetchGate = new Promise<void>(resolve => {
      releaseFormalFetch = resolve
    })
    const usedWhenFormalFetchStarted: number[] = []
    const fetcher = vi.fn((url: string) => {
      if (url.includes('/download_info')) return Promise.resolve(downloadInfo(123))
      usedWhenFormalFetchStarted.push(budget.used)
      return formalFetchGate.then(() => formalDownload())
    })
    const downloadClient = client(fetcher)

    const requests = [1, 2, 3, 4].map(id => downloadClient.requestDownload(id, budget))
    await vi.waitFor(() => expect(usedWhenFormalFetchStarted).toHaveLength(4))
    expect(usedWhenFormalFetchStarted).toEqual([1, 2, 3, 4])
    releaseFormalFetch()
    await Promise.all(requests)

    await expect(downloadClient.requestDownload(5, budget))
      .rejects.toMatchObject({ code: 'download_budget_exhausted' })
    expect(budget.used).toBe(4)
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/download?file_type=mp4'))).toHaveLength(4)
  })
})

describe('Vecteezy signed transfers', () => {
  it('uses an immediate signed URL without polling and returns only completed local metadata', async () => {
    const disk = storage()
    const logs: string[] = []
    const fetcher = vi.fn()
      .mockResolvedValueOnce(downloadInfo(5))
      .mockResolvedValueOnce(Response.json({ data: { url: 'https://signed.test/immediate-secret' } }))
      .mockResolvedValueOnce(new Response('video'))
    const downloadClient = client(fetcher, { fileOperations: disk.fileOperations, logger: (value: string) => logs.push(value) })
    const requested = await downloadClient.requestDownload(42, new FormalDownloadBudget(4))
    const ready = await downloadClient.waitForDownload(requested)

    const transferResult = await downloadClient.transferSignedUrl(ready, 'assets/42.mp4')

    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(disk.renames).toEqual([['assets/42.mp4.part', 'assets/42.mp4']])
    expect(disk.readFile).not.toHaveBeenCalled()
    expect(transferResult).toMatchObject({
      artifactKey: 'assets/42.mp4',
      sourceSizeBytes: 5,
      sourceSha256: createHash('sha256').update('video').digest('hex'),
      requiresAttribution: true,
      requiredAttributionUrl: 'https://attribution.test/license',
    })
    const serialized = JSON.stringify(transferResult)
    expect(serialized).not.toContain('signed.test')
    expect(serialized).not.toMatch(/download_status_url|inline_url|\"url\"/)
    expect(logs.join('\n')).not.toContain('signed.test')
  })

  it('stops a signed transfer when actual bytes exceed the per-file hard limit', async () => {
    const disk = storage()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(downloadInfo(5))
      .mockResolvedValueOnce(Response.json({ data: { url: 'https://signed.test/oversized-secret' } }))
      .mockResolvedValueOnce(new Response('123456'))
    const downloadClient = client(fetcher, {
      fileOperations: disk.fileOperations,
      maxFileSizeBytes: 5,
    })
    const requested = await downloadClient.requestDownload(42, new FormalDownloadBudget(4))
    const ready = await downloadClient.waitForDownload(requested)

    await expect(downloadClient.transferSignedUrl(ready, 'assets/oversized.mp4'))
      .rejects.toMatchObject({ code: 'file_size_limit_exceeded' })

    expect(disk.files.has('assets/oversized.mp4.part')).toBe(false)
    expect(disk.renames).toEqual([])
    expect(disk.readFile).not.toHaveBeenCalled()
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('oversized-secret'))).toHaveLength(1)
  })

  it('counts actual streamed bytes against the aggregate hard limit', async () => {
    const disk = storage()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(downloadInfo(4))
      .mockResolvedValueOnce(Response.json({ data: { url: 'https://signed.test/first-secret' } }))
      .mockResolvedValueOnce(downloadInfo(4))
      .mockResolvedValueOnce(Response.json({ data: { url: 'https://signed.test/second-secret' } }))
      .mockResolvedValueOnce(new Response('123456'))
    const downloadClient = client(fetcher, {
      fileOperations: disk.fileOperations,
      maxFileSizeBytes: 8,
      maxAggregateSizeBytes: 8,
    })
    const budget = new FormalDownloadBudget(4)
    const first = await downloadClient.requestDownload(41, budget)
    await downloadClient.requestDownload(42, budget)
    const ready = await downloadClient.waitForDownload(first)

    await expect(downloadClient.transferSignedUrl(ready, 'assets/aggregate.mp4'))
      .rejects.toMatchObject({ code: 'aggregate_size_limit_exceeded' })

    expect(disk.files.has('assets/aggregate.mp4.part')).toBe(false)
    expect(disk.renames).toEqual([])
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('first-secret'))).toHaveLength(1)
  })

  it('polls status to 100% and retries transfer with the same in-memory signed URL', async () => {
    const disk = storage()
    const delay = vi.fn(async (_milliseconds: number) => undefined)
    const fetcher = vi.fn()
      .mockResolvedValueOnce(downloadInfo(5))
      .mockResolvedValueOnce(formalDownload())
      .mockResolvedValueOnce(Response.json({ data: { progress: 50 } }))
      .mockResolvedValueOnce(Response.json({ data: { progress: 100, url: 'https://signed.test/reused-secret' } }))
      .mockResolvedValueOnce(new Response('temporary failure', { status: 503 }))
      .mockResolvedValueOnce(new Response('video'))
    const downloadClient = client(fetcher, { delay, fileOperations: disk.fileOperations })
    const requested = await downloadClient.requestDownload(42, new FormalDownloadBudget(4))
    const ready = await downloadClient.waitForDownload(requested)

    await downloadClient.transferSignedUrl(ready, 'assets/retried.mp4')

    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/download?file_type=mp4'))).toHaveLength(1)
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('signed.test/reused-secret'))).toHaveLength(2)
    expect(delay.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([1000, 500])
    expect(delay.mock.calls.every(([milliseconds]) => milliseconds <= 1000)).toBe(true)
  })

  it('sends credentials only to the exact approved status URL and redacts rejected status JSON', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(downloadInfo(5))
      .mockResolvedValueOnce(formalDownload(PRIVATE_STATUS_URL))
      .mockResolvedValueOnce(providerJson(() => {
        throw new Error(`status JSON failed at ${PRIVATE_STATUS_URL} using ${credentials.apiKey}`)
      }))
    const downloadClient = client(fetcher)
    const requested = await downloadClient.requestDownload(42, new FormalDownloadBudget(4))

    const error = await downloadClient.waitForDownload(requested).catch(error => error)

    expect(fetcher.mock.calls[2][0]).toBe(PRIVATE_STATUS_URL)
    expect(fetcher.mock.calls[2][1].headers.authorization).toBe(`Bearer ${credentials.apiKey}`)
    expect(fetcher.mock.calls.some(([url]) => String(url) === 'https://attacker.test/private-status')).toBe(false)
    expectRedactedProviderPayloadError(error, PRIVATE_STATUS_URL)
  })

  it('redacts provider-data structural failures while polling download status', async () => {
    const structuralPayload = new Proxy({}, {
      has: (_target, key) => key === 'data',
      get: () => {
        throw new Error(`provider structure exposed ${PRIVATE_STATUS_URL} and ${credentials.apiKey}`)
      },
    })
    const fetcher = vi.fn()
      .mockResolvedValueOnce(downloadInfo(5))
      .mockResolvedValueOnce(formalDownload(PRIVATE_STATUS_URL))
      .mockResolvedValueOnce(providerJson(structuralPayload))
    const downloadClient = client(fetcher)
    const requested = await downloadClient.requestDownload(42, new FormalDownloadBudget(4))

    const error = await downloadClient.waitForDownload(requested).catch(error => error)

    expectRedactedProviderPayloadError(error, PRIVATE_STATUS_URL)
    await expect(downloadClient.waitForDownload(requested))
      .rejects.toMatchObject({ code: 'invalid_download_request' })
  })

  it('uses an inline URL from a completed status payload', async () => {
    const disk = storage()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(downloadInfo(5))
      .mockResolvedValueOnce(formalDownload())
      .mockResolvedValueOnce(Response.json({ data: { progress: 100, inline_url: 'https://signed.test/inline-secret' } }))
      .mockResolvedValueOnce(new Response('video'))
    const downloadClient = client(fetcher, { fileOperations: disk.fileOperations, delay: vi.fn(async (_milliseconds: number) => undefined) })
    const requested = await downloadClient.requestDownload(42, new FormalDownloadBudget(4))

    const ready = await downloadClient.waitForDownload(requested)
    await downloadClient.transferSignedUrl(ready, 'assets/inline.mp4')

    expect(fetcher.mock.calls[3][0]).toBe('https://signed.test/inline-secret')
  })

  it.each([401, 403, 404, 422])('treats signed-URL HTTP %i as terminal after one attempt', async status => {
    const disk = storage()
    const delay = vi.fn(async (_milliseconds: number) => undefined)
    const signedUrl = `https://signed.test/terminal-${status}`
    const fetcher = vi.fn()
      .mockResolvedValueOnce(downloadInfo(5))
      .mockResolvedValueOnce(Response.json({ data: { url: signedUrl } }))
      .mockResolvedValueOnce(new Response('terminal signed response', { status }))
    const downloadClient = client(fetcher, { delay, fileOperations: disk.fileOperations })
    const requested = await downloadClient.requestDownload(42, new FormalDownloadBudget(4))
    const ready = await downloadClient.waitForDownload(requested)

    const error = await downloadClient.transferSignedUrl(ready, `assets/terminal-${status}.mp4`).catch(error => error)

    expect(error).toMatchObject({ code: 'transfer_failed' })
    expect(String(error)).not.toContain(signedUrl)
    expect(fetcher.mock.calls.filter(([url]) => String(url) === signedUrl)).toHaveLength(1)
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/download?file_type=mp4'))).toHaveLength(1)
    expect(delay).not.toHaveBeenCalled()
    expect(disk.files.has(`assets/terminal-${status}.mp4.part`)).toBe(false)
    await expect(downloadClient.transferSignedUrl(ready, `assets/terminal-${status}.mp4`))
      .rejects.toMatchObject({ code: 'invalid_download_request' })
  })

  it('retries network and 5xx failures only against the same signed URL', async () => {
    const disk = storage()
    const delay = vi.fn(async (_milliseconds: number) => undefined)
    const signedUrl = 'https://signed.test/retry-private-secret'
    const fetcher = vi.fn()
      .mockResolvedValueOnce(downloadInfo(5))
      .mockResolvedValueOnce(Response.json({ data: { url: signedUrl } }))
      .mockRejectedValueOnce(new Error(`network failed for ${signedUrl}`))
      .mockResolvedValueOnce(new Response('temporary failure', { status: 503 }))
      .mockResolvedValueOnce(new Response('video'))
    const downloadClient = client(fetcher, { delay, fileOperations: disk.fileOperations })
    const requested = await downloadClient.requestDownload(42, new FormalDownloadBudget(4))
    const ready = await downloadClient.waitForDownload(requested)

    const completed = await downloadClient.transferSignedUrl(ready, 'assets/retry-policy.mp4')

    expect(fetcher.mock.calls.filter(([url]) => String(url) === signedUrl)).toHaveLength(3)
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/download?file_type=mp4'))).toHaveLength(1)
    expect(delay.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([500, 1000])
    expect(JSON.stringify(completed)).not.toContain('signed.test')
  })

  it('redacts a thrown signed-fetch error containing the private URL', async () => {
    const delay = vi.fn(async (_milliseconds: number) => undefined)
    const signedUrl = 'https://signed.test/thrown-private-secret'
    const fetcher = vi.fn()
      .mockResolvedValueOnce(downloadInfo(5))
      .mockResolvedValueOnce(Response.json({ data: { url: signedUrl } }))
      .mockRejectedValue(new VecteezyDownloadError('synthetic_fetch_error', `socket failed while fetching ${signedUrl}`))
    const downloadClient = client(fetcher, { delay })
    const requested = await downloadClient.requestDownload(42, new FormalDownloadBudget(4))
    const ready = await downloadClient.waitForDownload(requested)

    const error = await downloadClient.transferSignedUrl(ready, 'assets/thrown.mp4').catch(error => error)

    expect(error).toMatchObject({ code: 'transfer_failed', message: 'Vecteezy signed transfer failed' })
    expect(String(error)).not.toContain(signedUrl)
    expect(fetcher.mock.calls.filter(([url]) => String(url) === signedUrl)).toHaveLength(3)
    await expect(downloadClient.transferSignedUrl(ready, 'assets/thrown.mp4'))
      .rejects.toMatchObject({ code: 'invalid_download_request' })
  })

  it('stops after three failed transfers and discards the private ticket', async () => {
    const delay = vi.fn(async (_milliseconds: number) => undefined)
    const fetcher = vi.fn()
      .mockResolvedValueOnce(downloadInfo(5))
      .mockResolvedValueOnce(Response.json({ data: { url: 'https://signed.test/failing-secret' } }))
      .mockResolvedValueOnce(new Response('temporary failure', { status: 503 }))
      .mockResolvedValueOnce(new Response('temporary failure', { status: 503 }))
      .mockResolvedValueOnce(new Response('temporary failure', { status: 503 }))
    const downloadClient = client(fetcher, { delay })
    const requested = await downloadClient.requestDownload(42, new FormalDownloadBudget(4))
    const ready = await downloadClient.waitForDownload(requested)

    await expect(downloadClient.transferSignedUrl(ready, 'assets/failing.mp4'))
      .rejects.toMatchObject({ code: 'transfer_failed' })

    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('signed.test/failing-secret'))).toHaveLength(3)
    expect(delay.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([500, 1000])
    await expect(downloadClient.transferSignedUrl(ready, 'assets/failing.mp4'))
      .rejects.toMatchObject({ code: 'invalid_download_request' })
  })

  it('times out status polling without exposing a private status URL', async () => {
    const delay = vi.fn(async (_milliseconds: number) => undefined)
    const fetcher = vi.fn()
      .mockResolvedValueOnce(downloadInfo(5))
      .mockResolvedValueOnce(formalDownload())
      .mockImplementation(() => Promise.resolve(Response.json({ data: { progress: 50 } })))
    const downloadClient = client(fetcher, { delay, maxStatusPolls: 2 })
    const requested = await downloadClient.requestDownload(42, new FormalDownloadBudget(4))

    const error = await downloadClient.waitForDownload(requested).catch(error => error)

    expect(error).toMatchObject({ code: 'download_status_timeout' })
    expect(String(error)).not.toContain('status.test')
    expect(delay.mock.calls.every(([milliseconds]) => milliseconds <= 1000)).toBe(true)
    await expect(downloadClient.transferSignedUrl({ requestId: requested.requestId, resourceId: requested.resourceId }, 'assets/timed-out.mp4'))
      .rejects.toMatchObject({ code: 'invalid_download_request' })
  })

  it('redacts a failed private status fetch', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(downloadInfo(5))
      .mockResolvedValueOnce(formalDownload())
      .mockRejectedValueOnce(new Error(`network failed for ${SAFE_STATUS_URL}`))
    const downloadClient = client(fetcher)
    const requested = await downloadClient.requestDownload(42, new FormalDownloadBudget(4))

    const error = await downloadClient.waitForDownload(requested).catch(error => error)

    expect(error).toMatchObject({ code: 'provider_request_failed' })
    expect(String(error)).not.toContain(SAFE_STATUS_URL)
  })
})
