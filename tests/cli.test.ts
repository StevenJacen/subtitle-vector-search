import { describe, expect, it, vi } from 'vitest'
import type { Cue, SubtitleChunk } from '../src/domain.js'
import { createProgram } from '../src/cli.js'

const env = {
  OPENSUBTITLES_API_KEY: 'open-key',
  OPENSUBTITLES_TOKEN: 'open-token',
  OPENSUBTITLES_USER_AGENT: 'research-app',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
  SUBTITLE_PERSONAL_TOKEN: 'personal-token',
}

function createDependencies(overrides: Partial<Parameters<typeof createProgram>[0]> = {}) {
  return {
    env,
    openSubtitles: {
      searchEnglishByImdb: vi.fn().mockResolvedValue([{
        subtitleId: '42', fileId: 99, fileName: 'example.srt', language: 'en',
      }]),
      downloadFile: vi.fn().mockResolvedValue({ fileName: 'example.srt', bytes: new Uint8Array([1, 2, 3]) }),
    },
    subtitleApi: {
      startImport: vi.fn().mockResolvedValue({ movieId: 7, trackId: 11, existingCueCount: 0, existingChunkCount: 0 }),
      sendBatch: vi.fn().mockResolvedValue({ acceptedCueCount: 0, acceptedChunkCount: 0 }),
      finalizeImport: vi.fn().mockResolvedValue({ trackId: 11, status: 'ready' }),
      search: vi.fn().mockResolvedValue([]),
    },
    fileExists: vi.fn().mockResolvedValue(false),
    readFile: vi.fn().mockResolvedValue(Buffer.from('synthetic subtitle')),
    writeFile: vi.fn().mockResolvedValue(undefined),
    output: vi.fn(),
    ...overrides,
  }
}

describe('subtitle CLI', () => {
  it('downloads the first subtitle candidate only when the output path does not exist', async () => {
    const dependencies = createDependencies()
    const program = createProgram(dependencies)

    await program.parseAsync(['node', 'subtitle', 'download', '--imdb', '0111161', '--output', 'downloads/example.srt'])

    expect(dependencies.openSubtitles.searchEnglishByImdb).toHaveBeenCalledWith('0111161')
    expect(dependencies.openSubtitles.downloadFile).toHaveBeenCalledWith(99)
    expect(dependencies.writeFile).toHaveBeenCalledWith('downloads/example.srt', new Uint8Array([1, 2, 3]))
  })

  it('rejects download output paths that already exist', async () => {
    const dependencies = createDependencies({ fileExists: vi.fn().mockResolvedValue(true) })
    const program = createProgram(dependencies)

    await expect(program.parseAsync([
      'node', 'subtitle', 'download', '--imdb', '0111161', '--output', 'downloads/example.srt',
    ])).rejects.toThrow('refusing to overwrite existing output')
  })

  it('imports all source cues and sends bounded cue and chunk batches without printing dialogue', async () => {
    const cues: Cue[] = Array.from({ length: 101 }, (_, index) => ({
      index,
      startMs: index * 1_000,
      endMs: index * 1_000 + 900,
      text: 'private dialogue text',
    }))
    const chunks: SubtitleChunk[] = Array.from({ length: 9 }, (_, index) => ({
      index,
      startMs: index * 1_000,
      endMs: index * 1_000 + 900,
      firstCueIndex: index,
      lastCueIndex: index,
      text: 'private dialogue text',
    }))
    const dependencies = createDependencies({
      parseSubtitleFn: vi.fn().mockReturnValue(cues),
      buildChunksFn: vi.fn().mockReturnValue(chunks),
    })
    const program = createProgram(dependencies)

    await program.parseAsync([
      'node', 'subtitle', 'import', 'downloads/example.srt', '--title', 'Example Film', '--year', '1994',
      '--imdb', 'tt0111161', '--source', 'opensubtitles',
    ])

    expect(dependencies.subtitleApi.startImport).toHaveBeenCalledWith(expect.objectContaining({
      movie: { title: 'Example Film', releaseYear: 1994, imdbId: 'tt0111161' },
      track: expect.objectContaining({ languageCode: 'en', source: 'opensubtitles' }),
    }))
    expect(dependencies.subtitleApi.sendBatch).toHaveBeenCalledTimes(2)
    for (const [batch] of (dependencies.subtitleApi.sendBatch as ReturnType<typeof vi.fn>).mock.calls) {
      expect(batch.cues.length).toBeLessThanOrEqual(100)
      expect(batch.chunks.length).toBeLessThanOrEqual(8)
    }
    expect(dependencies.subtitleApi.finalizeImport).toHaveBeenCalledWith(11)
    expect(dependencies.output).toHaveBeenCalledWith('Imported 101 cues and 9 chunks.\n')
    expect(dependencies.output).not.toHaveBeenCalledWith(expect.stringContaining('private dialogue text'))
  })

  it('prints an ordinary no-match search response as a successful result', async () => {
    const dependencies = createDependencies()
    const program = createProgram(dependencies)

    await program.parseAsync(['node', 'subtitle', 'search', 'hope during hard times', '--limit', '10'])

    expect(dependencies.subtitleApi.search).toHaveBeenCalledWith({ query: 'hope during hard times', limit: 10 })
    expect(dependencies.output).toHaveBeenCalledWith('No matching dialogue found.\n')
  })
})
