import { describe, expect, it, vi } from 'vitest'
import {
  enrichVecteezyResources,
  getVecteezyResource,
  searchVecteezy,
  type VecteezySearchResource,
} from '../supabase/functions/_shared/vecteezy.js'

const credentials = { accountId: '123', apiKey: 'secret' }

function response(resource: Record<string, unknown> = rawResource(7)): Response {
  return Response.json({
    page: 1, last_page: 1, per_page: 10, total_resources: 1, resources: [resource],
  })
}

function rawResource(id: number): Record<string, unknown> {
  return {
    id,
    title: null,
    content_type: 'video',
    preview_url: `https://preview.test/${id}.mp4`,
    thumbnail_url: `https://thumbnail.test/${id}.jpg`,
    license_type: 'commercial',
    ai_generated: false,
    orientation: 'landscape',
    tags: ['sunrise', { name: 'walking' }, 12],
    file_metadata: {
      available_file_types: [
        { extension: 'mp4', size_in_bytes: 123 },
        { extension: 'webm', size_in_bytes: 'bad' },
      ],
      available_download_sizes: [
        { id: 'hd', width: 1920, height: 1080 },
        { id: 2, width: 1280, height: 720 },
      ],
    },
    ignored: 'raw response data must not escape',
  }
}

function resource(id: number): VecteezySearchResource {
  return {
    stable: {
      providerResourceId: id, title: null, contentType: 'video', licenseType: null,
      aiGenerated: null, orientation: null, tags: [], fileTypes: [], downloadSizes: [],
    },
    ephemeral: { previewUrl: `https://preview.test/${id}.mp4`, thumbnailUrl: null },
  }
}

describe('Vecteezy search', () => {
  it('uses only the read-only V2 search endpoint and bearer authorization', async () => {
    const fetcher = vi.fn().mockResolvedValue(response())

    const page = await searchVecteezy('person walking sunrise', { ...credentials, fetcher })

    const [url, init] = fetcher.mock.calls[0]
    expect(String(url)).toContain('https://api.vecteezy.com/v2/123/resources?')
    expect(String(url)).toContain('term=person+walking+sunrise')
    expect(String(url)).not.toContain('query=')
    expect(String(url)).toContain('content_type=video')
    expect(String(url)).toContain('license_type=commercial')
    expect(String(url)).toContain('duration=3_15')
    expect(String(url)).toContain('sort_by=relevance')
    expect(String(url)).toContain('family_friendly=true')
    expect(String(url)).toContain('per_page=10')
    expect(String(url)).not.toContain('/download')
    expect(init.headers.authorization).toBe('Bearer secret')
    expect(init.headers.accept).toBe('application/json')
    expect(page.resources[0].stable.title).toBeNull()
    expect(page.resources[0].ephemeral.previewUrl).toBe('https://preview.test/7.mp4')
  })

  it('sanitizes accepted fields and ignores unknown raw resource fields', async () => {
    const page = await searchVecteezy('sunrise', {
      ...credentials, fetcher: vi.fn().mockResolvedValue(response()),
    })

    expect(page.resources).toEqual([{
      stable: {
        providerResourceId: 7, title: null, contentType: 'video', licenseType: 'commercial',
        aiGenerated: false, orientation: 'landscape', tags: ['sunrise', 'walking'],
        fileTypes: [{ extension: 'mp4', sizeInBytes: 123 }],
        downloadSizes: [{ id: 'hd', width: 1920, height: 1080 }, { id: '2', width: 1280, height: 720 }],
      },
      ephemeral: { previewUrl: 'https://preview.test/7.mp4', thumbnailUrl: 'https://thumbnail.test/7.jpg' },
    }])
    expect(Object.keys(page.resources[0])).toEqual(['stable', 'ephemeral'])
  })

  it.each([0, -1, 1.5, '7', null])('rejects malformed resource IDs', async id => {
    await expect(getVecteezyResource(id, { ...credentials, fetcher: vi.fn() })).rejects.toThrow('invalid Vecteezy resource ID')
  })

  it('rejects non-2xx provider responses without parsing them', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }))

    await expect(searchVecteezy('sunrise', { ...credentials, fetcher })).rejects.toThrow('Vecteezy request failed: 503')
  })

  it('sets a ten-second abort signal on provider requests', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const fetcher = vi.fn().mockResolvedValue(response())

    await searchVecteezy('sunrise', { ...credentials, fetcher })

    expect(timeout).toHaveBeenCalledWith(10_000)
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    timeout.mockRestore()
  })
})

describe('Vecteezy detail enrichment', () => {
  it('enriches details with at most four simultaneous requests', async () => {
    let active = 0
    let maximum = 0
    const fetcher = vi.fn(async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      return response()
    })

    await enrichVecteezyResources([1, 2, 3, 4, 5].map(resource), { ...credentials, fetcher })

    expect(fetcher).toHaveBeenCalledTimes(5)
    expect(maximum).toBe(4)
  })

  it('leaves optional detail fields null when one detail request fails', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }))

    const [enriched] = await enrichVecteezyResources([resource(7)], { ...credentials, fetcher })

    expect(enriched.stable).toMatchObject({ licenseType: null, orientation: null, tags: [], fileTypes: [] })
    expect(enriched.ephemeral).toEqual({ previewUrl: 'https://preview.test/7.mp4', thumbnailUrl: null })
  })
})
