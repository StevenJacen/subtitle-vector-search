import { Captions, Clock3, Film, Layers3 } from 'lucide-react'
import type { WorkbenchTask } from '../types.js'

export function PassagePanel({ task }: { task: WorkbenchTask }) {
  const translations = new Map(task.scenes.map(scene => [scene.cueIndex, scene.captionZh]))
  return (
    <section className="passage-panel" aria-labelledby="task-title">
      <header className="task-heading">
        <div>
          <h1 id="task-title">{task.theme}</h1>
          <div className="movie-line">
            <Film size={15} aria-hidden="true" />
            <strong>{task.passage.movie.title}</strong>
            {task.passage.movie.releaseYear !== null && <span>{task.passage.movie.releaseYear}</span>}
          </div>
        </div>
        <div className="passage-stats">
          <span><Layers3 size={14} aria-hidden="true" />轨道 {task.passage.trackId}</span>
          <span><Captions size={14} aria-hidden="true" />{task.sceneCount} 条</span>
          <span><Clock3 size={14} aria-hidden="true" />{formatDuration(task.passage.totalDurationMs)}</span>
        </div>
      </header>
      <ol className="cue-list">
        {task.passage.cues.map(cue => (
          <li data-testid="passage-cue" key={`${cue.trackId}:${cue.cueIndex}`}>
            <div className="cue-meta">
              <b data-testid="cue-index">#{cue.cueIndex}</b>
              <time>{cue.timestamp}</time>
            </div>
            <div className="cue-copy">
              <p data-testid="caption-en" lang="en">{cue.text}</p>
              <p lang="zh-CN">{translations.get(cue.cueIndex) ?? '翻译处理中'}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1_000).toFixed(1)} 秒`
}
