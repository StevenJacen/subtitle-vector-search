import { Clock3, FileCheck2, MonitorPlay, VolumeX } from 'lucide-react'
import type { WorkbenchOutput } from '../types.js'

export function FinalOutput({ output }: { output: WorkbenchOutput }) {
  return (
    <section className="final-output" aria-labelledby="final-output-title">
      <header>
        <div>
          <span className="section-kicker">制作完成</span>
          <h2 id="final-output-title">成片与完整性</h2>
        </div>
        <span className="silent-badge"><VolumeX size={15} aria-hidden="true" />无音轨</span>
      </header>
      <video
        className="final-player"
        aria-label="成片预览"
        src={output.endpoint}
        style={{ aspectRatio: `${output.width} / ${output.height}` }}
        controls
        muted
        playsInline
        preload="metadata"
      />
      <dl className="integrity-grid">
        <div><dt><MonitorPlay size={14} aria-hidden="true" />视频</dt><dd>{output.width} × {output.height}</dd></div>
        <div><dt><Clock3 size={14} aria-hidden="true" />时长</dt><dd>{(output.durationMs / 1_000).toFixed(1)} 秒</dd></div>
        <div><dt><FileCheck2 size={14} aria-hidden="true" />编码</dt><dd>H.264 · {output.pixelFormat} · {output.frameRate} fps</dd></div>
        <div><dt>大小</dt><dd>{formatBytes(output.sizeBytes)}</dd></div>
        <div className="integrity-grid__hash"><dt>SHA-256</dt><dd>{shortHash(output.sha256)}</dd></div>
      </dl>
    </section>
  )
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 12)}…${hash.slice(-8)}`
}
