import { Film, Minus, Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { AspectRatio, CreateTaskInput } from '../types.js'

interface CreateToolbarProps {
  pending?: boolean
  onCreate(input: CreateTaskInput): Promise<void>
}

export function CreateToolbar({ pending = false, onCreate }: CreateToolbarProps) {
  const [theme, setTheme] = useState('')
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('9:16')
  const [sceneCount, setSceneCount] = useState(5)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (theme.trim() === '' || pending) return
    void onCreate({ theme: theme.trim(), aspectRatio, sceneCount })
  }

  return (
    <form className="create-toolbar" onSubmit={submit}>
      <label className="theme-field">
        <span>主题</span>
        <input
          type="text"
          value={theme}
          maxLength={300}
          placeholder="输入一句主题"
          aria-label="视频主题"
          onChange={event => setTheme(event.target.value)}
        />
      </label>
      <fieldset className="segment-control">
        <legend>画幅</legend>
        <label className={aspectRatio === '9:16' ? 'is-active' : ''}>
          <input
            type="radio"
            name="aspect"
            value="9:16"
            checked={aspectRatio === '9:16'}
            aria-label="竖屏 9:16"
            onChange={() => setAspectRatio('9:16')}
          />
          9:16
        </label>
        <label className={aspectRatio === '16:9' ? 'is-active' : ''}>
          <input
            type="radio"
            name="aspect"
            value="16:9"
            checked={aspectRatio === '16:9'}
            aria-label="横屏 16:9"
            onChange={() => setAspectRatio('16:9')}
          />
          16:9
        </label>
      </fieldset>
      <div className="scene-stepper">
        <span>场景</span>
        <button
          type="button"
          title="减少场景"
          aria-label="减少场景"
          disabled={pending || sceneCount <= 5}
          onClick={() => setSceneCount(current => Math.max(5, current - 1))}
        >
          <Minus size={16} aria-hidden="true" />
        </button>
        <input aria-label="场景数" type="number" min={5} max={10} value={sceneCount} readOnly />
        <button
          type="button"
          title="增加场景"
          aria-label="增加场景"
          disabled={pending || sceneCount >= 10}
          onClick={() => setSceneCount(current => Math.min(10, current + 1))}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>
      <button className="button button--primary create-action" type="submit" disabled={pending || theme.trim() === ''}>
        <Film size={17} aria-hidden="true" />
        {pending ? '创建中' : '创建视频任务'}
      </button>
    </form>
  )
}
