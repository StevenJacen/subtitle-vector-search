import { CheckCircle2, CircleEllipsis, CircleX, Clock3 } from 'lucide-react'
import type { WorkbenchStage, WorkbenchTask } from '../types.js'

interface TaskRailProps {
  tasks: WorkbenchTask[]
  selectedTaskId?: string
  onOpen(taskId: string): void
}

export function TaskRail({ tasks, selectedTaskId, onOpen }: TaskRailProps) {
  const ordered = [...tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  return (
    <aside className="task-rail" aria-label="历史任务">
      <div className="task-rail__title">
        <Clock3 size={15} aria-hidden="true" />
        <span>历史任务</span>
        <b>{ordered.length}</b>
      </div>
      <div className="task-list">
        {ordered.map(task => (
          <button
            type="button"
            className={`task-item${task.taskId === selectedTaskId ? ' is-active' : ''}`}
            aria-label={`${task.theme}，${stageLabel(task.stage)}`}
            aria-current={task.taskId === selectedTaskId ? 'true' : undefined}
            key={task.taskId}
            onClick={() => onOpen(task.taskId)}
          >
            <span className="task-item__status"><StageIcon stage={task.stage} /></span>
            <span className="task-item__copy">
              <strong>{task.theme}</strong>
              <small>{task.sceneCount} 场景 · {task.aspectRatio} · {stageLabel(task.stage)}</small>
            </span>
          </button>
        ))}
        {ordered.length === 0 && <div className="task-list__empty">暂无任务</div>}
      </div>
    </aside>
  )
}

function StageIcon({ stage }: { stage: WorkbenchStage }) {
  if (stage === 'completed') return <CheckCircle2 size={15} aria-hidden="true" />
  if (stage === 'failed') return <CircleX size={15} aria-hidden="true" />
  return <CircleEllipsis size={15} aria-hidden="true" />
}

function stageLabel(stage: WorkbenchStage): string {
  const labels: Record<WorkbenchStage, string> = {
    planning: '规划中',
    review: '待确认',
    starting: '启动中',
    preflight: '预检中',
    downloading: '下载中',
    probing: '校验素材',
    rendering: '合成中',
    validating: '验证中',
    completing: '写入元数据',
    completed: '已完成',
    failed: '失败',
  }
  return labels[stage]
}
