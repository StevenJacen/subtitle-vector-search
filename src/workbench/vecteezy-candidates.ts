import type { VideoAssetCandidate } from '../../supabase/functions/_shared/video-assets.js'
import type { VideoProductionApi } from '../video-production-api.js'
import {
  compareRecommendation,
  type CandidateKey,
  type CandidateReference,
} from './candidate-pool.js'

export type WorkbenchAspectRatio = '9:16' | '16:9'

export interface CandidatePageResult {
  runId: string
  page: number
  hasNextPage: boolean
  candidates: CandidateReference[]
  recommended: CandidateKey
}

export class PreviewRegistry {
  private readonly previews = new Map<string, string>()
  private readonly createId: () => string
  private readonly allowUrl: (url: URL) => boolean
  private readonly collisionRetries: number

  constructor(options: {
    createId?: () => string
    allowUrl?: (url: URL) => boolean
  } = {}) {
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.allowUrl = options.allowUrl ?? defaultPreviewPolicy
    this.collisionRetries = 4
  }

  register(url: string | null): string | null {
    if (url === null) return null
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new PreviewRegistryError('preview_url_forbidden')
    }
    if (!this.allowUrl(parsed)) throw new PreviewRegistryError('preview_url_forbidden')

    for (let attempt = 0; attempt < this.collisionRetries; attempt += 1) {
      const id = this.createId()
      if (!UUID.test(id)) throw new PreviewRegistryError('preview_id_invalid')
      if (this.previews.has(id)) continue
      this.previews.set(id, parsed.toString())
      return id
    }
    throw new PreviewRegistryError('preview_id_collision')
  }

  restore(previewId: string, url: string): void {
    if (!UUID.test(previewId)) throw new PreviewRegistryError('preview_id_invalid')
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new PreviewRegistryError('preview_url_forbidden')
    }
    if (!this.allowUrl(parsed)) throw new PreviewRegistryError('preview_url_forbidden')
    const normalizedId = previewId.toLowerCase()
    const normalizedUrl = parsed.toString()
    const existing = this.previews.get(normalizedId)
    if (existing !== undefined && existing !== normalizedUrl) {
      throw new PreviewRegistryError('preview_id_collision')
    }
    this.previews.set(normalizedId, normalizedUrl)
  }

  resolve(previewId: string): string | undefined {
    if (!UUID.test(previewId)) return undefined
    return this.previews.get(previewId)
  }
}

export class PreviewRegistryError extends Error {
  constructor(readonly code: string) {
    super(code.replaceAll('_', ' '))
    this.name = 'PreviewRegistryError'
  }
}

type CandidateApi = Pick<VideoProductionApi, 'matchScene' | 'selectCandidate'>

export class VecteezyCandidateAdapter {
  constructor(
    private readonly api: CandidateApi,
    private readonly previews: PreviewRegistry,
  ) {}

  async loadPage(input: {
    theme: string
    aspectRatio: WorkbenchAspectRatio
    page: number
    sourceRunId?: string
  }): Promise<CandidatePageResult> {
    const response = await this.api.matchScene({
      theme: input.theme,
      candidateCount: 8,
      page: input.page,
      ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
    })
    const validCandidateCount = input.page === 1
      ? response.candidates.length === 8
      : response.candidates.length >= 1 && response.candidates.length <= 8
    if (response.page !== input.page || typeof response.hasNextPage !== 'boolean'
      || !validCandidateCount) {
      throw new Error('invalid paged candidate response')
    }

    const candidates = response.candidates.map(candidate => ({
      provider: 'vecteezy' as const,
      resourceId: candidate.providerResourceId,
      runId: response.runId,
      page: response.page as number,
      title: candidate.title,
      previewId: this.previews.register(candidate.previewUrl),
      orientation: candidate.orientation,
      licenseType: candidate.licenseType,
      aiGenerated: candidate.aiGenerated,
      score: candidate.score,
      suitabilityScore: suitabilityScore(candidate, input.aspectRatio),
      providerRank: candidate.bestRank,
    }))
    const recommendedCandidate = candidates.reduce((best, candidate) => (
      compareRecommendation(candidate, best) < 0 ? candidate : best
    ))

    return {
      runId: response.runId,
      page: response.page,
      hasNextPage: response.hasNextPage,
      candidates,
      recommended: {
        runId: recommendedCandidate.runId,
        resourceId: recommendedCandidate.resourceId,
      },
    }
  }

  select(candidate: CandidateReference, note: string): Promise<{ selectionId: number }> {
    return this.api.selectCandidate({
      runId: candidate.runId,
      providerResourceId: candidate.resourceId,
      note,
    })
  }
}

function suitabilityScore(candidate: VideoAssetCandidate, aspectRatio: WorkbenchAspectRatio): number {
  const orientation = candidate.orientation?.toLocaleLowerCase('en-US') ?? ''
  const orientationMatches = aspectRatio === '9:16'
    ? orientation === 'portrait' || orientation === 'vertical'
    : orientation === 'landscape' || orientation === 'horizontal'
  const usableMp4 = candidate.fileTypes.some(file => file.extension.toLocaleLowerCase('en-US') === 'mp4')
  const commercial = COMMERCIAL_LICENSES.has(normalizeLicense(candidate.licenseType))
  const nonAi = candidate.aiGenerated === false

  return (orientationMatches ? 8 : 0)
    + (usableMp4 ? 4 : 0)
    + (commercial ? 2 : 0)
    + (nonAi ? 1 : 0)
}

function normalizeLicense(value: string | null): string {
  return value?.trim().toLocaleLowerCase('en-US').replace(/[\s_-]+/g, '-') ?? ''
}

function defaultPreviewPolicy(url: URL): boolean {
  const hostname = url.hostname.toLocaleLowerCase('en-US')
  return url.protocol === 'https:'
    && url.username === ''
    && url.password === ''
    && (url.port === '' || url.port === '443')
    && (hostname === 'vecteezy.com' || hostname.endsWith('.vecteezy.com'))
}

const COMMERCIAL_LICENSES = new Set(['commercial', 'free', 'pro', 'pro-extended'])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
