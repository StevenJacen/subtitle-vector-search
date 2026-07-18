import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.110.2'
import type { TokenEnvironment } from '../_shared/auth.ts'
import { errorResponse, handleAuthenticatedRequest, jsonResponse } from '../_shared/http.ts'
import { matchVideoAssets, type VideoAssetMatchingDependencies } from '../_shared/video-asset-matching.ts'
import { createVideoAssetRepository } from '../_shared/video-asset-repository.ts'
import { parseVideoAssetRequest, VideoAssetError } from '../_shared/video-assets.ts'
import {
  createPlannerTransport,
  fallbackVisualPlan,
  planVisualSearch,
} from '../_shared/video-planner.ts'
import { getVecteezyResource, searchVecteezy } from '../_shared/vecteezy.ts'
import { fuseVecteezyLanes } from '../_shared/weighted-rrf.ts'

Deno.serve(async request => {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'only POST is supported')
  }

  return await handleAuthenticatedRequest(request, Deno.env, async () => {
    try {
      const input = parseVideoAssetRequest(await request.json())
      const response = await matchVideoAssets(input, createDependencies(Deno.env))
      return jsonResponse(response)
    } catch (error) {
      if (error instanceof VideoAssetError) {
        return errorResponse(error.status, error.code, error.message)
      }
      if (error instanceof SyntaxError) {
        return errorResponse(400, 'invalid_request', 'invalid request')
      }
      return errorResponse(500, 'video_asset_match_failed', 'video asset matching failed')
    }
  })
})

function createDependencies(environment: TokenEnvironment): VideoAssetMatchingDependencies {
  const client = createClient(
    requiredEnvironment(environment, 'SUPABASE_URL'),
    requiredEnvironment(environment, 'SUPABASE_SERVICE_ROLE_KEY'),
  )
  const session = new Supabase.ai.Session('gte-small')
  const generate = createPlannerTransport(environment)
  const providerOptions = {
    accountId: requiredEnvironment(environment, 'VECTEEZY_ACCOUNT'),
    apiKey: requiredEnvironment(environment, 'VECTEEZY_API_KEY'),
    fetcher: fetch,
  }

  return {
    repository: createVideoAssetRepository(client),
    sha256,
    plan: async input => await planVisualSearch(input, {
      generate,
      fallback: async fallbackInput => (
        await fallbackVisualPlan(fallbackInput, { session, client })
      ),
    }),
    search: async term => {
      const page = await searchVecteezy(term, providerOptions)
      return {
        resources: page.resources,
        totalResources: page.totalResources,
      }
    },
    detail: async providerResourceId => (
      await getVecteezyResource(providerResourceId, providerOptions)
    ),
    fuse: fuseVecteezyLanes,
    now: Date.now,
  }
}

function requiredEnvironment(environment: TokenEnvironment, name: string): string {
  const value = environment.get(name)
  if (value === undefined || value.trim() === '') {
    throw new Error('missing configuration')
  }
  return value
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(
    new Uint8Array(digest),
    byte => byte.toString(16).padStart(2, '0'),
  ).join('')
}
