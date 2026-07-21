// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubtitleSyncPanel } from './SubtitleSyncPanel.js'
import type { SubtitleSyncSnapshot, WorkbenchApi } from '../types.js'

afterEach(() => cleanup())

function snapshot(overrides: Partial<SubtitleSyncSnapshot> = {}): SubtitleSyncSnapshot {
  return {
    jobId: null,
    mode: null,
    status: 'idle',
    currentMovie: null,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    message: 'Idle',
    startedAt: null,
    updatedAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  }
}

function apiFixture(initial = snapshot()) {
  let listener: ((value: SubtitleSyncSnapshot) => void) | undefined
  const api = {
    subtitleSync: vi.fn(async () => initial),
    startSubtitleSync: vi.fn(async () => snapshot({
      jobId: 'sync-1',
      mode: 'automatic',
      status: 'running',
      message: 'Starting',
    })),
    stopSubtitleSync: vi.fn(async () => snapshot({ status: 'stopped', message: 'Stopped after current movie' })),
    subscribeSubtitleSync: vi.fn((next: (value: SubtitleSyncSnapshot) => void) => {
      listener = next
      return () => { listener = undefined }
    }),
  } as Pick<WorkbenchApi, 'subtitleSync' | 'startSubtitleSync' | 'stopSubtitleSync' | 'subscribeSubtitleSync'>
  return { api, emit: (value: SubtitleSyncSnapshot) => listener?.(value) }
}

describe('SubtitleSyncPanel', () => {
  it('requires confirmation before starting automatic sync', async () => {
    const user = userEvent.setup()
    const { api } = apiFixture()
    render(<SubtitleSyncPanel api={api} open onClose={vi.fn()} />)

    expect(await screen.findByRole('dialog', { name: '同步新电影' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '继续' }))
    expect(screen.getByText('确认开始自动同步？')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '开始自动同步' }))

    await waitFor(() => expect(api.startSubtitleSync).toHaveBeenCalledWith({ mode: 'automatic' }))
  })

  it('validates manual IMDb metadata before importing one movie', async () => {
    const user = userEvent.setup()
    const { api } = apiFixture()
    render(<SubtitleSyncPanel api={api} open onClose={vi.fn()} />)

    await screen.findByRole('dialog')
    await user.click(screen.getByRole('radio', { name: '手动' }))
    await user.type(screen.getByLabelText('片名'), 'The Shawshank Redemption')
    await user.type(screen.getByLabelText('上映年份'), '1994')
    await user.type(screen.getByLabelText('IMDb ID'), 'shawshank')
    await user.click(screen.getByRole('button', { name: '导入电影' }))
    expect(screen.getByRole('alert')).toHaveTextContent('IMDb ID 必须以 tt 开头')
    expect(api.startSubtitleSync).not.toHaveBeenCalled()

    await user.clear(screen.getByLabelText('IMDb ID'))
    await user.type(screen.getByLabelText('IMDb ID'), 'tt0111161')
    await user.click(screen.getByRole('button', { name: '导入电影' }))
    await waitFor(() => expect(api.startSubtitleSync).toHaveBeenCalledWith({
      mode: 'manual',
      movie: { title: 'The Shawshank Redemption', releaseYear: 1994, imdbId: 'tt0111161' },
    }))
  })

  it('shows a running conflict with live progress and cooperatively stops it', async () => {
    const user = userEvent.setup()
    const running = snapshot({
      jobId: 'sync-1',
      mode: 'automatic',
      status: 'running',
      currentMovie: { imdbId: 'tt0111161', title: 'The Shawshank Redemption', releaseYear: 1994 },
      attempted: 4,
      succeeded: 3,
      failed: 1,
      message: 'Importing English subtitles',
    })
    const { api, emit } = apiFixture(running)
    render(<SubtitleSyncPanel api={api} open onClose={vi.fn()} />)

    expect(await screen.findByText('已有同步任务正在运行')).toBeVisible()
    expect(screen.getByText('已尝试 4')).toBeVisible()
    expect(screen.getByText('已完成 3')).toBeVisible()
    expect(screen.getByText('失败 1')).toBeVisible()
    expect(screen.getByText('The Shawshank Redemption (1994)')).toBeVisible()
    expect(screen.getByRole('button', { name: '停止同步' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument()

    emit(snapshot({ ...running, attempted: 5, message: 'Saving track' }))
    expect(await screen.findByText('已尝试 5')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '停止同步' }))
    await waitFor(() => expect(api.stopSubtitleSync).toHaveBeenCalledOnce())
    expect(await screen.findByText('Stopped after current movie')).toBeVisible()
  })

  it('closes with Escape and keeps the dialog controls keyboard reachable', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { api } = apiFixture()
    render(<SubtitleSyncPanel api={api} open onClose={onClose} />)

    const dialog = await screen.findByRole('dialog')
    dialog.focus()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
    await user.tab()
    expect(screen.getByRole('button', { name: '关闭同步面板' })).toHaveFocus()
  })
})
