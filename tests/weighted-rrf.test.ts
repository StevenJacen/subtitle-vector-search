import { describe, expect, it } from 'vitest'
import { fuseVecteezyLanes } from '../supabase/functions/_shared/weighted-rrf.js'
import type { VecteezySearchResource } from '../supabase/functions/_shared/vecteezy.js'

function resource(id: number): VecteezySearchResource {
  return {
    stable: {
      providerResourceId: id, title: null, contentType: 'video', licenseType: null,
      aiGenerated: null, orientation: null, tags: [], fileTypes: [], downloadSizes: [],
    },
    ephemeral: { previewUrl: null, thumbnailUrl: null },
  }
}

describe('weighted reciprocal rank fusion', () => {
  it('rewards resources returned by more than one lane and breaks ties deterministically', () => {
    const fused = fuseVecteezyLanes([
      { kind: 'literal', weight: 0.4, resources: [resource(10), resource(20)] },
      { kind: 'action', weight: 0.4, resources: [resource(20), resource(30)] },
      { kind: 'metaphor', weight: 0.2, resources: [resource(30), resource(10)] },
    ], 5)

    expect(fused.map(item => item.providerResourceId)).toEqual([20, 10, 30])
    expect(fused[0].matchedBy).toEqual(['literal', 'action'])
    expect(fused[0].score).toBeCloseTo(0.4 / 62 + 0.4 / 61)
  })

  it('sorts equal scores by best rank then resource ID and limits candidates', () => {
    const fused = fuseVecteezyLanes([
      { kind: 'literal', weight: 1, resources: [resource(20), resource(10), resource(30)] },
    ], 2)

    expect(fused.map(item => item.providerResourceId)).toEqual([20, 10])
    expect(fused.map(item => item.bestRank)).toEqual([1, 2])
  })
})
