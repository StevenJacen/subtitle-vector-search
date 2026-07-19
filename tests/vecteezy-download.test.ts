import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  FormalDownloadBudget,
  VecteezyDownloadClient,
} from '../src/vecteezy-download.js'

const credentials = { accountId: '161976', apiKey: 'secret' }
const MiB = 1024 * 1024

function downloadInfo(size: number | string, headers: HeadersInit = {}): Response {
  return Response.json({
    data: {
      file_size: size,
      requires_attribution: true,
      required_attribution_url: 'https://attribution.test/license',
    },
  }, { headers })
}

function formalDownload(): Response {
  return Response.json({ data: { download_status_url: 'https://status.test/private-status' } })
}

function client(
  fetcher: (...args: any[]) => Promise<Response>,
  overrides: Record<string, unknown> = {},
): VecteezyDownloadClient {
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
    const budget = new FormalDownloadBudget(5)

    for (const id of [1, 2, 3, 4]) {
      await downloadClient.requestDownload(id, budget)
    }

    await expect(downloadClient.requestDownload(5, budget))
      .rejects.toMatchObject({ code: 'aggregate_size_limit_exceeded' })
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/download'))).toHaveLength(9)
    expect(budget.used).toBe(4)
  })

  it('reserves formal download budget synchronously before fetch and never exceeds four', async () => {
    const budget = new FormalDownloadBudget(4)
    const fetcher = vi.fn((url: string) => {
      if (url.includes('/download_info')) return Promise.resolve(downloadInfo(123))
      expect(budget.used).toBeLessThanOrEqual(4)
      return Promise.resolve(formalDownload())
    })
    const downloadClient = client(fetcher)

    await Promise.all([1, 2, 3, 4].map(id => downloadClient.requestDownload(id, budget)))
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
    expect(disk.readFile).toHaveBeenCalledWith('assets/42.mp4')
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
      .mockRejectedValueOnce(new Error('network failed for https://status.test/private-status'))
    const downloadClient = client(fetcher)
    const requested = await downloadClient.requestDownload(42, new FormalDownloadBudget(4))

    const error = await downloadClient.waitForDownload(requested).catch(error => error)

    expect(error).toMatchObject({ code: 'provider_request_failed' })
    expect(String(error)).not.toContain('status.test')
  })
})
