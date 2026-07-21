// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubtitleLibrary } from './SubtitleLibrary.js'
import type { SubtitleSearchResponse, WorkbenchApi } from '../types.js'

afterEach(() => cleanup())

function searchResponse(overrides: Partial<SubtitleSearchResponse> = {}): SubtitleSearchResponse {
  return {
    originalQuery: 'face fear',
    normalizedQuery: 'face fear',
    warning: null,
    results: [{
      similarity: 0.87,
      rrfScore: 0.03,
      semanticRank: 2,
      fullTextRank: 4,
      movie: { id: 1, title: 'The Shawshank Redemption', releaseYear: 1994 },
      trackId: 7,
      chunkIndex: 8,
      startMs: 120_000,
      endMs: 129_000,
      timestamp: '00:02:00,000 --> 00:02:09,000',
      text: 'Get busy living, or get busy dying.',
      cues: [
        { index: 40, startMs: 120_000, endMs: 123_000, text: 'Get busy living,' },
        { index: 41, startMs: 123_000, endMs: 126_000, text: 'or get busy dying.' },
      ],
    }],
    ...overrides,
  }
}

function apiFixture(response = searchResponse()) {
  const api = {
    searchSubtitles: vi.fn(async () => response),
    subtitleLibrary: vi.fn(async () => ({ readyMovies: 12, readyTracks: 18 })),
    subtitleSync: vi.fn(async () => ({
      jobId: null,
      mode: null,
      status: 'idle' as const,
      currentMovie: null,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      message: 'Idle',
      startedAt: null,
      updatedAt: '2026-07-21T00:00:00.000Z',
    })),
    startSubtitleSync: vi.fn(),
    stopSubtitleSync: vi.fn(),
    subscribeSubtitleSync: vi.fn(() => () => undefined),
  } satisfies Pick<WorkbenchApi, 'searchSubtitles' | 'subtitleLibrary' | 'subtitleSync' | 'startSubtitleSync' | 'stopSubtitleSync' | 'subscribeSubtitleSync'>
  return api
}

describe('SubtitleLibrary', () => {
  it('marks library counts unavailable instead of reporting zero when the summary fails', async () => {
    const api = apiFixture()
    api.subtitleLibrary.mockRejectedValueOnce(new Error('service unavailable'))
    render(<SubtitleLibrary api={api} onCreate={vi.fn(async () => undefined)} />)

    expect(await screen.findByRole('status')).toHaveTextContent('字幕库统计暂不可用')
    expect(screen.queryByText('0 部电影')).not.toBeInTheDocument()
    expect(screen.queryByText('0 条轨道')).not.toBeInTheDocument()
  })

  it('searches dialogue and renders ordered rank labels without scores', async () => {
    const user = userEvent.setup()
    const api = apiFixture()
    render(<SubtitleLibrary api={api} onCreate={vi.fn(async () => undefined)} />)

    await screen.findByText('12 部电影')
    await user.type(screen.getByRole('searchbox', { name: '搜索台词' }), 'face fear')
    await user.click(screen.getByRole('button', { name: '搜索台词' }))

    const result = await screen.findByTestId('subtitle-result-7-8')
    expect(within(result).getByText('The Shawshank Redemption')).toBeVisible()
    expect(within(result).getByText('1994')).toBeVisible()
    expect(within(result).getByText('00:02:00,000 --> 00:02:09,000')).toBeVisible()
    expect(within(result).getByText('Get busy living, or get busy dying.')).toBeVisible()
    expect(within(result).getByText('综合排名 1')).toBeVisible()
    expect(within(result).getByText('语义排名 2')).toBeVisible()
    expect(within(result).getByText('全文排名 4')).toBeVisible()
    expect(result).toHaveAttribute('data-layout', 'responsive')
    expect(api.searchSubtitles).toHaveBeenCalledWith({ query: 'face fear', limit: 10 })
    expect(result).not.toHaveTextContent('0.87')
  })

  it('shows controlled warning, loading, empty, and error search states', async () => {
    const user = userEvent.setup()
    let resolveSearch: ((value: SubtitleSearchResponse) => void) | undefined
    const api = apiFixture(searchResponse({ warning: 'query_normalization_failed' }))
    api.searchSubtitles.mockImplementationOnce(() => new Promise(resolve => { resolveSearch = resolve }))
    render(<SubtitleLibrary api={api} onCreate={vi.fn(async () => undefined)} />)

    await user.type(screen.getByRole('searchbox', { name: '搜索台词' }), '面对恐惧')
    await user.click(screen.getByRole('button', { name: '搜索台词' }))
    expect(screen.getByRole('status')).toHaveTextContent('正在搜索台词库')
    resolveSearch?.(searchResponse({ warning: 'query_normalization_failed' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已使用原始查询'))

    api.searchSubtitles.mockResolvedValueOnce(searchResponse({ results: [] }))
    await user.click(screen.getByRole('button', { name: '搜索台词' }))
    expect(await screen.findByText('没有匹配的台词')).toBeVisible()

    api.searchSubtitles.mockRejectedValueOnce(new Error('offline'))
    await user.click(screen.getByRole('button', { name: '搜索台词' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('台词搜索暂不可用')
  })

  it('uses an accessible result command to hand exact creation to the workbench', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn(async () => undefined)
    const api = apiFixture()
    render(<SubtitleLibrary api={api} onCreate={onCreate} />)

    await user.type(screen.getByRole('searchbox', { name: '搜索台词' }), 'hope')
    await user.click(screen.getByRole('button', { name: '搜索台词' }))
    await user.click(await screen.findByRole('button', { name: '用此台词制作' }))

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(searchResponse().results[0]))
  })
})
