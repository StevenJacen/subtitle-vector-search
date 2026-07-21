// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SceneReview } from './SceneReview.js'
import type { WorkbenchCandidate, WorkbenchScene } from '../types.js'

const RUN_ID = '30000000-0000-4000-8000-000000000001'

afterEach(() => cleanup())

function candidate(resourceId: number, page = 1): WorkbenchCandidate {
  return {
    provider: 'vecteezy',
    resourceId,
    runId: RUN_ID,
    page,
    title: `候选素材 ${resourceId}`,
    previewId: `20000000-0000-4000-8000-${String(resourceId).padStart(12, '0')}`,
    orientation: 'vertical',
    licenseType: 'free',
    aiGenerated: false,
    score: 1 - resourceId / 100,
    suitabilityScore: 0.8,
    providerRank: resourceId,
  }
}

function scene(overrides: Partial<WorkbenchScene> = {}): WorkbenchScene {
  return {
    index: 0,
    cueIndex: 2,
    durationMs: 3_000,
    captionEn: 'Hope is a good thing.',
    captionZh: '希望是件好事。',
    visualConcept: 'a person facing warm daylight',
    candidates: Array.from({ length: 8 }, (_, index) => candidate(index + 1)),
    candidateStatus: 'ready',
    hasNextPage: true,
    selected: null,
    confirmed: null,
    recommended: { runId: RUN_ID, resourceId: 1 },
    ...overrides,
  }
}

describe('SceneReview', () => {
  it('renders the initial eight candidates in a stable media grid with one recommendation', () => {
    render(<SceneReview scene={scene()} onLoadMore={vi.fn()} onSelection={vi.fn()} />)

    const grid = screen.getByTestId('candidate-grid-0')
    expect(within(grid).getAllByTestId('candidate-card')).toHaveLength(8)
    expect(grid).toHaveAttribute('data-layout', 'stable')
    expect(within(grid).getAllByText('推荐')).toHaveLength(1)
  })

  it('uses the local preview endpoint and reveals a neutral fallback on media failure', () => {
    render(<SceneReview scene={scene()} onLoadMore={vi.fn()} onSelection={vi.fn()} />)

    const first = screen.getAllByTestId('candidate-card')[0]
    const preview = within(first).getByLabelText('候选素材 1 预览')
    expect(preview).toHaveAttribute('src', '/api/previews/20000000-0000-4000-8000-000000000001')
    fireEvent.error(preview)
    expect(within(first).getByText('预览不可用')).toBeInTheDocument()
  })

  it('selects and confirms a candidate through its owning run', async () => {
    const user = userEvent.setup()
    const onSelection = vi.fn(async () => undefined)
    render(<SceneReview scene={scene()} onLoadMore={vi.fn()} onSelection={onSelection} />)

    const second = screen.getAllByTestId('candidate-card')[1]
    await user.click(within(second).getByRole('button', { name: '选择候选素材 2' }))
    expect(onSelection).toHaveBeenCalledWith({ runId: RUN_ID, resourceId: 2 }, false)

    render(<SceneReview
      scene={scene({ selected: { runId: RUN_ID, resourceId: 2 } })}
      onLoadMore={vi.fn()}
      onSelection={onSelection}
    />)
    const selected = screen.getAllByTestId('candidate-card')[9]
    await user.click(within(selected).getByRole('button', { name: '确认候选素材 2' }))
    expect(onSelection).toHaveBeenLastCalledWith({ runId: RUN_ID, resourceId: 2 }, true)
  })

  it('marks confirmed selection and leaves replacement as an explicit action', () => {
    render(<SceneReview
      scene={scene({
        selected: { runId: RUN_ID, resourceId: 2 },
        confirmed: { runId: RUN_ID, resourceId: 2 },
      })}
      onLoadMore={vi.fn()}
      onSelection={vi.fn()}
    />)

    const cards = screen.getAllByTestId('candidate-card')
    expect(cards[1]).toHaveAttribute('data-confirmed', 'true')
    expect(within(cards[1]).getByText('已确认')).toBeInTheDocument()
    expect(within(cards[2]).getByRole('button', { name: '替换为候选素材 3' })).toBeInTheDocument()
  })

  it('loads another candidate page and renders deduplicated appended results', async () => {
    const user = userEvent.setup()
    const onLoadMore = vi.fn(async () => undefined)
    const candidates = [
      ...Array.from({ length: 8 }, (_, index) => candidate(index + 1)),
      candidate(8, 2),
      candidate(9, 2),
      candidate(10, 2),
    ]
    render(<SceneReview scene={scene({ candidates })} onLoadMore={onLoadMore} onSelection={vi.fn()} />)

    expect(screen.getAllByTestId('candidate-card')).toHaveLength(10)
    await user.click(screen.getByRole('button', { name: '加载更多候选' }))
    await waitFor(() => expect(onLoadMore).toHaveBeenCalledOnce())
  })

  it('keeps unavailable scenes actionable without inventing provider details', () => {
    render(<SceneReview
      scene={scene({ candidates: [], candidateStatus: 'unavailable', hasNextPage: true, recommended: null })}
      onLoadMore={vi.fn()}
      onSelection={vi.fn()}
    />)

    expect(screen.getByText('候选暂不可用')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新获取候选' })).toBeEnabled()
    expect(document.body.textContent).not.toMatch(/https?:\/\/|secret|token|api[_-]?key/i)
  })
})
