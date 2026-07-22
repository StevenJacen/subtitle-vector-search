import { AlertCircle, Clapperboard, Play, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createWorkbenchApi } from './api.js'
import { CreateToolbar } from './components/CreateToolbar.js'
import { FinalOutput } from './components/FinalOutput.js'
import { PassagePanel } from './components/PassagePanel.js'
import { ProductionProgress } from './components/ProductionProgress.js'
import { SceneReview } from './components/SceneReview.js'
import { StatusBar } from './components/StatusBar.js'
import { SubtitleLibrary } from './components/SubtitleLibrary.js'
import { TaskRail } from './components/TaskRail.js'
import type {
  CandidateKey,
  CreateTaskInput,
  AspectRatio,
  PassageSourceAnchor,
  SubtitleSearchResult,
  WorkbenchApi,
  WorkbenchHealthReport,
  WorkbenchTask,
} from './types.js'

const browserApi = createWorkbenchApi()
const productionStages = new Set(['starting', 'preflight', 'downloading', 'probing', 'rendering', 'validating', 'completing'])
type View = 'production' | 'library'

interface AppProps {
  api?: WorkbenchApi
  initialTask?: WorkbenchTask
}

export function App({ api = browserApi, initialTask }: AppProps) {
  const [health, setHealth] = useState<WorkbenchHealthReport>()
  const [tasks, setTasks] = useState<WorkbenchTask[]>(initialTask === undefined ? [] : [initialTask])
  const [currentTask, setCurrentTask] = useState<WorkbenchTask | undefined>(initialTask)
  const [healthLoading, setHealthLoading] = useState(true)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('production')
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('9:16')
  const [sceneCount, setSceneCount] = useState(5)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const updateTask = useCallback((task: WorkbenchTask) => {
    setCurrentTask(task)
    setTasks(current => [task, ...current.filter(item => item.taskId !== task.taskId)])
  }, [])

  useEffect(() => {
    if (initialTask !== undefined) updateTask(initialTask)
  }, [initialTask, updateTask])

  useEffect(() => {
    let active = true
    void api.health().then(value => {
      if (active) setHealth(value)
    }).catch(() => {
      if (active) setHealth({ status: 'error', checks: [], warnings: [] })
    }).finally(() => {
      if (active) setHealthLoading(false)
    })
    void api.listTasks().then(value => {
      if (!active) return
      setTasks(current => mergeTasks(current, value))
      setCurrentTask(current => current ?? value[0])
    }).catch(() => {
      if (active) setError('无法读取任务历史')
    })
    return () => { active = false }
  }, [api])

  useEffect(() => {
    if (currentTask === undefined) return undefined
    return api.subscribe(currentTask.taskId, event => {
      setCurrentTask(current => current?.taskId === event.taskId ? { ...current, stage: event.stage } : current)
      void api.getTask(event.taskId).then(updateTask).catch(() => undefined)
    })
  }, [api, currentTask?.taskId, updateTask])

  const run = useCallback(async (key: string, operation: () => Promise<void>): Promise<boolean> => {
    if (pending !== null) return false
    setPending(key)
    setError(null)
    try {
      await operation()
      return true
    } catch {
      setError('操作未完成，请重试')
      return false
    } finally {
      setPending(null)
    }
  }, [pending])

  const create = (input: CreateTaskInput) => run('create', async () => {
    updateTask(await api.createTask(input))
  })

  const createFromSubtitle = async (result: SubtitleSearchResult) => {
    const sourceAnchor = resultSourceAnchor(result)
    if (sourceAnchor === undefined) {
      setError('所选台词缺少可用的字幕锚点')
      return
    }
    const created = await create({ theme: result.text, aspectRatio, sceneCount, sourceAnchor })
    if (created) setView('production')
  }

  const openTask = (taskId: string) => {
    void run('open', async () => updateTask(await api.getTask(taskId)))
  }

  const loadMore = (sceneIndex: number) => run(`load-${sceneIndex}`, async () => {
    if (currentTask === undefined) return
    updateTask(await api.loadMore(currentTask.taskId, sceneIndex))
  })

  const select = (sceneIndex: number, candidate: CandidateKey, confirmed: boolean) => run(`select-${sceneIndex}`, async () => {
    if (currentTask === undefined) return
    updateTask(await api.selectCandidate(currentTask.taskId, sceneIndex, candidate, confirmed))
  })

  const produce = () => run('produce', async () => {
    if (currentTask === undefined) return
    await api.produce(currentTask.taskId)
    setCurrentTask(current => current === undefined ? current : { ...current, stage: 'starting' })
  })

  const resume = () => run('resume', async () => {
    if (currentTask === undefined) return
    await api.resume(currentTask.taskId)
    setCurrentTask(current => current === undefined ? current : { ...current, stage: 'starting', failure: undefined })
  })

  const allConfirmed = useMemo(() => currentTask !== undefined
    && currentTask.scenes.length === currentTask.sceneCount
    && currentTask.scenes.every(scene => sameKey(scene.selected, scene.confirmed)), [currentTask])
  const producing = currentTask !== undefined && productionStages.has(currentTask.stage)
  const selectionRequired = currentTask?.stage === 'failed' && currentTask.failure?.code === 'selection_required'
  const reviewable = currentTask?.stage === 'review' || selectionRequired
  const selectView = (next: View) => setView(next)
  const moveTab = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
    if (!keys.includes(event.key)) return
    event.preventDefault()
    const nextIndex = event.key === 'ArrowLeft' ? (index + 1) % 2
      : event.key === 'ArrowRight' ? (index + 1) % 2
        : event.key === 'Home' ? 0 : 1
    selectView(nextIndex === 0 ? 'production' : 'library')
    tabRefs.current[nextIndex]?.focus()
  }

  return (
    <div className="app-shell">
      <StatusBar health={health} loading={healthLoading} />
      <nav className="view-tabs" role="tablist" aria-label="工作台视图">
        <button
          ref={element => { tabRefs.current[0] = element }}
          aria-controls="production-view"
          aria-selected={view === 'production'}
          id="production-tab"
          role="tab"
          tabIndex={view === 'production' ? 0 : -1}
          type="button"
          onClick={() => selectView('production')}
          onKeyDown={event => moveTab(event, 0)}
        >
          <Clapperboard size={16} aria-hidden="true" />视频制作
        </button>
        <button
          ref={element => { tabRefs.current[1] = element }}
          aria-controls="library-view"
          aria-selected={view === 'library'}
          id="library-tab"
          role="tab"
          tabIndex={view === 'library' ? 0 : -1}
          type="button"
          onClick={() => selectView('library')}
          onKeyDown={event => moveTab(event, 1)}
        >字幕库</button>
      </nav>
      <div className={`workbench-layout${view === 'library' ? ' workbench-layout--library' : ''}`}>
        {view === 'production' && <TaskRail tasks={tasks} selectedTaskId={currentTask?.taskId} onOpen={openTask} />}
        <main className="workspace">
          {error !== null && <div className="operation-error" role="alert"><AlertCircle size={16} aria-hidden="true" />{error}</div>}
          {view === 'production' ? (
            <section id="production-view" role="tabpanel" aria-labelledby="production-tab">
              <CreateToolbar
                aspectRatio={aspectRatio}
                sceneCount={sceneCount}
                pending={pending === 'create'}
                onAspectRatioChange={setAspectRatio}
                onSceneCountChange={setSceneCount}
                onCreate={async input => { await create(input) }}
              />
              {currentTask === undefined ? (
                <div className="workspace-empty">输入主题后创建任务</div>
              ) : (
                <>
                  <PassagePanel task={currentTask} />
                  {producing && <ProductionProgress stage={currentTask.stage} />}
                  {currentTask.stage === 'failed' && currentTask.failure !== undefined && (
                    <section className="failure-panel" role="alert">
                      <div><AlertCircle size={18} aria-hidden="true" /><strong>{currentTask.failure.message}</strong></div>
                      {currentTask.failure.retryable && !selectionRequired && (
                        <button className="button button--danger" type="button" disabled={pending !== null} onClick={() => void resume()}>
                          <RotateCcw size={16} aria-hidden="true" />恢复任务
                        </button>
                      )}
                    </section>
                  )}
                  {currentTask.stage === 'completed' && currentTask.output !== undefined ? (
                    <FinalOutput output={currentTask.output} />
                  ) : reviewable ? (
                    <div className="scene-list">
                      {currentTask.scenes.map(scene => (
                        <SceneReview
                          key={scene.index}
                          scene={scene}
                          disabled={pending !== null}
                          onLoadMore={async () => { await loadMore(scene.index) }}
                          onSelection={async (candidate, confirmed) => { await select(scene.index, candidate, confirmed) }}
                        />
                      ))}
                      <div className="production-action">
                        <span>{currentTask.scenes.filter(scene => sameKey(scene.selected, scene.confirmed)).length} / {currentTask.sceneCount} 已确认</span>
                        <button
                          className="button button--primary"
                          type="button"
                          aria-label="开始制作"
                          disabled={!allConfirmed || currentTask.stage !== 'review' || pending !== null}
                          onClick={() => void produce()}
                        >
                          <Play size={17} aria-hidden="true" />开始制作
                        </button>
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </section>
          ) : (
            <section id="library-view" role="tabpanel" aria-labelledby="library-tab">
              <SubtitleLibrary api={api} busy={pending !== null} onCreate={createFromSubtitle} />
            </section>
          )}
        </main>
      </div>
    </div>
  )
}

function sameKey(left: CandidateKey | null, right: CandidateKey | null): boolean {
  return left !== null && right !== null && left.runId === right.runId && left.resourceId === right.resourceId
}

function mergeTasks(current: WorkbenchTask[], incoming: WorkbenchTask[]): WorkbenchTask[] {
  const tasks = new Map(current.map(task => [task.taskId, task]))
  for (const task of incoming) tasks.set(task.taskId, task)
  return [...tasks.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function resultSourceAnchor(result: SubtitleSearchResult): PassageSourceAnchor | undefined {
  if (result.cues.length === 0) return undefined
  const cueIndexes = result.cues.map(cue => cue.index)
  return {
    trackId: result.trackId,
    firstCueIndex: Math.min(...cueIndexes),
    lastCueIndex: Math.max(...cueIndexes),
  }
}
