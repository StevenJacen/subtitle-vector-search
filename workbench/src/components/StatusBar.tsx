import { AlertTriangle, CheckCircle2, CircleX, Database, Film, HardDrive, Type } from 'lucide-react'
import type { HealthCheckId, HealthStatus, WorkbenchHealthReport } from '../types.js'

interface StatusBarProps {
  health?: WorkbenchHealthReport
  loading?: boolean
}

const labels: Record<HealthCheckId, string> = {
  supabase: 'Supabase',
  ollama: 'Ollama',
  vecteezy: 'Vecteezy',
  ffmpeg: 'FFmpeg',
  ffprobe: 'ffprobe',
  font: '字体',
  disk: '磁盘',
}

export function StatusBar({ health, loading = false }: StatusBarProps) {
  const status = health?.status
  return (
    <header className="status-bar" role="status" aria-label="系统状态">
      <div className="product-mark">
        <Film size={18} aria-hidden="true" />
        <span>台词视频工作台</span>
      </div>
      <div className="health-summary">
        <StatusIcon status={status} />
        <strong>{loading ? '检查中' : statusLabel(status)}</strong>
      </div>
      <div className="health-checks">
        {(health?.checks ?? []).map(check => (
          <span className={`health-chip health-chip--${check.status}`} key={check.id} title={check.message}>
            <CheckGlyph id={check.id} />
            {labels[check.id]}
            {check.id === 'vecteezy' && check.details?.quotaRemaining !== undefined && (
              <> <b>{String(check.details.quotaRemaining)} / {String(check.details.quotaLimit ?? '—')}</b></>
            )}
          </span>
        ))}
      </div>
      {health?.warnings.some(warning => warning.code === 'ollama_plaintext_dialogue') && (
        <span className="plaintext-warning" title="内部 Ollama 使用明文连接">
          <AlertTriangle size={14} aria-hidden="true" /> 明文连接
        </span>
      )}
    </header>
  )
}

function StatusIcon({ status }: { status?: HealthStatus }) {
  if (status === 'ok') return <CheckCircle2 size={16} aria-hidden="true" />
  if (status === 'error') return <CircleX size={16} aria-hidden="true" />
  return <AlertTriangle size={16} aria-hidden="true" />
}

function CheckGlyph({ id }: { id: HealthCheckId }) {
  if (id === 'supabase') return <Database size={13} aria-hidden="true" />
  if (id === 'disk') return <HardDrive size={13} aria-hidden="true" />
  if (id === 'font') return <Type size={13} aria-hidden="true" />
  return <span className="health-dot" aria-hidden="true" />
}

function statusLabel(status?: HealthStatus): string {
  if (status === 'ok') return '服务就绪'
  if (status === 'error') return '服务异常'
  return '服务降级'
}
