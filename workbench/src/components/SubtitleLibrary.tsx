import { Film, RefreshCw, Search } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { SubtitleSyncPanel } from './SubtitleSyncPanel.js'
import type {
  SubtitleLibrarySummary,
  SubtitleSearchResponse,
  SubtitleSearchResult,
  WorkbenchApi,
} from '../types.js'

type SubtitleLibraryApi = Pick<WorkbenchApi,
  'searchSubtitles' | 'subtitleLibrary' | 'subtitleSync' | 'startSubtitleSync' | 'stopSubtitleSync' | 'subscribeSubtitleSync'>

interface SubtitleLibraryProps {
  api: SubtitleLibraryApi
  busy?: boolean
  onCreate(result: SubtitleSearchResult): Promise<void>
}

export function SubtitleLibrary({ api, busy = false, onCreate }: SubtitleLibraryProps) {
  const [summary, setSummary] = useState<SubtitleLibrarySummary>()
  const [summaryState, setSummaryState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(10)
  const [response, setResponse] = useState<SubtitleSearchResponse>()
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [creatingKey, setCreatingKey] = useState<string | null>(null)
  const [syncOpen, setSyncOpen] = useState(false)

  useEffect(() => {
    let active = true
    void api.subtitleLibrary().then(value => {
      if (!active) return
      setSummary(value)
      setSummaryState('ready')
    }).catch(() => {
      if (active) setSummaryState('error')
    })
    return () => { active = false }
  }, [api])

  const search = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = query.trim()
    if (trimmed === '' || searchState === 'loading') return
    setSearchState('loading')
    setResponse(undefined)
    try {
      setResponse(await api.searchSubtitles({ query: trimmed, limit }))
      setSearchState('success')
    } catch {
      setSearchState('error')
    }
  }

  const create = async (result: SubtitleSearchResult) => {
    const key = resultKey(result)
    setCreatingKey(key)
    try {
      await onCreate(result)
    } finally {
      setCreatingKey(current => current === key ? null : current)
    }
  }

  return (
    <section className="subtitle-library" aria-labelledby="subtitle-library-title">
      <h1 id="subtitle-library-title" className="visually-hidden">字幕库</h1>
      <form className="subtitle-library__toolbar" onSubmit={search}>
        <label className="subtitle-search-field">
          <span className="visually-hidden">搜索台词</span>
          <input
            type="search"
            role="searchbox"
            aria-label="搜索台词"
            maxLength={500}
            value={query}
            placeholder="输入英文台词或中文主题"
            onChange={event => setQuery(event.target.value)}
          />
        </label>
        <label className="subtitle-limit-field">
          <span className="visually-hidden">结果数量</span>
          <select aria-label="结果数量" value={limit} onChange={event => setLimit(Number(event.target.value))}>
            <option value={10}>10 条</option>
            <option value={20}>20 条</option>
            <option value={50}>50 条</option>
          </select>
        </label>
        <button className="button button--primary subtitle-search-action" type="submit" disabled={query.trim() === '' || searchState === 'loading'}>
          <Search size={16} aria-hidden="true" />搜索台词
        </button>
        <div className="subtitle-library__counts" aria-label="字幕库统计">
          {summaryState === 'loading' && <span>统计加载中</span>}
          {summaryState === 'error' && <span role="status">字幕库统计暂不可用</span>}
          {summaryState === 'ready' && summary !== undefined && <>
            <span>{summary.readyMovies} 部电影</span>
            <span>{summary.readyTracks} 条轨道</span>
          </>}
        </div>
        <button className="button button--secondary subtitle-sync-action" type="button" onClick={() => setSyncOpen(true)}>
          <RefreshCw size={16} aria-hidden="true" />同步新电影
        </button>
      </form>

      {searchState === 'loading' && <p className="subtitle-search-status" role="status">正在搜索台词库</p>}
      {searchState === 'error' && <p className="operation-error" role="alert">台词搜索暂不可用</p>}
      {busy && <p className="subtitle-search-status" role="status">当前操作完成后可使用台词制作</p>}
      {response?.warning === 'query_normalization_failed' && (
        <p className="subtitle-warning" role="status">查询转换不可用，已使用原始查询</p>
      )}

      {searchState === 'success' && response?.results.length === 0 && (
        <div className="subtitle-library__empty">没有匹配的台词</div>
      )}

      {response !== undefined && response.results.length > 0 && (
        <div className="subtitle-result-list" aria-labelledby="subtitle-library-title">
          {response.results.map((result, index) => (
            <article className="subtitle-result" data-layout="responsive" data-testid={`subtitle-result-${resultKey(result)}`} key={resultKey(result)}>
              <div className="subtitle-result__movie">
                <strong>{result.movie.title}</strong>
                {result.movie.releaseYear !== null && <span>{result.movie.releaseYear}</span>}
              </div>
              <time className="subtitle-result__time">{result.timestamp}</time>
              <p className="subtitle-result__dialogue">{result.text}</p>
              <div className="subtitle-result__ranks" aria-label="检索排名">
                <span>综合排名 {index + 1}</span>
                {result.semanticRank !== null && <span>语义排名 {result.semanticRank}</span>}
                {result.fullTextRank !== null && <span>全文排名 {result.fullTextRank}</span>}
              </div>
              <button
                className="button button--secondary subtitle-result__create"
                type="button"
                disabled={busy || creatingKey !== null || result.cues.length === 0}
                onClick={() => void create(result)}
              >
                <Film size={16} aria-hidden="true" />用此台词制作
              </button>
            </article>
          ))}
        </div>
      )}

      <SubtitleSyncPanel api={api} open={syncOpen} onClose={() => setSyncOpen(false)} />
    </section>
  )
}

function resultKey(result: SubtitleSearchResult): string {
  return `${result.trackId}-${result.chunkIndex}`
}
