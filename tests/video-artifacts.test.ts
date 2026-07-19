import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  artifactKey,
  canonicalRequestDigest,
  canonicalRequestDigestInput,
  nextIncompleteStage,
  readManifest,
  resolveArtifactPath,
  sha256File,
  writeManifestAtomic,
  type LocalFileState,
  type VideoRunManifest,
} from '../src/video-artifacts.js'

vi.mock('node:fs/promises', { spy: true })

const renderId = 'd62a53a1-08fb-4bee-a1ed-d8ba13de85f2'
const roots: string[] = []

const manifest: VideoRunManifest = {
  version: 1,
  planId: renderId,
  renderId: null,
  requestDigest: 'a'.repeat(64),
  theme: 'Crossing darkness toward dawn',
  quote: {
    trackId: 7,
    cueIndex: 31,
    text: 'Hope remains with us.',
    captionZh: '\u5e0c\u671b\u4ecd\u4e0e\u6211\u4eec\u540c\u5728\u3002',
  },
  scenes: [],
  stage: 'review',
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(process.cwd(), 'test-artifacts-'))
  roots.push(root)
  return root
}

describe('artifact keys', () => {
  it('creates and resolves a relative key beneath the artifact root', () => {
    const key = artifactKey(renderId, 'final.mp4')

    expect(key).toBe(`video-runs/${renderId}/final.mp4`)
    expect(resolveArtifactPath('artifacts', key)).toBe(join(process.cwd(), 'artifacts', 'video-runs', renderId, 'final.mp4'))
  })

  it.each([
    'C:/temp/final.mp4',
    '/tmp/final.mp4',
    '../final.mp4',
    'nested/../final.mp4',
    'nested\\final.mp4',
    'nested/\u0000final.mp4',
    'http:/provider.test/final.mp4',
    'https:/provider.test/final.mp4',
    'data:/video/mp4;base64,AA==',
    'preview-url.mp4',
    'access-token.mp4',
    'client-secret.mp4',
    'authorization.mp4',
    '',
    '.',
    'nested//final.mp4',
    'nested/./final.mp4',
  ])('rejects unsafe relative artifact path %j', relative => {
    expect(() => artifactKey(renderId, relative)).toThrow('invalid artifact key')
  })

  it.each([
    `video-runs/${renderId}/final.mp4`,
    `video-runs/${renderId}/nested/final.mp4`,
  ])('accepts a safe complete key %s', key => {
    expect(resolveArtifactPath('artifacts', key)).toContain(join('video-runs', renderId))
  })

  it.each([
    'C:/temp/final.mp4',
    `/video-runs/${renderId}/final.mp4`,
    `video-runs/${renderId}/../final.mp4`,
    `video-runs/${renderId}/nested\\final.mp4`,
    `video-runs/${renderId}/\u0001final.mp4`,
    `http://provider.test/video-runs/${renderId}/final.mp4`,
    `https://provider.test/video-runs/${renderId}/final.mp4`,
    `data:video/mp4;base64,AA==`,
    `video-runs/${renderId}/preview-url.mp4`,
    `video-runs/${renderId}/access-token.mp4`,
    `video-runs/${renderId}/client-secret.mp4`,
    `video-runs/${renderId}/authorization.mp4`,
    `video-runs/${renderId}//final.mp4`,
    `video-runs/${renderId}/./final.mp4`,
  ])('rejects unsafe complete key %j', key => {
    expect(() => resolveArtifactPath('artifacts', key)).toThrow('invalid artifact key')
  })
})

describe('video run manifests', () => {
  it('atomically writes and strictly reads a stable manifest', async () => {
    const root = await temporaryRoot()
    const path = join(root, 'manifest.json')
    const writeFile = vi.mocked(fs.writeFile)
    const rename = vi.mocked(fs.rename)

    await writeManifestAtomic(path, manifest)

    const bytes = await fs.readFile(path, 'utf8')
    expect(bytes).toBe(`${JSON.stringify(manifest, null, 2)}\n`)
    expect(await readManifest(path)).toEqual(manifest)
    expect(writeFile).toHaveBeenCalledTimes(1)
    expect(rename).toHaveBeenCalledTimes(1)
    expect(writeFile.mock.invocationCallOrder[0]).toBeLessThan(rename.mock.invocationCallOrder[0])
    expect(rename.mock.calls[0][0]).not.toBe(path)
    expect(rename.mock.calls[0][1]).toBe(path)
    expect(await fs.readdir(root)).toEqual(['manifest.json'])
  })

  it('rejects unknown fields and recursively rejects private URL data', async () => {
    const root = await temporaryRoot()
    const path = join(root, 'manifest.json')
    const invalidValues = [
      { ...manifest, extra: true },
      { ...manifest, quote: { ...manifest.quote, signedUrl: 'https://provider.test/signed' } },
      { ...manifest, scenes: [{ statusUrl: 'https://provider.test/status' }] },
      { ...manifest, scenes: [{ note: 'https://provider.test/download/token' }] },
      { ...manifest, sources: [{ artifactKey: `video-runs/${renderId}/source.mp4`, sha256: 'b'.repeat(64), previewUrl: 'https://provider.test/preview' }] },
    ]

    for (const value of invalidValues) {
      await fs.writeFile(path, `${JSON.stringify(value)}\n`)
      await expect(readManifest(path)).rejects.toThrow('invalid manifest')
    }
  })

  it('retains stable attribution while excluding private provider URL forms', async () => {
    const root = await temporaryRoot()
    const path = join(root, 'manifest.json')
    const withAttribution: VideoRunManifest = {
      ...manifest,
      stage: 'downloading',
      sources: [{
        artifactKey: artifactKey(renderId, 'assets/scene-01.mp4'),
        sha256: 'b'.repeat(64),
        requiresAttribution: true,
        requiredAttributionUrl: 'https://provider.test/license',
      }],
    }

    await writeManifestAtomic(path, withAttribution)

    expect(await readManifest(path)).toEqual(withAttribution)
  })

  it('produces deterministic digest bytes without a local plan identifier', () => {
    const first = {
      theme: manifest.theme,
      quote: { text: manifest.quote.text, cueIndex: 31, trackId: 7 },
      scenes: [{ resourceId: 42, runId: renderId }],
    }
    const reordered = {
      scenes: [{ runId: renderId, resourceId: 42 }],
      quote: { trackId: 7, cueIndex: 31, text: manifest.quote.text },
      theme: manifest.theme,
    }

    const bytes = canonicalRequestDigestInput(first)
    expect(bytes).toBe(canonicalRequestDigestInput(reordered))
    expect(bytes).not.toContain('planId')
    expect(canonicalRequestDigest(first)).toBe(createHash('sha256').update(bytes).digest('hex'))
  })

  it('serializes equivalent nested manifest values in a stable field order', async () => {
    const root = await temporaryRoot()
    const firstPath = join(root, 'first.json')
    const secondPath = join(root, 'second.json')
    const sourceKey = artifactKey(renderId, 'assets/scene-01.mp4')
    const first: VideoRunManifest = {
      ...manifest,
      stage: 'downloading',
      sources: [{ artifactKey: sourceKey, sha256: 'b'.repeat(64), sizeBytes: 10, videoCodec: 'h264' }],
    }
    const second: VideoRunManifest = {
      ...manifest,
      stage: 'downloading',
      sources: [{ videoCodec: 'h264', sizeBytes: 10, sha256: 'b'.repeat(64), artifactKey: sourceKey }],
    }

    await writeManifestAtomic(firstPath, first)
    await writeManifestAtomic(secondPath, second)

    expect(await fs.readFile(firstPath, 'utf8')).toBe(await fs.readFile(secondPath, 'utf8'))
  })
})

describe('local file reuse', () => {
  it('streams a lower-case SHA-256 and reuses only exact source and output hashes', async () => {
    const root = await temporaryRoot()
    const sourcePath = join(root, 'source.mp4')
    const outputPath = join(root, 'final.mp4')
    await fs.writeFile(sourcePath, Buffer.from('source bytes'))
    await fs.writeFile(outputPath, Buffer.from('final bytes'))

    const sourceHash = await sha256File(sourcePath)
    const outputHash = await sha256File(outputPath)
    const source = { artifactKey: artifactKey(renderId, 'assets/scene-01.mp4'), sha256: sourceHash }
    const output = { artifactKey: artifactKey(renderId, 'final.mp4'), sha256: outputHash }
    const completed: VideoRunManifest = {
      ...manifest,
      stage: 'completed',
      sources: [source],
      output,
    }
    const matching: LocalFileState = {
      hashes: {
        [source.artifactKey]: sourceHash,
        [output.artifactKey]: outputHash,
      },
    }

    expect(sourceHash).toBe(createHash('sha256').update('source bytes').digest('hex'))
    expect(sourceHash).toMatch(/^[0-9a-f]{64}$/)
    expect(nextIncompleteStage(completed, matching)).toBe('completed')
    expect(nextIncompleteStage(completed, {
      hashes: { ...matching.hashes, [source.artifactKey]: '0'.repeat(64) },
    })).toBe('downloading')
    expect(nextIncompleteStage(completed, {
      hashes: { ...matching.hashes, [output.artifactKey]: '0'.repeat(64) },
    })).toBe('rendering')
  })
})
