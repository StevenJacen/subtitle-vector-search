import { Check, Circle } from 'lucide-react'
import type { WorkbenchStage } from '../types.js'

const steps = [
  ['starting', '启动'],
  ['preflight', '预检'],
  ['downloading', '下载'],
  ['probing', '校验'],
  ['rendering', '合成'],
  ['validating', '验证'],
  ['completing', '入库'],
] as const

export function ProductionProgress({ stage }: { stage: WorkbenchStage }) {
  const activeIndex = stage === 'completed'
    ? steps.length
    : steps.findIndex(([value]) => value === stage)
  return (
    <section className="production-progress" aria-label="制作进度" data-geometry="seven-fixed-steps">
      {steps.map(([value, label], index) => {
        const complete = activeIndex > index
        const active = activeIndex === index
        return (
          <div
            className={`progress-step${complete ? ' is-complete' : ''}${active ? ' is-active' : ''}`}
            data-progress-step={value}
            key={value}
          >
            <span>{complete ? <Check size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}</span>
            <b>{label}</b>
          </div>
        )
      })}
    </section>
  )
}
