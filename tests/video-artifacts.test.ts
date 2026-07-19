import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
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
const otherRunId = '11111111-2222-4333-8444-555555555555'
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
  scenes: [
    { index: 0, captionKind: 'original', captionEn: 'Night.', captionZh: '\u9ed1\u591c\u3002', visualTheme: 'dark landscape' },
    { index: 1, captionKind: 'original', captionEn: 'Walk.', captionZh: '\u524d\u884c\u3002', visualTheme: 'traveler walking' },
    {
      index: 2,
      captionKind: 'quote',
      captionEn: 'Hope remains with us.',
      captionZh: '\u5e0c\u671b\u4ecd\u4e0e\u6211\u4eec\u540c\u5728\u3002',
      visualTheme: 'first light',
      sourceMovieId: 9,
      sourceTrackId: 7,
      sourceCueIndex: 31,
      sourceStartMs: 5_000,
      sourceEndMs: 8_000,
      sourceTimestamp: '00:00:05.000 --> 00:00:08.000',
      movieTitle: 'Example Film',
      releaseYear: 1994,
    },
    { index: 3, captionKind: 'original', captionEn: 'Dawn.', captionZh: '\u9ece\u660e\u3002', visualTheme: 'open horizon' },
  ],
  stage: 'review',
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
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
    'CON',
    'con.mp4',
    'nested/PRN.txt',
    'AUX.mp4',
    'NUL',
    'COM1.mp4',
    'com9',
    'LPT1.mov',
    'lpt9',
    'final.',
    'nested/trailing. ',
    'nested/trailing ',
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
    `video-runs/${renderId}/CON/final.mp4`,
    `video-runs/${renderId}/final.mp4.`,
    'video-runs/d62a53a1-08fb-4bee-a1ed-d8ba13de85f/final.mp4',
    'video-runs/d62a53a1-08fb-4bee-a1ed-d8ba13de85fz/final.mp4',
    'video-runs/d62a53a108fb4beea1edd8ba13de85f2/final.mp4',
    'video-runs/{d62a53a1-08fb-4bee-a1ed-d8ba13de85f2}/final.mp4',
    'video-runs/d62a53a1-08fb-0bee-a1ed-d8ba13de85f2/final.mp4',
    'video-runs/d62a53a1-08fb-4bee-71ed-d8ba13de85f2/final.mp4',
  ])('rejects unsafe complete key %j', key => {
    expect(() => resolveArtifactPath('artifacts', key)).toThrow('invalid artifact key')
  })
})

describe('video run manifests', () => {
  it('atomically writes and strictly reads a stable manifest', async () => {
    const root = await temporaryRoot()
    const path = resolveArtifactPath(root, artifactKey(renderId, 'manifest.json'))
    const open = vi.mocked(fs.open)
    const rename = vi.mocked(fs.rename)

    await writeManifestAtomic(path, manifest)

    const bytes = await fs.readFile(path, 'utf8')
    expect(bytes).toBe(`${JSON.stringify(manifest, null, 2)}\n`)
    expect(await readManifest(path)).toEqual(manifest)
    const temporaryOpenIndex = open.mock.calls.findIndex(([file]) => String(file).includes('.tmp-'))
    expect(temporaryOpenIndex).toBeGreaterThanOrEqual(0)
    expect(rename).toHaveBeenCalledTimes(1)
    expect(open.mock.invocationCallOrder[temporaryOpenIndex]).toBeLessThan(rename.mock.invocationCallOrder[0])
    expect(rename.mock.calls[0][0]).not.toBe(path)
    expect(rename.mock.calls[0][1]).toBe(path)
    expect(await fs.readdir(dirname(path))).toEqual(['manifest.json'])
  })

  it('uses an exclusively created temporary path accepted by artifact containment', async () => {
    const root = await temporaryRoot()
    const path = resolveArtifactPath(root, artifactKey(renderId, 'manifest.json'))

    await writeManifestAtomic(path, manifest)

    const temporaryCall = vi.mocked(fs.open).mock.calls.find(([file]) => String(file).includes('.tmp-'))
    expect(temporaryCall).toBeDefined()
    const [temporaryPath, flags] = temporaryCall!
    const temporaryKey = relative(root, String(temporaryPath)).split(sep).join('/')
    expect(() => resolveArtifactPath(root, temporaryKey)).not.toThrow()
    expect(flags).toBe('wx')
  })

  it('uses an exclusively created lock path accepted by artifact containment and removes it', async () => {
    const root = await temporaryRoot()
    const path = resolveArtifactPath(root, artifactKey(renderId, 'manifest.json'))

    await writeManifestAtomic(path, manifest)

    const lockCall = vi.mocked(fs.open).mock.calls.find(([file]) => String(file).endsWith('manifest.json.lock'))
    expect(lockCall).toBeDefined()
    const [lockPath, flags] = lockCall!
    const lockKey = relative(root, String(lockPath)).split(sep).join('/')
    expect(() => resolveArtifactPath(root, lockKey)).not.toThrow()
    expect(flags).toBe('wx')
    await expect(fs.access(lockPath)).rejects.toThrow()
  })

  it('fails in a controlled way without removing a lock artifact owned by another process', async () => {
    const root = await temporaryRoot()
    const path = resolveArtifactPath(root, artifactKey(renderId, 'manifest.json'))
    const lockPath = resolveArtifactPath(root, artifactKey(renderId, 'manifest.json.lock'))
    await fs.mkdir(dirname(lockPath), { recursive: true })
    await fs.writeFile(lockPath, 'held elsewhere')

    await expect(writeManifestAtomic(path, manifest)).rejects.toThrow('manifest_write_locked')

    expect(await fs.readFile(lockPath, 'utf8')).toBe('held elsewhere')
    await expect(fs.access(path)).rejects.toThrow()
  })

  it('rejects an existing in-root symlink or junction without touching its external target', async context => {
    const root = await temporaryRoot()
    const external = await temporaryRoot()
    const runDirectory = join(root, 'video-runs', renderId)
    await fs.mkdir(dirname(runDirectory), { recursive: true })
    await fs.writeFile(join(external, 'sentinel.txt'), 'untouched')
    try {
      await fs.symlink(external, runDirectory, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (isNodeError(error) && error.code === 'EPERM') {
        context.skip('symlink or junction creation is not permitted on this Windows host')
        return
      }
      throw error
    }
    const path = resolveArtifactPath(root, artifactKey(renderId, 'manifest.json'))

    await expect(writeManifestAtomic(path, manifest)).rejects.toThrow('unsafe artifact path')

    expect(await fs.readdir(external)).toEqual(['sentinel.txt'])
    expect(await fs.readFile(join(external, 'sentinel.txt'), 'utf8')).toBe('untouched')
  })

  it('rejects a parent changed to an external junction after the temporary write', async context => {
    const root = await temporaryRoot()
    const external = await temporaryRoot()
    const runDirectory = join(root, 'video-runs', renderId)
    const movedDirectory = join(root, 'moved-run')
    const probe = join(root, 'junction-probe')
    const path = resolveArtifactPath(root, artifactKey(renderId, 'manifest.json'))
    const output = { artifactKey: artifactKey(renderId, 'final.mp4'), sha256: 'c'.repeat(64) }
    const completed: VideoRunManifest = { ...manifest, output, stage: 'completed' }
    const completedBytes = `${JSON.stringify({
      version: manifest.version,
      planId: manifest.planId,
      renderId: manifest.renderId,
      requestDigest: manifest.requestDigest,
      theme: manifest.theme,
      quote: manifest.quote,
      scenes: manifest.scenes,
      output,
      stage: 'completed',
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
    }, null, 2)}\n`
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    try {
      await actualFs.symlink(external, probe, process.platform === 'win32' ? 'junction' : 'dir')
      await actualFs.rm(probe)
    } catch (error) {
      if (isNodeError(error) && error.code === 'EPERM') {
        context.skip('symlink or junction creation is not permitted on this Windows host')
        return
      }
      throw error
    }
    await actualFs.writeFile(join(external, 'manifest.json'), completedBytes)
    let lockHandle: Awaited<ReturnType<typeof actualFs.open>> | undefined
    vi.mocked(fs.open)
      .mockImplementationOnce(async (file, flags, mode) => {
        lockHandle = await actualFs.open(file, flags, mode)
        return lockHandle
      })
      .mockImplementationOnce(async (file, flags, mode) => {
        const handle = await actualFs.open(file, flags, mode)
        const actualClose = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
          await actualClose()
          await lockHandle?.close()
          await actualFs.rename(runDirectory, movedDirectory)
          await actualFs.symlink(external, runDirectory, process.platform === 'win32' ? 'junction' : 'dir')
        })
        return handle
      })

    await expect(writeManifestAtomic(path, completed)).rejects.toThrow('unsafe artifact path')

    expect(await actualFs.readdir(external)).toEqual(['manifest.json'])
    expect(await actualFs.readFile(join(external, 'manifest.json'), 'utf8')).toBe(completedBytes)
  })

  it.each(['absolute', 'relative'])('rejects an unregistered %s manifest path before writing', async kind => {
    const root = await temporaryRoot()
    const absolutePath = join(root, `${kind}-manifest.json`)
    const directPath = kind === 'absolute' ? absolutePath : relative(process.cwd(), absolutePath)
    const unsafeWrite = writeManifestAtomic as (path: string, value: VideoRunManifest) => Promise<void>

    await expect(unsafeWrite(directPath, manifest)).rejects.toThrow('unsafe artifact path')
    await expect(fs.access(absolutePath)).rejects.toThrow()
  })

  it.each([
    ['another run', artifactKey(otherRunId, 'manifest.json')],
    ['a nested filename', artifactKey(renderId, 'nested/manifest.json')],
    ['an alternate filename', artifactKey(renderId, 'run.json')],
  ])('rejects a manifest destination registered for %s', async (_kind, key) => {
    const root = await temporaryRoot()
    const path = resolveArtifactPath(root, key)

    await expect(writeManifestAtomic(path, manifest)).rejects.toThrow('invalid manifest destination')

    expect(await fs.readdir(root)).toEqual([])
  })

  it('rejects a current manifest whose owner does not match its registered destination', async () => {
    const root = await temporaryRoot()
    const path = resolveArtifactPath(root, artifactKey(renderId, 'manifest.json'))
    const current: VideoRunManifest = { ...manifest, planId: otherRunId }
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, `${JSON.stringify(current, null, 2)}\n`)
    const currentBytes = await fs.readFile(path, 'utf8')

    await expect(writeManifestAtomic(path, manifest)).rejects.toThrow('invalid manifest destination')

    expect(await fs.readFile(path, 'utf8')).toBe(currentBytes)
  })

  it('removes the temporary file when atomic rename fails', async () => {
    const root = await temporaryRoot()
    const path = resolveArtifactPath(root, artifactKey(renderId, 'manifest.json'))
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('rename failed'))

    await expect(writeManifestAtomic(path, manifest)).rejects.toThrow('rename failed')

    expect(await fs.readdir(dirname(path))).toEqual([])
    await expect(fs.access(path)).rejects.toThrow()
  })

  it('removes a partially written temporary file when writing rejects after creation', async () => {
    const root = await temporaryRoot()
    const path = resolveArtifactPath(root, artifactKey(renderId, 'manifest.json'))
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(fs.open)
      .mockImplementationOnce((file, flags, mode) => actualFs.open(file, flags, mode))
      .mockImplementationOnce(async (file, flags, mode) => {
        const handle = await actualFs.open(file, flags, mode)
        const actualWrite = handle.writeFile.bind(handle)
        vi.spyOn(handle, 'writeFile').mockImplementationOnce(async data => {
          await actualWrite(Buffer.from(String(data).slice(0, 16)))
          throw new Error('injected write failure after creation')
        })
        return handle
      })

    await expect(writeManifestAtomic(path, manifest)).rejects.toThrow('injected write failure after creation')

    expect(await actualFs.readdir(dirname(path))).toEqual([])
    await expect(actualFs.access(path)).rejects.toThrow()
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

  it.each([
    ['fewer than four scenes', (value: VideoRunManifest) => ({ ...value, scenes: value.scenes.slice(0, 3) })],
    ['out-of-order scene indices', (value: VideoRunManifest) => ({ ...value, scenes: value.scenes.map((scene, index) => index === 3 ? { ...scene, index: 2 } : scene) })],
    ['more than one quote scene', (value: VideoRunManifest) => ({ ...value, scenes: value.scenes.map((scene, index) => index === 0 ? { ...scene, captionKind: 'quote' as const } : scene) })],
    ['quote text that differs from the selected cue', (value: VideoRunManifest) => ({ ...value, scenes: value.scenes.map(scene => scene.captionKind === 'quote' ? { ...scene, captionEn: 'Changed quote.' } : scene) })],
    ['quote cue provenance that differs from the selected cue', (value: VideoRunManifest) => ({ ...value, scenes: value.scenes.map(scene => scene.captionKind === 'quote' ? { ...scene, sourceCueIndex: 32 } : scene) })],
    ['a timestamp that differs from the quote milliseconds', (value: VideoRunManifest) => ({ ...value, scenes: value.scenes.map(scene => scene.captionKind === 'quote' ? { ...scene, sourceTimestamp: '00:00:06.000 --> 00:00:08.000' } : scene) })],
    ['cue provenance on an original scene', (value: VideoRunManifest) => ({ ...value, scenes: value.scenes.map((scene, index) => index === 0 ? { ...scene, sourceTrackId: 7 } : scene) })],
  ])('rejects a manifest with %s', async (_label, mutate) => {
    const root = await temporaryRoot()
    const path = resolveArtifactPath(root, artifactKey(renderId, 'manifest.json'))

    await expect(writeManifestAtomic(path, mutate(manifest))).rejects.toThrow('invalid manifest')
  })

  it.each([
    'https://provider.test/license',
    'See https://provider.test/license for attribution.',
    'Provider value: https://signed.test/X-Amz-Signature?value=abc',
    '//provider.test/license',
    'Provider value: //provider.test/license',
  ])('rejects a URL stored outside requiredAttributionUrl in note value %j', async note => {
    const root = await temporaryRoot()
    const path = resolveArtifactPath(root, artifactKey(renderId, 'manifest.json'))
    const value: VideoRunManifest = {
      ...manifest,
      scenes: manifest.scenes.map((scene, index) => index === 0 ? { ...scene, note } : scene),
    }

    await expect(writeManifestAtomic(path, value)).rejects.toThrow('invalid manifest')
  })

  it('retains stable attribution while excluding private provider URL forms', async () => {
    const root = await temporaryRoot()
    const path = resolveArtifactPath(root, artifactKey(renderId, 'manifest.json'))
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

  it('rejects a credential-free HTTP attribution URL because attribution must use HTTPS', async () => {
    const root = await temporaryRoot()
    const path = resolveArtifactPath(root, artifactKey(renderId, 'manifest.json'))
    const withAttribution: VideoRunManifest = {
      ...manifest,
      stage: 'downloading',
      sources: [{
        artifactKey: artifactKey(renderId, 'assets/scene-01.mp4'),
        sha256: 'b'.repeat(64),
        requiredAttributionUrl: 'http://provider.test/license',
      }],
    }

    await expect(writeManifestAtomic(path, withAttribution)).rejects.toThrow('invalid manifest')
  })

  it.each([
    'not a URL',
    'https://',
    'ftp://provider.test/license',
    'https://user:password@provider.test/license',
    'https://signed.test/license',
    'https://signed.test/X-Amz-Signature',
    'https://status.provider.test/license',
    'https://provider.test/download',
    'https://provider.test/signature',
    'https://provider.test/X-Amz-Signature',
    'https://provider.test/license?token=abc',
    'https://provider.test/license?note=token',
    'https://provider.test/license?secret=abc',
    'https://provider.test/license?credential=abc',
    'https://provider.test/license?policy=abc',
    'https://provider.test/license?expires=123',
    'https://provider.test/license?key-pair-id=abc',
    'https://provider.test/license?api_key=abc',
    'https://provider.test/license?apikey=abc',
    'https://provider.test/license?access_key=abc',
    'https://provider.test/license?accesskey=abc',
    'https://provider.test/license?sig=abc',
    'https://provider.test/license?auth=abc',
    'https://provider.test/license?X-Amz-Date=20260719T000000Z',
    'https://provider.test/license?X-Goog-Signature=abc',
    'https://provider.test/license#authorization',
    'https://provider.test/license?lang=en',
    'https://provider.test/license#details',
    'https://provider.test/media/42',
  ])('rejects unsafe required attribution URL %j', async requiredAttributionUrl => {
    const root = await temporaryRoot()
    const path = resolveArtifactPath(root, artifactKey(renderId, 'manifest.json'))
    const value: VideoRunManifest = {
      ...manifest,
      stage: 'downloading',
      sources: [{
        artifactKey: artifactKey(renderId, 'assets/scene-01.mp4'),
        sha256: 'b'.repeat(64),
        requiredAttributionUrl,
      }],
    }

    await expect(writeManifestAtomic(path, value)).rejects.toThrow('invalid manifest')
  })

  it.each([
    'api_key',
    'apikey',
    'access_key',
    'accesskey',
    'sig',
    'auth',
    'x-amz-date',
    'x-goog-signature',
    'credential',
    'policy',
    'expires',
    'key-pair-id',
  ])('rejects sensitive recursive field name %j', key => {
    expect(() => canonicalRequestDigestInput({ metadata: { [key]: 'redacted' } })).toThrow('invalid manifest')
  })

  it.each(['source', 'output'])('rejects a cross-run %s artifact key', async kind => {
    const root = await temporaryRoot()
    const path = resolveArtifactPath(root, artifactKey(otherRunId, 'manifest.json'))
    const source = { artifactKey: artifactKey(renderId, 'assets/scene-01.mp4'), sha256: 'b'.repeat(64) }
    const output = { artifactKey: artifactKey(renderId, 'final.mp4'), sha256: 'c'.repeat(64) }
    const value: VideoRunManifest = kind === 'source'
      ? { ...manifest, renderId: otherRunId, stage: 'downloading', sources: [source] }
      : { ...manifest, renderId: otherRunId, stage: 'completed', output }

    await expect(writeManifestAtomic(path, value)).rejects.toThrow('invalid manifest')
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
    const firstRoot = await temporaryRoot()
    const secondRoot = await temporaryRoot()
    const firstPath = resolveArtifactPath(firstRoot, artifactKey(renderId, 'manifest.json'))
    const secondPath = resolveArtifactPath(secondRoot, artifactKey(renderId, 'manifest.json'))
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

  it('writes completed bytes once and performs no filesystem rewrite for an identical retry', async () => {
    const root = await temporaryRoot()
    const path = resolveArtifactPath(root, artifactKey(renderId, 'manifest.json'))
    const output = { artifactKey: artifactKey(renderId, 'final.mp4'), sha256: 'c'.repeat(64) }
    const completed: VideoRunManifest = { ...manifest, output, stage: 'completed' }
    const expectedBytes = `${JSON.stringify({
      version: manifest.version,
      planId: manifest.planId,
      renderId: manifest.renderId,
      requestDigest: manifest.requestDigest,
      theme: manifest.theme,
      quote: manifest.quote,
      scenes: manifest.scenes,
      output,
      stage: 'completed',
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
    }, null, 2)}\n`

    await writeManifestAtomic(path, completed)

    expect(await fs.readFile(path, 'utf8')).toBe(expectedBytes)
    expect(await sha256File(path)).toBe(createHash('sha256').update(expectedBytes).digest('hex'))
    expect(expectedBytes).not.toContain('manifestSha256')
    vi.mocked(fs.open).mockClear()
    vi.mocked(fs.rename).mockClear()

    await writeManifestAtomic(path, completed)

    expect(vi.mocked(fs.open).mock.calls.filter(([file]) => String(file).includes('.tmp-'))).toEqual([])
    expect(vi.mocked(fs.rename)).not.toHaveBeenCalled()
    expect(await fs.readFile(path, 'utf8')).toBe(expectedBytes)
  })

  it('rejects a changed retry after completion and preserves the completed bytes', async () => {
    const root = await temporaryRoot()
    const path = resolveArtifactPath(root, artifactKey(renderId, 'manifest.json'))
    const completed: VideoRunManifest = {
      ...manifest,
      output: { artifactKey: artifactKey(renderId, 'final.mp4'), sha256: 'c'.repeat(64) },
      stage: 'completed',
    }
    await writeManifestAtomic(path, completed)
    const originalBytes = await fs.readFile(path, 'utf8')
    vi.mocked(fs.open).mockClear()
    vi.mocked(fs.rename).mockClear()

    await expect(writeManifestAtomic(path, { ...completed, theme: 'Changed after completion' }))
      .rejects.toThrow('completed_manifest_immutable')

    expect(vi.mocked(fs.open).mock.calls.filter(([file]) => String(file).includes('.tmp-'))).toEqual([])
    expect(vi.mocked(fs.rename)).not.toHaveBeenCalled()
    expect(await fs.readFile(path, 'utf8')).toBe(originalBytes)
  })

  it('serializes concurrent distinct completed writers around one immutable winner', async () => {
    const root = await temporaryRoot()
    const path = resolveArtifactPath(root, artifactKey(renderId, 'manifest.json'))
    const first: VideoRunManifest = {
      ...manifest,
      theme: 'First immutable candidate',
      output: { artifactKey: artifactKey(renderId, 'final.mp4'), sha256: 'c'.repeat(64) },
      stage: 'completed',
    }
    const second: VideoRunManifest = { ...first, theme: 'Second immutable candidate' }
    const expectedBytes = [completedBytes(first), completedBytes(second)]
    const settle = async (value: VideoRunManifest) => writeManifestAtomic(path, value)
      .then(() => ({ status: 'fulfilled' as const }))
      .catch((error: unknown) => ({ status: 'rejected' as const, error }))

    const outcomes = await Promise.all([settle(first), settle(second)])

    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejection = outcomes.find(outcome => outcome.status === 'rejected')
    expect(rejection).toBeDefined()
    expect((rejection as { error: Error }).error.message).toBe('completed_manifest_immutable')
    const winnerBytes = await fs.readFile(path, 'utf8')
    expect(expectedBytes).toContain(winnerBytes)
    const winner = winnerBytes === expectedBytes[0] ? first : second
    const changed = winner === first ? second : first
    const winnerHash = await sha256File(path)
    vi.mocked(fs.open).mockClear()
    vi.mocked(fs.rename).mockClear()

    await writeManifestAtomic(path, winner)

    expect(await sha256File(path)).toBe(winnerHash)
    expect(vi.mocked(fs.open).mock.calls.filter(([file]) => String(file).includes('.tmp-'))).toEqual([])
    expect(vi.mocked(fs.rename)).not.toHaveBeenCalled()
    await expect(writeManifestAtomic(path, changed)).rejects.toThrow('completed_manifest_immutable')
    expect(await fs.readFile(path, 'utf8')).toBe(winnerBytes)
  })

  it('coalesces concurrent identical completed writers into one manifest rename', async () => {
    const root = await temporaryRoot()
    const path = resolveArtifactPath(root, artifactKey(renderId, 'manifest.json'))
    const completed: VideoRunManifest = {
      ...manifest,
      output: { artifactKey: artifactKey(renderId, 'final.mp4'), sha256: 'c'.repeat(64) },
      stage: 'completed',
    }

    await Promise.all([
      writeManifestAtomic(path, completed),
      writeManifestAtomic(path, completed),
    ])

    expect(await fs.readFile(path, 'utf8')).toBe(completedBytes(completed))
    expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(1)
  })
})

function completedBytes(value: VideoRunManifest): string {
  return `${JSON.stringify({
    version: value.version,
    planId: value.planId,
    renderId: value.renderId,
    requestDigest: value.requestDigest,
    theme: value.theme,
    quote: value.quote,
    scenes: value.scenes,
    output: value.output,
    stage: value.stage,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }, null, 2)}\n`
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

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

  it('rejects completed reuse state containing cross-run artifact keys', () => {
    const source = { artifactKey: artifactKey(otherRunId, 'assets/scene-01.mp4'), sha256: 'b'.repeat(64) }
    const output = { artifactKey: artifactKey(otherRunId, 'final.mp4'), sha256: 'c'.repeat(64) }
    const completed: VideoRunManifest = {
      ...manifest,
      stage: 'completed',
      sources: [source],
      output,
    }
    const localFiles: LocalFileState = {
      hashes: {
        [source.artifactKey]: source.sha256,
        [output.artifactKey]: output.sha256,
      },
    }

    expect(() => nextIncompleteStage(completed, localFiles)).toThrow('invalid manifest')
  })
})
