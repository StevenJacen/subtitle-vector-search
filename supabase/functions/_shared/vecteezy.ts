const API_BASE_URL = 'https://api.vecteezy.com'
const REQUEST_TIMEOUT_MS = 10_000

export interface StableVecteezyResource {
  providerResourceId: number
  title: string | null
  contentType: 'video'
  licenseType: string | null
  aiGenerated: boolean | null
  orientation: string | null
  tags: string[]
  fileTypes: Array<{ extension: string; sizeInBytes: number }>
  downloadSizes: Array<{ id: string; width: number; height: number }>
}

export interface VecteezySearchResource {
  stable: StableVecteezyResource
  ephemeral: { previewUrl: string | null; thumbnailUrl: string | null }
}

export interface VecteezyPage {
  page: number | null
  lastPage: number | null
  perPage: number | null
  totalResources: number | null
  resources: VecteezySearchResource[]
}

export interface VecteezyClientOptions {
  accountId: string
  apiKey: string
  fetcher: typeof fetch
  page?: number
}

export async function searchVecteezy(
  term: string,
  options: VecteezyClientOptions,
): Promise<VecteezyPage> {
  if (options.page !== undefined
    && (!Number.isSafeInteger(options.page) || options.page < 1 || options.page > 100)) {
    throw new Error('invalid Vecteezy page')
  }
  const url = resourceUrl(options.accountId, {
    term,
    content_type: 'video',
    license_type: 'commercial',
    duration: '3_15',
    sort_by: 'relevance',
    family_friendly: 'true',
    per_page: '10',
    ...(options.page === undefined ? {} : { page: String(options.page) }),
  })
  const payload = await request(url, options)
  const input = record(payload)

  return {
    page: positiveIntegerOrNull(input.page),
    lastPage: positiveIntegerOrNull(input.last_page),
    perPage: positiveIntegerOrNull(input.per_page),
    totalResources: nonNegativeIntegerOrNull(input.total_resources),
    resources: array(input.resources).flatMap(sanitizeResource),
  }
}

export async function getVecteezyResource(
  resourceId: unknown,
  options: VecteezyClientOptions,
): Promise<VecteezySearchResource> {
  if (!isPositiveSafeInteger(resourceId)) {
    throw new Error('invalid Vecteezy resource ID')
  }
  const payload = await request(`${resourceUrl(options.accountId)}/${resourceId}`, options)
  const input = record(payload)
  const candidate = input.resource ?? array(input.resources)[0] ?? input
  const resource = sanitizeResource(candidate)[0]
  if (resource === undefined) {
    throw new Error('invalid Vecteezy resource')
  }
  return resource
}

export async function enrichVecteezyResources(
  resources: VecteezySearchResource[],
  options: VecteezyClientOptions,
): Promise<VecteezySearchResource[]> {
  const enriched = resources.map(resource => ({
    stable: { ...resource.stable },
    ephemeral: { ...resource.ephemeral },
  }))
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < enriched.length) {
      const index = nextIndex++
      const current = enriched[index]
      try {
        const detail = await getVecteezyResource(current.stable.providerResourceId, options)
        enriched[index] = {
          stable: {
            ...current.stable,
            licenseType: detail.stable.licenseType,
            orientation: detail.stable.orientation,
            tags: detail.stable.tags,
            fileTypes: detail.stable.fileTypes,
            downloadSizes: detail.stable.downloadSizes,
          },
          ephemeral: current.ephemeral,
        }
      } catch {
        enriched[index] = {
          stable: {
            ...current.stable,
            licenseType: null,
            orientation: null,
            tags: [],
            fileTypes: [],
            downloadSizes: [],
          },
          ephemeral: current.ephemeral,
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, enriched.length) }, worker))
  return enriched
}

function resourceUrl(accountId: string, params?: Record<string, string>): string {
  if (!/^\d+$/.test(accountId)) {
    throw new Error('invalid Vecteezy account ID')
  }
  const url = new URL(`/v2/${accountId}/resources`, API_BASE_URL)
  if (params !== undefined) {
    url.search = new URLSearchParams(params).toString()
  }
  return url.toString()
}

async function request(url: string, options: VecteezyClientOptions): Promise<unknown> {
  const response = await options.fetcher(url, {
    headers: { authorization: `Bearer ${options.apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`Vecteezy request failed: ${response.status}`)
  }
  return response.json()
}

function sanitizeResource(value: unknown): VecteezySearchResource[] {
  const input = record(value)
  const id = input.id
  if (!isPositiveSafeInteger(id) || input.content_type !== 'video') {
    return []
  }
  const metadata = record(input.file_metadata)
  return [{
    stable: {
      providerResourceId: id,
      title: stringOrNull(input.title),
      contentType: 'video',
      licenseType: stringOrNull(input.license_type),
      aiGenerated: booleanOrNull(input.ai_generated),
      orientation: stringOrNull(input.orientation),
      tags: tags(input.tags),
      fileTypes: fileTypes(metadata.available_file_types),
      downloadSizes: downloadSizes(metadata.available_download_sizes),
    },
    ephemeral: {
      previewUrl: stringOrNull(input.preview_url),
      thumbnailUrl: stringOrNull(input.thumbnail_url),
    },
  }]
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function positiveIntegerOrNull(value: unknown): number | null {
  return isPositiveSafeInteger(value) ? value : null
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function tags(value: unknown): string[] {
  return array(value).flatMap(value => {
    if (typeof value === 'string') return [value]
    const name = record(value).name
    return typeof name === 'string' ? [name] : []
  })
}

function fileTypes(value: unknown): Array<{ extension: string; sizeInBytes: number }> {
  return array(value).flatMap(value => {
    const input = record(value)
    return typeof input.extension === 'string' && isPositiveSafeInteger(input.size_in_bytes)
      ? [{ extension: input.extension, sizeInBytes: input.size_in_bytes }]
      : []
  })
}

function downloadSizes(value: unknown): Array<{ id: string; width: number; height: number }> {
  return array(value).flatMap(value => {
    const input = record(value)
    return (typeof input.id === 'string' || typeof input.id === 'number')
      && isPositiveSafeInteger(input.width) && isPositiveSafeInteger(input.height)
      ? [{ id: String(input.id), width: input.width, height: input.height }]
      : []
  })
}
