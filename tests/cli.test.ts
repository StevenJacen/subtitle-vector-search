import { describe, expect, it, vi } from 'vitest'
import type { Cue, SubtitleChunk } from '../src/domain.js'
import { createProgram } from '../src/cli.js'
import { SubtitleApiError } from '../src/supabase-api.js'

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
      failImport: vi.fn().mockResolvedValue({ trackId: 11, status: 'failed' }),
      search: vi.fn().mockResolvedValue([]),
    },
    readFile: vi.fn().mockResolvedValue(Buffer.from('synthetic subtitle')),
    writeFileExclusive: vi.fn().mockResolvedValue(undefined),
    output: vi.fn(),
    ...overrides,
  }
}

describe('subtitle CLI', () => {
  it('downloads the first subtitle candidate through exclusive file creation', async () => {
    const dependencies = createDependencies()
    const program = createProgram(dependencies)

    await program.parseAsync(['node', 'subtitle', 'download', '--imdb', '0111161', '--output', 'downloads/example.srt'])

    expect(dependencies.openSubtitles.searchEnglishByImdb).toHaveBeenCalledWith('0111161')
    expect(dependencies.openSubtitles.downloadFile).toHaveBeenCalledWith(99)
    expect(dependencies.writeFileExclusive).toHaveBeenCalledWith('downloads/example.srt', new Uint8Array([1, 2, 3]))
  })

  it('maps an exclusive-create collision to a clear no-overwrite refusal', async () => {
    const dependencies = createDependencies({
      writeFileExclusive: vi.fn().mockRejectedValue(Object.assign(new Error('exists'), { code: 'EEXIST' })),
    })
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
      subtitleApi: {
        startImport: vi.fn().mockResolvedValue({ movieId: 7, trackId: 11, existingCueCount: 0, existingChunkCount: 0 }),
        sendBatch: vi.fn()
          .mockResolvedValueOnce({ acceptedCueCount: 70, acceptedChunkCount: 5 })
          .mockResolvedValueOnce({ acceptedCueCount: 1, acceptedChunkCount: 0 }),
        finalizeImport: vi.fn().mockResolvedValue({ trackId: 11, status: 'ready' }),
        failImport: vi.fn(),
        search: vi.fn(),
      },
    })
    const program = createProgram(dependencies)

    await program.parseAsync([
      'node', 'subtitle', 'import', 'downloads/example.srt', '--title', 'Example Film', '--year', '1994',
      '--imdb', 'tt0111161', '--source', 'opensubtitles', '--source-ref', 'opensubtitles:42',
    ])

    expect(dependencies.subtitleApi.startImport).toHaveBeenCalledWith(expect.objectContaining({
      movie: { title: 'Example Film', releaseYear: 1994, imdbId: 'tt0111161' },
      track: expect.objectContaining({
        languageCode: 'en',
        source: 'opensubtitles',
        sourceRef: 'opensubtitles:42',
        sourceFileName: 'example.srt',
        rightsStatus: 'personal_research',
      }),
    }))
    expect(dependencies.subtitleApi.sendBatch).toHaveBeenCalledTimes(2)
    for (const [batch] of (dependencies.subtitleApi.sendBatch as ReturnType<typeof vi.fn>).mock.calls) {
      expect(batch.cues.length).toBeLessThanOrEqual(100)
      expect(batch.chunks.length).toBeLessThanOrEqual(8)
    }
    expect(dependencies.subtitleApi.finalizeImport).toHaveBeenCalledWith(11)
    expect(dependencies.output).toHaveBeenCalledWith('Imported 71 cues and 5 chunks.\n')
    expect(dependencies.output).not.toHaveBeenCalledWith(expect.stringContaining('private dialogue text'))
  })

  it('marks the track failed after batch retries are exhausted', async () => {
    const batchError = new SubtitleApiError('temporarily unavailable', 503, 'ingestion_transient_failure')
    const dependencies = createDependencies({
      parseSubtitleFn: vi.fn().mockReturnValue([{ index: 0, startMs: 0, endMs: 900, text: 'line' }]),
      buildChunksFn: vi.fn().mockReturnValue([{
        index: 0, startMs: 0, endMs: 900, firstCueIndex: 0, lastCueIndex: 0, text: 'line',
      }]),
      subtitleApi: {
        startImport: vi.fn().mockResolvedValue({ movieId: 7, trackId: 11, existingCueCount: 0, existingChunkCount: 0 }),
        sendBatch: vi.fn().mockRejectedValue(batchError),
        finalizeImport: vi.fn(),
        failImport: vi.fn().mockResolvedValue({ trackId: 11, status: 'failed' }),
        search: vi.fn(),
      },
    })

    await expect(createProgram(dependencies).parseAsync([
      'node', 'subtitle', 'import', 'downloads/example.srt', '--title', 'Example Film', '--year', '1994',
      '--imdb', 'tt0111161', '--source', 'manual',
    ])).rejects.toBe(batchError)

    expect(dependencies.subtitleApi.failImport).toHaveBeenCalledWith(11)
    expect(dependencies.subtitleApi.finalizeImport).not.toHaveBeenCalled()
  })

  it('retains source cues locally but rejects imports with zero usable chunks before calling the API', async () => {
    const dependencies = createDependencies({
      parseSubtitleFn: vi.fn().mockReturnValue([{ index: 0, startMs: 0, endMs: 900, text: '' }]),
      buildChunksFn: vi.fn().mockReturnValue([]),
    })
    const program = createProgram(dependencies)

    await expect(program.parseAsync([
      'node', 'subtitle', 'import', 'downloads/example.srt', '--title', 'Example Film', '--year', '1994',
      '--imdb', 'tt0111161', '--source', 'opensubtitles',
    ])).rejects.toThrow('subtitle contains no usable chunks')

    expect(dependencies.subtitleApi.startImport).not.toHaveBeenCalled()
    expect(dependencies.subtitleApi.sendBatch).not.toHaveBeenCalled()
    expect(dependencies.subtitleApi.finalizeImport).not.toHaveBeenCalled()
  })

  it('prints an ordinary no-match search response as a successful result', async () => {
    const dependencies = createDependencies()
    const program = createProgram(dependencies)

    await program.parseAsync(['node', 'subtitle', 'search', 'hope during hard times', '--limit', '10'])

    expect(dependencies.subtitleApi.search).toHaveBeenCalledWith({ query: 'hope during hard times', limit: 10 })
    expect(dependencies.output).toHaveBeenCalledWith('No matching dialogue found.\n')
  })

  it('prints ranked search results compactly and forwards an optional movie filter', async () => {
    const dependencies = createDependencies({
      subtitleApi: {
        startImport: vi.fn(),
        sendBatch: vi.fn(),
        finalizeImport: vi.fn(),
        failImport: vi.fn(),
        search: vi.fn().mockResolvedValue([{
          similarity: 0.84219,
          movie: { id: 7, title: 'Synthetic Night Walk', releaseYear: 2026 },
          trackId: 11,
          chunkIndex: 4,
          startMs: 2_500_000,
          endMs: 2_505_200,
          timestamp: '00:41:40.000 --> 00:41:45.200',
          text: 'We can keep building the lantern together.',
          cues: [
            { index: 1, startMs: 2_500_000, endMs: 2_502_000, text: 'We can keep building.' },
            { index: 2, startMs: 2_502_000, endMs: 2_505_200, text: 'I will carry the lantern.' },
          ],
        }]),
      },
    })
    const program = createProgram(dependencies)

    await program.parseAsync([
      'node', 'subtitle', 'search', 'quiet determination', '--limit', '5', '--movie-id', '7',
    ])

    expect(dependencies.subtitleApi.search).toHaveBeenCalledWith({
      query: 'quiet determination', limit: 5, movieId: 7,
    })
    expect(dependencies.output).toHaveBeenCalledWith(
      '0.842  00:41:40.000 --> 00:41:45.200\nWe can keep building the lantern together.\n',
    )
  })

  it('surfaces the structured English-only validation message from search', async () => {
    const dependencies = createDependencies({
      subtitleApi: {
        startImport: vi.fn(),
        sendBatch: vi.fn(),
        finalizeImport: vi.fn(),
        failImport: vi.fn(),
        search: vi.fn().mockRejectedValue(new SubtitleApiError(
          'English queries are required',
          400,
          'english_query_required',
        )),
      },
    })
    const program = createProgram(dependencies)

    await expect(program.parseAsync(['node', 'subtitle', 'search', '希望']))
      .rejects.toThrow('English queries are required')
  })
})
