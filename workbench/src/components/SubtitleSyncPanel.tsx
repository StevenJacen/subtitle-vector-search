import { RefreshCw, Square, X } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import type { SubtitleSyncSnapshot, WorkbenchApi } from '../types.js'

type SubtitleSyncApi = Pick<WorkbenchApi, 'subtitleSync' | 'startSubtitleSync' | 'stopSubtitleSync' | 'subscribeSubtitleSync'>

interface SubtitleSyncPanelProps {
  api: SubtitleSyncApi
  open: boolean
  onClose(): void
}

export function SubtitleSyncPanel({ api, open, onClose }: SubtitleSyncPanelProps) {
  const [snapshot, setSnapshot] = useState<SubtitleSyncSnapshot>()
  const [mode, setMode] = useState<'automatic' | 'manual'>('automatic')
  const [confirmAutomatic, setConfirmAutomatic] = useState(false)
  const [title, setTitle] = useState('')
  const [releaseYear, setReleaseYear] = useState('')
  const [imdbId, setImdbId] = useState('')
  const [pending, setPending] = useState<'start' | 'stop' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return undefined
    let active = true
    setConfirmAutomatic(false)
    setError(null)
    void api.subtitleSync().then(value => {
      if (active) setSnapshot(value)
    }).catch(() => {
      if (active) setError('无法读取同步状态')
    })
    const unsubscribe = api.subscribeSubtitleSync(value => {
      if (active) setSnapshot(value)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [api, open])

  if (!open) return null

  const running = snapshot?.status === 'running'
  const startAutomatic = async () => {
    setPending('start')
    setError(null)
    try {
      setSnapshot(await api.startSubtitleSync({ mode: 'automatic' }))
    } catch {
      setError('无法开始同步')
    } finally {
      setPending(null)
    }
  }
  const startManual = async (event: FormEvent) => {
    event.preventDefault()
    const parsedYear = Number(releaseYear)
    if (title.trim() === '') {
      setError('请填写片名')
      return
    }
    if (!Number.isInteger(parsedYear) || parsedYear < 1888 || parsedYear > 2100) {
      setError('请输入有效的上映年份')
      return
    }
    if (!/^tt\d+$/.test(imdbId.trim())) {
      setError('IMDb ID 必须以 tt 开头并包含数字')
      return
    }
    setPending('start')
    setError(null)
    try {
      setSnapshot(await api.startSubtitleSync({
        mode: 'manual',
        movie: { title: title.trim(), releaseYear: parsedYear, imdbId: imdbId.trim() },
      }))
    } catch {
      setError('无法开始同步')
    } finally {
      setPending(null)
    }
  }
  const stop = async () => {
    setPending('stop')
    setError(null)
    try {
      setSnapshot(await api.stopSubtitleSync())
    } catch {
      setError('无法停止同步')
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="sync-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section
        aria-labelledby="subtitle-sync-title"
        aria-modal="true"
        className="sync-panel"
        role="dialog"
        tabIndex={-1}
        onKeyDown={event => { if (event.key === 'Escape') onClose() }}
      >
        <header className="sync-panel__header">
          <div>
            <h2 id="subtitle-sync-title">同步新电影</h2>
            {snapshot !== undefined && <span>{syncStatusLabel(snapshot.status)}</span>}
          </div>
          <button className="icon-button" type="button" aria-label="关闭同步面板" title="关闭同步面板" onClick={onClose}>
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        {error !== null && <p className="sync-panel__error" role="alert">{error}</p>}
        {snapshot !== undefined && <SyncProgress snapshot={snapshot} />}

        {running ? (
          <div className="sync-panel__running">
            <strong>已有同步任务正在运行</strong>
            <button className="button button--danger" type="button" disabled={pending !== null} onClick={() => void stop()}>
              <Square size={15} aria-hidden="true" />停止同步
            </button>
          </div>
        ) : mode === 'automatic' ? (
          confirmAutomatic ? (
            <div className="sync-panel__confirmation">
              <strong>确认开始自动同步？</strong>
              <div>
                <button className="button button--secondary" type="button" disabled={pending !== null} onClick={() => setConfirmAutomatic(false)}>返回</button>
                <button className="button button--primary" type="button" disabled={pending !== null} onClick={() => void startAutomatic()}>
                  <RefreshCw size={16} aria-hidden="true" />开始自动同步
                </button>
              </div>
            </div>
          ) : (
            <div className="sync-panel__mode">
              <fieldset className="sync-mode-control">
                <legend>同步方式</legend>
                <label className="is-active"><input checked type="radio" name="sync-mode" aria-label="自动" onChange={() => setMode('automatic')} />自动</label>
                <label><input type="radio" name="sync-mode" aria-label="手动" onChange={() => setMode('manual')} />手动</label>
              </fieldset>
              <button className="button button--primary" type="button" disabled={pending !== null} onClick={() => setConfirmAutomatic(true)}>继续</button>
            </div>
          )
        ) : (
          <form className="sync-panel__manual" onSubmit={startManual} noValidate>
            <fieldset className="sync-mode-control">
              <legend>同步方式</legend>
              <label><input type="radio" name="sync-mode" aria-label="自动" onChange={() => setMode('automatic')} />自动</label>
              <label className="is-active"><input checked type="radio" name="sync-mode" aria-label="手动" onChange={() => setMode('manual')} />手动</label>
            </fieldset>
            <label><span>片名</span><input aria-label="片名" maxLength={300} value={title} onChange={event => setTitle(event.target.value)} /></label>
            <label><span>上映年份</span><input aria-label="上映年份" inputMode="numeric" maxLength={4} value={releaseYear} onChange={event => setReleaseYear(event.target.value)} /></label>
            <label><span>IMDb ID</span><input aria-label="IMDb ID" maxLength={20} value={imdbId} onChange={event => setImdbId(event.target.value)} /></label>
            <button className="button button--primary" type="submit" disabled={pending !== null}>
              <RefreshCw size={16} aria-hidden="true" />导入电影
            </button>
          </form>
        )}
      </section>
    </div>
  )
}

function SyncProgress({ snapshot }: { snapshot: SubtitleSyncSnapshot }) {
  return (
    <div className="sync-progress" aria-live="polite">
      {snapshot.currentMovie !== null && <p>{snapshot.currentMovie.title} ({snapshot.currentMovie.releaseYear})</p>}
      <div className="sync-progress__counts">
        <span>已尝试 {snapshot.attempted}</span>
        <span>已完成 {snapshot.succeeded}</span>
        <span>失败 {snapshot.failed}</span>
      </div>
      <p>{snapshot.message}</p>
    </div>
  )
}

function syncStatusLabel(status: SubtitleSyncSnapshot['status']): string {
  const labels: Record<SubtitleSyncSnapshot['status'], string> = {
    idle: '空闲',
    running: '正在同步',
    completed: '已完成',
    quota_reached: '配额已用尽',
    candidate_exhausted: '候选列表已完成',
    stopped: '已停止',
    configuration_error: '配置错误',
    failed: '失败',
  }
  return labels[status]
}
