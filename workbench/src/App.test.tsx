// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.js'
import type {
  WorkbenchApi,
  WorkbenchHealthReport,
  WorkbenchTask,
  WorkbenchTaskEvent,
} from './types.js'

const TASK_ID = '10000000-0000-4000-8000-000000000001'
const RUN_ID = '30000000-0000-4000-8000-000000000001'

afterEach(() => cleanup())

function task(overrides: Partial<WorkbenchTask> = {}): WorkbenchTask {
  const cues = Array.from({ length: 5 }, (_, index) => ({
    trackId: 7,
    cueIndex: index + 2,
    startMs: index * 3_000,
    endMs: (index + 1) * 3_000,
    timestamp: `00:00:${String(index * 3).padStart(2, '0')},000 --> 00:00:${String((index + 1) * 3).padStart(2, '0')},000`,
    text: `Exact line ${index + 1}`,
  }))
  return {
    taskId: TASK_ID,
    theme: '在困境中保有希望',
    aspectRatio: '9:16',
    width: 1080,
    height: 1920,
    sceneCount: 5,
    stage: 'review',
    passage: {
      movie: { id: 1, title: 'The Shawshank Redemption', releaseYear: 1994 },
      trackId: 7,
      startCueIndex: 2,
      endCueIndex: 6,
      totalDurationMs: 15_000,
      cues,
    },
    scenes: cues.map((cue, index) => ({
      index,
      cueIndex: cue.cueIndex,
      durationMs: 3_000,
      captionEn: cue.text,
      captionZh: `精确台词 ${index + 1}`,
      visualConcept: `person looking toward daylight ${index + 1}`,
      candidates: Array.from({ length: 8 }, (_, candidateIndex) => ({
        provider: 'vecteezy' as const,
        resourceId: index * 100 + candidateIndex + 1,
        runId: RUN_ID,
        page: 1,
        title: `素材 ${index + 1}-${candidateIndex + 1}`,
        previewId: `20000000-0000-4000-8000-${String(index * 100 + candidateIndex + 1).padStart(12, '0')}`,
        orientation: 'vertical',
        licenseType: 'free',
        aiGenerated: false,
        score: 0.9 - candidateIndex / 100,
        suitabilityScore: 0.8,
        providerRank: candidateIndex + 1,
      })),
      candidateStatus: 'ready' as const,
      hasNextPage: true,
      selected: null,
      confirmed: null,
      recommended: { runId: RUN_ID, resourceId: index * 100 + 1 },
    })),
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:01:00.000Z',
    ...overrides,
  }
}

function health(status: WorkbenchHealthReport['status'] = 'ok'): WorkbenchHealthReport {
  return {
    status,
    checks: [
      { id: 'supabase', status: 'ok', message: 'Connected' },
      { id: 'ollama', status, message: status === 'ok' ? 'Configured model is available' : 'Configured model is unavailable', details: { model: 'qwen3:30b' } },
      { id: 'vecteezy', status: 'ok', message: 'Account and quota are available', details: { quotaLimit: 100, quotaRemaining: 42 } },
      { id: 'ffmpeg', status: 'ok', message: 'Executable is available' },
      { id: 'ffprobe', status: 'ok', message: 'Executable is available' },
      { id: 'font', status: 'ok', message: 'Font is available' },
      { id: 'disk', status: 'ok', message: 'Disk space is available', details: { freeBytes: 8_000_000_000 } },
    ],
    warnings: [{ code: 'ollama_plaintext_dialogue', message: 'Exact dialogue is sent in plaintext.' }],
  }
}

function apiFixture(initialTasks: WorkbenchTask[] = [task()], healthReport = health()) {
  let tasks = initialTasks
  let eventListener: ((event: WorkbenchTaskEvent) => void) | undefined
  const api: WorkbenchApi = {
    health: vi.fn(async () => healthReport),
    listTasks: vi.fn(async () => tasks),
    createTask: vi.fn(async input => {
      const created = task({ theme: input.theme, aspectRatio: input.aspectRatio, sceneCount: input.sceneCount })
      tasks = [created, ...tasks]
      return created
    }),
    getTask: vi.fn(async taskId => tasks.find(item => item.taskId === taskId) ?? task()),
    loadMore: vi.fn(async () => task()),
    selectCandidate: vi.fn(async (_taskId, sceneIndex, candidate, confirmed) => {
      const current = task()
      current.scenes[sceneIndex] = {
        ...current.scenes[sceneIndex],
        selected: candidate,
        confirmed: confirmed ? candidate : null,
      }
      return current
    }),
    produce: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    subscribe: vi.fn((_taskId, listener) => {
      eventListener = listener
      return () => { eventListener = undefined }
    }),
  }
  return {
    api,
    emit(event: WorkbenchTaskEvent) {
      eventListener?.(event)
    },
  }
}

describe('App', () => {
  it('starts as the compact creation tool with bounded defaults and aspect segments', async () => {
    const { api } = apiFixture([])
    render(<App api={api} />)

    const theme = await screen.findByLabelText('视频主题')
    expect(theme).toHaveValue('')
    expect(screen.getByRole('radio', { name: '竖屏 9:16' })).toBeChecked()
    expect(screen.getByRole('radio', { name: '横屏 16:9' })).not.toBeChecked()
    expect(screen.getByLabelText('场景数')).toHaveValue(5)
    expect(screen.getByRole('button', { name: '减少场景' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '创建视频任务' })).toBeDisabled()
  })

  it('keeps scene count between five and ten and submits the selected aspect', async () => {
    const user = userEvent.setup()
    const { api } = apiFixture([])
    render(<App api={api} />)

    await screen.findByLabelText('视频主题')
    await user.type(screen.getByLabelText('视频主题'), '勇气与归途')
    await user.click(screen.getByRole('radio', { name: '横屏 16:9' }))
    for (let index = 0; index < 8; index += 1) await user.click(screen.getByRole('button', { name: '增加场景' }))
    expect(screen.getByLabelText('场景数')).toHaveValue(10)
    expect(screen.getByRole('button', { name: '增加场景' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '创建视频任务' }))
    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith({
      theme: '勇气与归途',
      aspectRatio: '16:9',
      sceneCount: 10,
    }))
  })

  it('shows service degradation and the Vecteezy quota without rendering warning internals', async () => {
    const { api } = apiFixture([], health('degraded'))
    render(<App api={api} />)

    const status = await screen.findByRole('status', { name: '系统状态' })
    expect(status).toHaveTextContent('服务降级')
    expect(status).toHaveTextContent('Vecteezy 42 / 100')
    expect(status).toHaveTextContent('Ollama')
    expect(status).not.toHaveTextContent('Exact dialogue is sent in plaintext')
  })

  it('reopens a task from the desktop history rail', async () => {
    const older = task({
      taskId: '10000000-0000-4000-8000-000000000002',
      theme: '选择与代价',
      updatedAt: '2026-07-20T00:01:00.000Z',
    })
    const { api } = apiFixture([task(), older])
    const user = userEvent.setup()
    render(<App api={api} />)

    const rail = await screen.findByLabelText('历史任务')
    await user.click(within(rail).getByRole('button', { name: /选择与代价/ }))
    await waitFor(() => expect(api.getTask).toHaveBeenCalledWith(older.taskId))
    expect(await screen.findByRole('heading', { name: '选择与代价' })).toBeInTheDocument()
  })

  it('renders consecutive bilingual cue metadata in source order', async () => {
    const { api } = apiFixture()
    render(<App api={api} />)

    expect(await screen.findByText('The Shawshank Redemption')).toBeInTheDocument()
    expect(screen.getByText('1994')).toBeInTheDocument()
    expect(screen.getByText('轨道 7')).toBeInTheDocument()
    const cueRows = screen.getAllByTestId('passage-cue')
    expect(cueRows).toHaveLength(5)
    expect(cueRows.map(row => within(row).getByTestId('cue-index').textContent)).toEqual(['#2', '#3', '#4', '#5', '#6'])
    expect(cueRows.map(row => within(row).getByTestId('caption-en').textContent)).toEqual([
      'Exact line 1', 'Exact line 2', 'Exact line 3', 'Exact line 4', 'Exact line 5',
    ])
    expect(cueRows[0]).toHaveTextContent('00:00:00,000 --> 00:00:03,000')
    expect(cueRows[0]).toHaveTextContent('精确台词 1')
  })

  it('keeps production disabled until every current selection is confirmed', async () => {
    const incomplete = task()
    incomplete.scenes = incomplete.scenes.map((scene, index) => ({
      ...scene,
      selected: { runId: RUN_ID, resourceId: index * 100 + 1 },
      confirmed: index === 4 ? null : { runId: RUN_ID, resourceId: index * 100 + 1 },
    }))
    const complete = task({ scenes: incomplete.scenes.map((scene, index) => ({
      ...scene,
      confirmed: { runId: RUN_ID, resourceId: index * 100 + 1 },
    })) })
    const fixture = apiFixture([incomplete])
    const { rerender } = render(<App api={fixture.api} initialTask={incomplete} />)

    expect(await screen.findByRole('button', { name: '开始制作' })).toBeDisabled()
    rerender(<App api={fixture.api} initialTask={complete} />)
    expect(screen.getByRole('button', { name: '开始制作' })).toBeEnabled()
  })

  it('shows stable stage progress and refreshes the task after SSE events', async () => {
    const fixture = apiFixture([task({ stage: 'downloading' })])
    render(<App api={fixture.api} initialTask={task({ stage: 'downloading' })} />)

    const progress = await screen.findByLabelText('制作进度')
    expect(progress.querySelectorAll('[data-progress-step]')).toHaveLength(7)
    const width = progress.getAttribute('data-geometry')
    fixture.emit({ taskId: TASK_ID, sequence: 3, stage: 'rendering', message: 'Rendering video' })
    await waitFor(() => expect(fixture.api.getTask).toHaveBeenCalledWith(TASK_ID))
    expect(screen.getByLabelText('制作进度')).toHaveAttribute('data-geometry', width)
  })

  it('offers controlled recovery only for retryable failures', async () => {
    const user = userEvent.setup()
    const failed = task({ stage: 'failed', failure: { code: 'render_failure', message: '视频制作失败', retryable: true } })
    const fixture = apiFixture([failed])
    render(<App api={fixture.api} initialTask={failed} />)

    expect(await screen.findByText('视频制作失败')).toBeInTheDocument()
    expect(screen.queryByTestId('candidate-grid-0')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '恢复任务' }))
    expect(fixture.api.resume).toHaveBeenCalledWith(TASK_ID)
  })

  it('returns selection failures to replacement without offering an invalid resume', async () => {
    const failed = task({
      stage: 'failed',
      failure: { code: 'selection_required', message: '需要替换当前素材', retryable: true },
    })
    const { api } = apiFixture([failed])
    render(<App api={api} initialTask={failed} />)

    expect(await screen.findByTestId('candidate-grid-0')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复任务' })).not.toBeInTheDocument()
  })

  it('shows a silent final player and integrity metadata without sensitive fields', async () => {
    const completed = task({
      stage: 'completed',
      output: {
        endpoint: `/api/tasks/${TASK_ID}/final`,
        basename: 'final.mp4',
        sha256: 'a'.repeat(64),
        sizeBytes: 12_345_678,
        durationMs: 15_000,
        width: 1080,
        height: 1920,
        frameRate: 30,
        videoCodec: 'h264',
        pixelFormat: 'yuv420p',
        audioCodec: null,
      },
    })
    const { api } = apiFixture([completed])
    const { container } = render(<App api={api} initialTask={completed} />)

    const player = await screen.findByLabelText('成片预览')
    expect(player).toHaveAttribute('src', completed.output?.endpoint)
    expect(player).toHaveProperty('muted', true)
    expect(player).toHaveStyle({ aspectRatio: '1080 / 1920' })
    expect(screen.getByText('无音轨')).toBeInTheDocument()
    expect(screen.getByText('H.264 · yuv420p · 30 fps')).toBeInTheDocument()
    expect(screen.getByText('aaaaaaaaaaaa…aaaaaaaa')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/(?:https?:\/\/|[A-Z]:\\|secret|token|api[_-]?key)/i)
  })
})
