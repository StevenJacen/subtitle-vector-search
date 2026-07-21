export type AspectRatio = '9:16' | '16:9'

export type WorkbenchStage =
  | 'planning'
  | 'review'
  | 'starting'
  | 'preflight'
  | 'downloading'
  | 'probing'
  | 'rendering'
  | 'validating'
  | 'completing'
  | 'completed'
  | 'failed'

export type HealthStatus = 'ok' | 'degraded' | 'error'

export type HealthCheckId =
  | 'supabase'
  | 'ollama'
  | 'vecteezy'
  | 'ffmpeg'
  | 'ffprobe'
  | 'font'
  | 'disk'

export interface HealthCheckDetails {
  model?: string
  quotaLimit?: number | null
  quotaRemaining?: number | null
  freeBytes?: number
}

export interface WorkbenchHealthCheck {
  id: HealthCheckId
  status: HealthStatus
  message: string
  details?: HealthCheckDetails
}

export interface WorkbenchHealthReport {
  status: HealthStatus
  checks: WorkbenchHealthCheck[]
  warnings: Array<{
    code: 'ollama_plaintext_dialogue'
    message: string
  }>
}

export interface CandidateKey {
  runId: string
  resourceId: number
}

export interface WorkbenchCandidate extends CandidateKey {
  provider: 'vecteezy'
  page: number
  title: string | null
  previewId: string | null
  orientation: string | null
  licenseType: string | null
  aiGenerated: boolean | null
  score: number
  suitabilityScore: number
  providerRank: number
}

export interface PassageCue {
  trackId: number
  cueIndex: number
  startMs: number
  endMs: number
  timestamp: string
  text: string
}

export interface SelectedPassage {
  movie: {
    id: number
    title: string
    releaseYear: number | null
  }
  trackId: number
  startCueIndex: number
  endCueIndex: number
  totalDurationMs: number
  cues: PassageCue[]
}

export interface PassageSourceAnchor {
  trackId: number
  firstCueIndex: number
  lastCueIndex: number
}

export interface WorkbenchScene {
  index: number
  cueIndex: number
  durationMs: number
  captionEn: string
  captionZh: string
  visualConcept: string
  candidates: WorkbenchCandidate[]
  candidateStatus: 'ready' | 'unavailable' | 'exhausted'
  hasNextPage: boolean
  selected: CandidateKey | null
  confirmed: CandidateKey | null
  recommended: CandidateKey | null
}

export interface WorkbenchOutput {
  endpoint: string
  basename: 'final.mp4'
  sha256: string
  sizeBytes: number
  durationMs: number
  width: number
  height: number
  frameRate: 30
  videoCodec: 'h264'
  pixelFormat: 'yuv420p'
  audioCodec: null
}

export interface WorkbenchTask {
  taskId: string
  theme: string
  aspectRatio: AspectRatio
  width: number
  height: number
  sceneCount: number
  stage: WorkbenchStage
  passage: SelectedPassage
  scenes: WorkbenchScene[]
  failure?: {
    code: string
    message: string
    retryable: boolean
  }
  output?: WorkbenchOutput
  createdAt: string
  updatedAt: string
}

export interface CreateTaskInput {
  theme: string
  aspectRatio: AspectRatio
  sceneCount: number
  sourceAnchor?: PassageSourceAnchor
}

export interface WorkbenchTaskEvent {
  sequence: number
  taskId: string
  stage: WorkbenchStage
  message: string
  sceneIndex?: number
}

export interface SubtitleSearchRequest {
  query: string
  limit: number
}

export interface SubtitleLibrarySummary {
  readyTracks: number
  readyMovies: number
}

export interface SubtitleSearchResult {
  similarity: number
  rrfScore: number
  semanticRank: number | null
  fullTextRank: number | null
  movie: { id: number; title: string; releaseYear: number | null }
  trackId: number
  chunkIndex: number
  startMs: number
  endMs: number
  timestamp: string
  text: string
  cues: Array<{ index: number; startMs: number; endMs: number; text: string }>
}

export interface SubtitleSearchResponse {
  originalQuery: string
  normalizedQuery: string
  warning: 'query_normalization_failed' | null
  results: SubtitleSearchResult[]
}

export type SubtitleSyncInput =
  | { mode: 'automatic' }
  | { mode: 'manual'; movie: { imdbId: string; title: string; releaseYear: number } }

export type SubtitleSyncStatus = 'idle' | 'running' | 'completed' | 'quota_reached'
  | 'candidate_exhausted' | 'stopped' | 'configuration_error' | 'failed'

export interface SubtitleSyncSnapshot {
  jobId: string | null
  mode: 'automatic' | 'manual' | null
  status: SubtitleSyncStatus
  currentMovie: { imdbId: string; title: string; releaseYear: number } | null
  attempted: number
  succeeded: number
  failed: number
  message: string
  startedAt: string | null
  updatedAt: string
}

export interface SubtitleSyncEvent {
  sequence: number
  snapshot: SubtitleSyncSnapshot
}

export interface WorkbenchApi {
  health(): Promise<WorkbenchHealthReport>
  listTasks(): Promise<WorkbenchTask[]>
  createTask(input: CreateTaskInput): Promise<WorkbenchTask>
  getTask(taskId: string): Promise<WorkbenchTask>
  loadMore(taskId: string, sceneIndex: number): Promise<WorkbenchTask>
  selectCandidate(
    taskId: string,
    sceneIndex: number,
    candidate: CandidateKey,
    confirmed: boolean,
  ): Promise<WorkbenchTask>
  produce(taskId: string): Promise<void>
  resume(taskId: string): Promise<void>
  subscribe(taskId: string, listener: (event: WorkbenchTaskEvent) => void): () => void
  searchSubtitles?(input: SubtitleSearchRequest): Promise<SubtitleSearchResponse>
  subtitleLibrary?(): Promise<SubtitleLibrarySummary>
  subtitleSync?(): Promise<SubtitleSyncSnapshot>
  startSubtitleSync?(input: SubtitleSyncInput): Promise<SubtitleSyncSnapshot>
  stopSubtitleSync?(): Promise<SubtitleSyncSnapshot>
  subscribeSubtitleSync?(listener: (snapshot: SubtitleSyncSnapshot) => void): () => void
}
