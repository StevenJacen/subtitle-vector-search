import type { VideoAssetCandidate } from '../../supabase/functions/_shared/video-assets.js'
import type { VideoProductionApi } from '../video-production-api.js'
import type { CandidateKey, CandidateReference } from './candidate-pool.js'

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

  constructor(private readonly createId: () => string = () => crypto.randomUUID()) {}

  register(url: string | null): string | null {
    if (url === null) return null
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('invalid preview URL')
    }
    const id = this.createId()
    if (!UUID.test(id)) throw new Error('invalid preview ID')
    if (!this.previews.has(id)) this.previews.set(id, parsed.toString())
    return id
  }

  resolve(previewId: string): string | undefined {
    if (!UUID.test(previewId)) return undefined
    return this.previews.get(previewId)
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
    if (response.page !== input.page || typeof response.hasNextPage !== 'boolean'
      || response.candidates.length !== 8) {
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
      score: recommendationScore(candidate, input.aspectRatio),
    }))
    const recommendedCandidate = candidates.reduce((best, candidate) => (
      candidate.score > best.score ? candidate : best
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

function recommendationScore(candidate: VideoAssetCandidate, aspectRatio: WorkbenchAspectRatio): number {
  const orientation = candidate.orientation?.toLocaleLowerCase('en-US') ?? ''
  const orientationMatches = aspectRatio === '9:16'
    ? orientation === 'portrait' || orientation === 'vertical'
    : orientation === 'landscape' || orientation === 'horizontal'
  const usableMp4 = candidate.fileTypes.some(file => file.extension.toLocaleLowerCase('en-US') === 'mp4')
  const commercial = candidate.licenseType?.toLocaleLowerCase('en-US').includes('commercial') ?? false
  const nonAi = candidate.aiGenerated === false

  return candidate.score
    + (orientationMatches ? 0.1 : 0)
    + (usableMp4 ? 0.02 : 0)
    + (commercial ? 0.01 : 0)
    + (nonAi ? 0.005 : 0)
    + (0.001 / candidate.bestRank)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
