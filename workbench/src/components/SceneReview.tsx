import { Check, CheckCircle2, ImageOff, Plus, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { CandidateKey, WorkbenchCandidate, WorkbenchScene } from '../types.js'

interface SceneReviewProps {
  scene: WorkbenchScene
  onLoadMore(): Promise<void>
  onSelection(candidate: CandidateKey, confirmed: boolean): Promise<void>
  disabled?: boolean
}

export function SceneReview({ scene, onLoadMore, onSelection, disabled = false }: SceneReviewProps) {
  const [unavailable, setUnavailable] = useState<Set<string>>(() => new Set())
  const [pending, setPending] = useState<string | null>(null)
  const candidates = useMemo(() => deduplicateCandidates(scene.candidates), [scene.candidates])

  const run = async (key: string, operation: () => Promise<void>) => {
    if (pending !== null) return
    setPending(key)
    try {
      await operation()
    } finally {
      setPending(null)
    }
  }

  return (
    <section className="scene-review" aria-labelledby={`scene-${scene.index}-title`}>
      <header className="scene-review__header">
        <div className="scene-review__index" aria-hidden="true">{String(scene.index + 1).padStart(2, '0')}</div>
        <div className="scene-review__caption">
          <h3 id={`scene-${scene.index}-title`}>{scene.captionZh}</h3>
          <p lang="en">{scene.captionEn}</p>
        </div>
        <div className="scene-review__duration">{formatDuration(scene.durationMs)}</div>
      </header>

      {candidates.length === 0 ? (
        <div className="candidate-empty">
          <ImageOff size={20} aria-hidden="true" />
          <span>{scene.candidateStatus === 'unavailable' ? '候选暂不可用' : '没有更多候选'}</span>
        </div>
      ) : (
        <div className="candidate-grid" data-testid={`candidate-grid-${scene.index}`} data-layout="stable">
          {candidates.map(candidate => {
            const key = candidateKey(candidate)
            const selected = sameCandidate(scene.selected, candidate)
            const confirmed = sameCandidate(scene.confirmed, candidate)
            const recommended = sameCandidate(scene.recommended, candidate)
            const title = candidate.title?.trim() || `候选素材 ${candidate.resourceId}`
            const mediaUnavailable = candidate.previewId === null || unavailable.has(key)
            const actionLabel = selected && !confirmed
              ? `确认${title}`
              : scene.confirmed === null ? `选择${title}` : `替换为${title}`
            return (
              <article
                className={`candidate-card${selected ? ' is-selected' : ''}${confirmed ? ' is-confirmed' : ''}`}
                data-testid="candidate-card"
                data-confirmed={confirmed ? 'true' : 'false'}
                key={key}
              >
                <div className="candidate-card__media">
                  {mediaUnavailable ? (
                    <div className="candidate-card__fallback">
                      <ImageOff size={22} aria-hidden="true" />
                      <span>预览不可用</span>
                    </div>
                  ) : (
                    <video
                      aria-label={`${title} 预览`}
                      src={`/api/previews/${candidate.previewId}`}
                      muted
                      playsInline
                      preload="metadata"
                      onError={() => setUnavailable(current => new Set(current).add(key))}
                    />
                  )}
                  <div className="candidate-card__badges">
                    {recommended && (
                      <span className="badge badge--recommended"><Sparkles size={12} aria-hidden="true" />推荐</span>
                    )}
                    {confirmed && (
                      <span className="badge badge--confirmed"><Check size={12} aria-hidden="true" />已确认</span>
                    )}
                  </div>
                </div>
                <div className="candidate-card__body">
                  <div className="candidate-card__title" title={title}>{title}</div>
                  <div className="candidate-card__meta">
                    <span>{candidate.orientation || '方向未知'}</span>
                    <span>{candidate.licenseType || '许可待核'}</span>
                  </div>
                  {confirmed ? (
                    <div className="candidate-card__confirmed" aria-label={`${title} 已确认`}>
                      <CheckCircle2 size={16} aria-hidden="true" />
                    </div>
                  ) : (
                    <button
                      className={selected ? 'button button--primary button--small' : 'button button--secondary button--small'}
                      type="button"
                      disabled={disabled || pending !== null}
                      aria-label={actionLabel}
                      onClick={() => void run(key, () => onSelection({
                        runId: candidate.runId,
                        resourceId: candidate.resourceId,
                      }, selected))}
                    >
                      {selected ? <CheckCircle2 size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
                      {selected ? '确认' : scene.confirmed === null ? '选择' : '替换'}
                    </button>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}

      {scene.hasNextPage && (
        <button
          className="button button--secondary load-more"
          type="button"
          disabled={disabled || pending !== null}
          aria-label={candidates.length === 0 ? '重新获取候选' : '加载更多候选'}
          onClick={() => void run('load-more', onLoadMore)}
        >
          <Plus size={16} aria-hidden="true" />
          {candidates.length === 0 ? '重新获取' : '加载更多'}
        </button>
      )}
    </section>
  )
}

function deduplicateCandidates(candidates: WorkbenchCandidate[]): WorkbenchCandidate[] {
  const seen = new Set<string>()
  return candidates.filter(candidate => {
    const key = `${candidate.provider}:${candidate.resourceId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function sameCandidate(key: CandidateKey | null, candidate: CandidateKey): boolean {
  return key?.runId === candidate.runId && key.resourceId === candidate.resourceId
}

function candidateKey(candidate: CandidateKey): string {
  return `${candidate.runId}:${candidate.resourceId}`
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1_000).toFixed(1)}s`
}
