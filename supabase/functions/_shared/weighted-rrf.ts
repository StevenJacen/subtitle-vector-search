import type { QueryKind } from './video-assets.ts'
import type { VecteezySearchResource } from './vecteezy.ts'

export interface VecteezyLane {
  kind: QueryKind
  weight: number
  resources: VecteezySearchResource[]
}

export interface FusedCandidate {
  providerResourceId: number
  resource: VecteezySearchResource
  score: number
  bestRank: number
  matchedBy: QueryKind[]
}

export function fuseVecteezyLanes(lanes: VecteezyLane[], candidateCount: number): FusedCandidate[] {
  if (!Number.isSafeInteger(candidateCount) || candidateCount < 1) {
    throw new Error('invalid candidate count')
  }
  const candidates = new Map<number, FusedCandidate>()

  for (const lane of lanes) {
    for (const [index, resource] of lane.resources.entries()) {
      const providerResourceId = resource.stable.providerResourceId
      const rank = index + 1
      const existing = candidates.get(providerResourceId)
      if (existing === undefined) {
        candidates.set(providerResourceId, {
          providerResourceId,
          resource,
          score: lane.weight / (60 + rank),
          bestRank: rank,
          matchedBy: [lane.kind],
        })
        continue
      }
      existing.score += lane.weight / (60 + rank)
      existing.bestRank = Math.min(existing.bestRank, rank)
      if (!existing.matchedBy.includes(lane.kind)) {
        existing.matchedBy.push(lane.kind)
      }
    }
  }

  return [...candidates.values()]
    .sort((left, right) => right.score - left.score
      || left.bestRank - right.bestRank
      || left.providerResourceId - right.providerResourceId)
    .slice(0, candidateCount)
}
