import { randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { createReadStream } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { basename, extname, resolve } from 'node:path'
import {
  WorkbenchTaskError,
  type CandidateIdentity,
  type CreateTaskInput,
  type WorkbenchTaskService,
} from './task-service.js'
import type { WorkbenchEventBus } from './events.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const JSON_LIMIT = 32 * 1024
const PREVIEW_LIMIT = 64 * 1024 * 1024
const REDIRECT_LIMIT = 4

export interface WorkbenchHttpTaskService extends Pick<WorkbenchTaskService,
  'list' | 'create' | 'get' | 'loadMore' | 'select' | 'produce' | 'resume'> {
  events: WorkbenchEventBus
}

export interface WorkbenchHttpServerOptions {
  taskService: WorkbenchHttpTaskService
  sessionToken?: string
  health(): Promise<unknown>
  previewRegistry: { resolve(previewId: string): string | undefined | Promise<string | undefined> }
  resolveFinalPath(taskId: string): Promise<string | null>
  fetcher?: typeof fetch
  lookupHost?: (hostname: string) => Promise<string[]>
  heartbeatMs?: number
  healthCacheMs?: number
  html?: string
  renderHtml?: () => Promise<string>
  staticRoot?: string
  frontendMiddleware?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>
  logger?: (event: { code: string; status: number }) => void
}

export interface ListenWorkbenchOptions {
  port?: number
  maxPortAttempts?: number
}

export interface WorkbenchListenAddress {
  host: '127.0.0.1'
  port: number
  url: string
}

interface WorkbenchServer extends Server {
  readonly workbenchSessionToken: string
}

export function createWorkbenchHttpServer(options: WorkbenchHttpServerOptions): WorkbenchServer {
  const sessionToken = options.sessionToken ?? randomBytes(32).toString('base64url')
  if (sessionToken.length < 24 || sessionToken.length > 200) throw new Error('invalid workbench session token')
  const health = cachedHealth(options.health, options.healthCacheMs ?? 30_000)
  const effectiveOptions = { ...options, health }
  const server = createServer((request, response) => {
    void routeRequest(server, effectiveOptions, sessionToken, request, response).catch(error => {
      if (response.headersSent) {
        response.destroy()
        return
      }
      const mapped = publicHttpError(error)
      options.logger?.({ code: mapped.code, status: mapped.status })
      sendJson(response, mapped.status, { error: { code: mapped.code, message: mapped.message } }, mapped.headers)
    })
  }) as WorkbenchServer
  Object.defineProperty(server, 'workbenchSessionToken', { value: sessionToken, enumerable: false })
  return server
}

export async function listenWorkbenchServer(
  server: Server,
  options: ListenWorkbenchOptions = {},
): Promise<WorkbenchListenAddress> {
  const requested = options.port ?? 4173
  const attempts = requested === 0 ? 1 : options.maxPortAttempts ?? 20
  if (!Number.isSafeInteger(requested) || requested < 0 || requested > 65_535
    || !Number.isSafeInteger(attempts) || attempts < 1 || attempts > 100) {
    throw new Error('invalid workbench listen options')
  }
  let lastError: unknown
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = requested === 0 ? 0 : requested + offset
    if (port > 65_535) break
    try {
      await listenOnce(server, port)
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('workbench listen failed')
      return { host: '127.0.0.1', port: address.port, url: `http://127.0.0.1:${address.port}` }
    } catch (error) {
      lastError = error
      if (!isNodeError(error) || error.code !== 'EADDRINUSE' || server.listening) throw error
    }
  }
  throw lastError ?? new Error('workbench listen failed')
}

async function routeRequest(
  server: Server,
  options: WorkbenchHttpServerOptions,
  sessionToken: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  applySecurityHeaders(response)
  const origin = requestOrigin(server)
  if (origin === null || request.headers.host !== origin.slice('http://'.length)) throw httpError(403, 'forbidden', 'Request rejected')
  const method = request.method ?? ''
  const parsedUrl = new URL(request.url ?? '/', origin)
  if (parsedUrl.origin !== origin || parsedUrl.search !== '') throw httpError(400, 'invalid_request', 'Invalid request')
  if (request.headers.origin !== undefined && request.headers.origin !== origin) {
    throw httpError(403, 'forbidden', 'Request rejected')
  }
  const path = parsedUrl.pathname

  if (path === '/' && method === 'GET') {
    const html = options.renderHtml === undefined
      ? options.staticRoot === undefined
        ? options.html ?? defaultHtml()
        : await readStaticFile(options.staticRoot, 'index.html', 2 * 1024 * 1024).then(value => value.toString('utf8'))
      : await options.renderHtml()
    sendHtml(response, injectSession(html, sessionToken))
    return
  }

  if (path === '/api/health') {
    requireMethod(method, 'GET')
    sendJson(response, 200, await options.health())
    return
  }
  if (path === '/api/tasks') {
    if (method === 'GET') {
      sendJson(response, 200, { tasks: await options.taskService.list() })
      return
    }
    requireMethod(method, 'POST')
    authorizeMutation(request, origin, sessionToken)
    const input = createInput(await readJson(request))
    sendJson(response, 201, { task: await options.taskService.create(input) })
    return
  }

  const taskMatch = /^\/api\/tasks\/([0-9a-f-]+)$/.exec(path)
  if (taskMatch !== null) {
    requireMethod(method, 'GET')
    sendJson(response, 200, { task: await options.taskService.get(taskId(taskMatch[1])) })
    return
  }

  const eventsMatch = /^\/api\/tasks\/([0-9a-f-]+)\/events$/.exec(path)
  if (eventsMatch !== null) {
    requireMethod(method, 'GET')
    streamEvents(request, response, options.taskService.events, taskId(eventsMatch[1]), options.heartbeatMs ?? 15_000)
    return
  }

  const candidateMatch = /^\/api\/tasks\/([0-9a-f-]+)\/scenes\/(\d+)\/candidates$/.exec(path)
  if (candidateMatch !== null) {
    requireMethod(method, 'POST')
    authorizeMutation(request, origin, sessionToken)
    emptyObject(await readJson(request))
    const sceneIndex = boundedSceneIndex(candidateMatch[2])
    sendJson(response, 200, { task: await options.taskService.loadMore(taskId(candidateMatch[1]), sceneIndex) })
    return
  }

  const selectionMatch = /^\/api\/tasks\/([0-9a-f-]+)\/scenes\/(\d+)\/selection$/.exec(path)
  if (selectionMatch !== null) {
    requireMethod(method, 'PUT')
    authorizeMutation(request, origin, sessionToken)
    const input = selectionInput(await readJson(request))
    sendJson(response, 200, {
      task: await options.taskService.select(
        taskId(selectionMatch[1]),
        boundedSceneIndex(selectionMatch[2]),
        input.candidate,
        input.confirmed,
      ),
    })
    return
  }

  const actionMatch = /^\/api\/tasks\/([0-9a-f-]+)\/(produce|resume)$/.exec(path)
  if (actionMatch !== null) {
    requireMethod(method, 'POST')
    authorizeMutation(request, origin, sessionToken)
    emptyObject(await readJson(request))
    const id = taskId(actionMatch[1])
    const operation = actionMatch[2] === 'produce'
      ? options.taskService.produce(id)
      : options.taskService.resume(id)
    void operation.catch(() => undefined)
    sendJson(response, 202, { taskId: id, accepted: true })
    return
  }

  const finalMatch = /^\/api\/tasks\/([0-9a-f-]+)\/final$/.exec(path)
  if (finalMatch !== null) {
    requireMethod(method, 'GET')
    await serveFinal(response, request, await options.resolveFinalPath(taskId(finalMatch[1])))
    return
  }

  const previewMatch = /^\/api\/previews\/([0-9a-f-]+)$/.exec(path)
  if (previewMatch !== null) {
    requireMethod(method, 'GET')
    const id = taskId(previewMatch[1])
    const previewUrl = await options.previewRegistry.resolve(id)
    if (previewUrl === undefined) throw httpError(404, 'preview_not_found', 'Preview not found')
    await proxyPreview(request, response, previewUrl, options)
    return
  }

  if (path.startsWith('/api/')) throw httpError(404, 'not_found', 'Not found')
  requireMethod(method, 'GET')
  if (options.frontendMiddleware !== undefined && await options.frontendMiddleware(request, response)) return
  if (options.staticRoot !== undefined && await serveStaticAsset(response, options.staticRoot, path)) return
  throw httpError(404, 'not_found', 'Not found')
}

function authorizeMutation(request: IncomingMessage, origin: string, expectedToken: string): void {
  if (request.headers.origin !== origin) throw httpError(403, 'forbidden', 'Request rejected')
  const supplied = request.headers['x-workbench-session']
  if (typeof supplied !== 'string' || !constantTimeEqual(supplied, expectedToken)) {
    throw httpError(403, 'forbidden', 'Request rejected')
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const type = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (type !== 'application/json') throw httpError(415, 'unsupported_media_type', 'JSON content type required')
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > JSON_LIMIT) throw httpError(413, 'payload_too_large', 'Request body too large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    size += chunk.length
    if (size > JSON_LIMIT) throw httpError(413, 'payload_too_large', 'Request body too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw httpError(400, 'invalid_json', 'Invalid JSON')
  }
}

function createInput(value: unknown): CreateTaskInput {
  const input = exactObject(value, ['theme', 'aspectRatio', 'sceneCount'])
  if (typeof input.theme !== 'string' || input.theme.trim() === '' || input.theme.trim().length > 300
    || (input.aspectRatio !== '9:16' && input.aspectRatio !== '16:9')
    || !Number.isSafeInteger(input.sceneCount) || (input.sceneCount as number) < 5 || (input.sceneCount as number) > 10) {
    throw httpError(400, 'invalid_task', 'Invalid task')
  }
  return { theme: input.theme.trim(), aspectRatio: input.aspectRatio, sceneCount: input.sceneCount as number }
}

function selectionInput(value: unknown): { candidate: CandidateIdentity; confirmed: boolean } {
  const input = exactObject(value, ['runId', 'resourceId', 'confirmed'])
  if (typeof input.runId !== 'string' || !UUID.test(input.runId)
    || !Number.isSafeInteger(input.resourceId) || (input.resourceId as number) <= 0
    || typeof input.confirmed !== 'boolean') {
    throw httpError(400, 'invalid_selection', 'Invalid selection')
  }
  return {
    candidate: { runId: input.runId.toLowerCase(), resourceId: input.resourceId as number },
    confirmed: input.confirmed,
  }
}

function emptyObject(value: unknown): void {
  exactObject(value, [])
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw httpError(400, 'invalid_request', 'Invalid request')
  const input = value as Record<string, unknown>
  const actual = Object.keys(input).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw httpError(400, 'invalid_request', 'Invalid request')
  }
  return input
}

function taskId(value: string): string {
  if (!UUID.test(value)) throw httpError(400, 'invalid_task_id', 'Invalid task ID')
  return value.toLowerCase()
}

function boundedSceneIndex(value: string): number {
  if (!/^\d+$/.test(value)) throw httpError(400, 'invalid_scene_index', 'Invalid scene index')
  const index = Number(value)
  if (!Number.isSafeInteger(index) || index < 0 || index > 9) throw httpError(400, 'invalid_scene_index', 'Invalid scene index')
  return index
}

function streamEvents(
  request: IncomingMessage,
  response: ServerResponse,
  events: WorkbenchEventBus,
  id: string,
  heartbeatMs: number,
): void {
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 10 || heartbeatMs > 60_000) {
    throw new Error('invalid heartbeat interval')
  }
  const lastEventId = request.headers['last-event-id']
  const after = lastEventId === undefined ? 0 : Number(lastEventId)
  if (!Number.isSafeInteger(after) || after < 0) throw httpError(400, 'invalid_event_cursor', 'Invalid event cursor')
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  response.flushHeaders()
  const unsubscribe = events.subscribe(id, event => {
    response.write(`id: ${event.sequence}\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`)
  }, after)
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), heartbeatMs)
  heartbeat.unref()
  const cleanup = () => {
    clearInterval(heartbeat)
    unsubscribe()
  }
  request.once('close', cleanup)
  response.once('close', cleanup)
}

async function serveFinal(response: ServerResponse, request: IncomingMessage, filePath: string | null): Promise<void> {
  if (filePath === null) throw httpError(404, 'final_not_found', 'Final video not found')
  if (basename(filePath).toLowerCase() !== 'final.mp4') throw httpError(404, 'final_not_found', 'Final video not found')
  const stats = await lstat(filePath).catch(() => null)
  if (stats === null || !stats.isFile() || stats.isSymbolicLink()) throw httpError(404, 'final_not_found', 'Final video not found')
  const range = parseRange(request.headers.range, stats.size)
  const headers: Record<string, string | number> = {
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
  }
  if (range === null) {
    response.writeHead(200, { ...headers, 'content-length': stats.size })
    pipeFile(filePath, response)
    return
  }
  response.writeHead(206, {
    ...headers,
    'content-length': range.end - range.start + 1,
    'content-range': `bytes ${range.start}-${range.end}/${stats.size}`,
  })
  pipeFile(filePath, response, range)
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | null {
  if (value === undefined) return null
  if (value.includes(',')) throw invalidRange(size)
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (match === null || (match[1] === '' && match[2] === '')) throw invalidRange(size)
  let start: number
  let end: number
  if (match[1] === '') {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw invalidRange(size)
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start || end >= size) {
    throw invalidRange(size)
  }
  return { start, end }
}

function invalidRange(size: number): WorkbenchHttpError {
  return httpError(416, 'invalid_range', 'Invalid byte range', { 'content-range': `bytes */${size}` })
}

async function proxyPreview(
  request: IncomingMessage,
  response: ServerResponse,
  initialUrl: string,
  options: WorkbenchHttpServerOptions,
): Promise<void> {
  const fetcher = options.fetcher ?? fetch
  const lookupHost = options.lookupHost ?? defaultLookup
  let current = new URL(initialUrl)
  let upstream: Response | undefined
  for (let redirect = 0; redirect <= REDIRECT_LIMIT; redirect += 1) {
    await assertPublicPreviewUrl(current, lookupHost)
    upstream = await fetcher(current, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: previewRequestHeaders(request),
    }).catch(() => { throw httpError(502, 'preview_unavailable', 'Preview unavailable') })
    if (!isRedirect(upstream.status)) break
    const location = upstream.headers.get('location')
    if (location === null || redirect === REDIRECT_LIMIT) throw httpError(502, 'preview_unavailable', 'Preview unavailable')
    current = new URL(location, current)
  }
  if (upstream === undefined || (upstream.status !== 200 && upstream.status !== 206)) {
    throw httpError(502, 'preview_unavailable', 'Preview unavailable')
  }
  const contentType = upstream.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType === undefined || (!contentType.startsWith('video/') && !contentType.startsWith('image/'))) {
    throw httpError(502, 'preview_invalid', 'Preview unavailable')
  }
  const declaredSize = Number(upstream.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > PREVIEW_LIMIT) throw httpError(502, 'preview_too_large', 'Preview unavailable')
  const body = await readBoundedResponse(upstream, PREVIEW_LIMIT)
  const headers: Record<string, string | number> = {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'private, max-age=300',
    'accept-ranges': upstream.headers.get('accept-ranges') === 'bytes' ? 'bytes' : 'none',
  }
  const contentRange = upstream.headers.get('content-range')
  if (upstream.status === 206 && contentRange !== null && /^bytes \d+-\d+\/\d+$/.test(contentRange)) {
    headers['content-range'] = contentRange
  }
  response.writeHead(upstream.status, headers)
  response.end(body)
}

function previewRequestHeaders(request: IncomingMessage): Record<string, string> {
  const range = request.headers.range
  return typeof range === 'string' && /^bytes=\d*-\d*$/.test(range) && !range.includes(',')
    ? { range }
    : {}
}

async function assertPublicPreviewUrl(url: URL, lookupHost: (hostname: string) => Promise<string[]>): Promise<void> {
  const hostname = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || (url.port !== '' && url.port !== '443')
    || !(hostname === 'vecteezy.com' || hostname.endsWith('.vecteezy.com'))) {
    throw httpError(502, 'preview_forbidden', 'Preview unavailable')
  }
  const addresses = await lookupHost(hostname).catch(() => [])
  if (addresses.length === 0 || addresses.some(address => !isPublicAddress(address))) {
    throw httpError(502, 'preview_forbidden', 'Preview unavailable')
  }
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true })
  return results.map(result => result.address)
}

function isPublicAddress(value: string): boolean {
  const family = isIP(value)
  if (family === 4) {
    const parts = value.split('.').map(Number)
    const [a, b] = parts
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19)))
  }
  if (family === 6) {
    const normalized = value.toLowerCase().split('%', 1)[0]
    if (normalized === '::' || normalized === '::1'
      || normalized.startsWith('fc') || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff')) return false
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
    return mapped === null || isPublicAddress(mapped[1])
  }
  return false
}

async function readBoundedResponse(response: Response, limit: number): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > limit) throw httpError(502, 'preview_too_large', 'Preview unavailable')
      chunks.push(Buffer.from(item.value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

function requestOrigin(server: Server): string | null {
  const address = server.address()
  return address !== null && typeof address !== 'string' && address.address === '127.0.0.1'
    ? `http://127.0.0.1:${address.port}`
    : null
}

function requireMethod(actual: string, expected: string): void {
  if (actual !== expected) throw httpError(405, 'method_not_allowed', 'Method not allowed')
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  additionalHeaders: Record<string, string> = {},
): void {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...additionalHeaders,
  })
  response.end(body)
}

function sendHtml(response: ServerResponse, html: string): void {
  const body = Buffer.from(html)
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  response.end(body)
}

async function serveStaticAsset(response: ServerResponse, root: string, path: string): Promise<boolean> {
  if (!/^\/assets\/[A-Za-z0-9._/-]+$/.test(path)
    || path.split('/').some(segment => segment === '.' || segment === '..')) return false
  const relativePath = path.slice(1)
  let body: Buffer
  try {
    body = await readStaticFile(root, relativePath, 20 * 1024 * 1024)
  } catch {
    return false
  }
  const contentType = staticContentType(extname(relativePath))
  if (contentType === null) return false
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': /-[A-Za-z0-9_]{8,}\./.test(relativePath)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  })
  response.end(body)
  return true
}

async function readStaticFile(root: string, relativePath: string, limit: number): Promise<Buffer> {
  const staticRoot = resolve(root)
  const destination = resolve(staticRoot, ...relativePath.split('/'))
  if (destination === staticRoot || !destination.startsWith(`${staticRoot}\\`) && !destination.startsWith(`${staticRoot}/`)) {
    throw new Error('invalid static path')
  }
  const file = await lstat(destination)
  if (!file.isFile() || file.isSymbolicLink() || file.size > limit) throw new Error('invalid static file')
  return readFile(destination)
}

function staticContentType(extension: string): string | null {
  if (extension === '.js' || extension === '.mjs') return 'text/javascript; charset=utf-8'
  if (extension === '.css') return 'text/css; charset=utf-8'
  if (extension === '.json') return 'application/json; charset=utf-8'
  if (extension === '.svg') return 'image/svg+xml'
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.woff2') return 'font/woff2'
  return null
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', 'DENY')
  response.setHeader('referrer-policy', 'no-referrer')
  response.setHeader('cross-origin-resource-policy', 'same-origin')
  response.setHeader('content-security-policy', "default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self' ws://127.0.0.1:*; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
}

function injectSession(html: string, token: string): string {
  const tag = `<meta name="workbench-session" content="${escapeHtml(token)}">`
  return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : `${tag}${html}`
}

function defaultHtml(): string {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>'
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function listenOnce(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

class WorkbenchHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
    this.name = 'WorkbenchHttpError'
  }
}

function httpError(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): WorkbenchHttpError {
  return new WorkbenchHttpError(status, code, message, headers)
}

function publicHttpError(error: unknown): {
  status: number
  code: string
  message: string
  headers: Record<string, string>
} {
  if (error instanceof WorkbenchHttpError) {
    return { status: error.status, code: error.code, message: error.message, headers: error.headers }
  }
  if (error instanceof WorkbenchTaskError) {
    const controlled = controlledTaskError(error.code)
    if (controlled !== null) return { ...controlled, headers: {} }
  }
  return { status: 500, code: 'internal_error', message: 'Request failed', headers: {} }
}

function controlledTaskError(code: string): { status: number; code: string; message: string } | null {
  if (code === 'selection_required') {
    return { status: 409, code, message: 'Scene selection is required' }
  }
  if (code === 'task_not_ready') {
    return { status: 409, code, message: 'Task is not ready' }
  }
  if (code === 'metadata_failure') {
    return { status: 503, code, message: 'Video production metadata failed' }
  }
  if (code === 'output_validation_failed') {
    return { status: 409, code, message: 'Rendered video validation failed' }
  }
  return null
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

function pipeFile(
  path: string,
  response: ServerResponse,
  range?: { start: number; end: number },
): void {
  const stream = createReadStream(path, range)
  stream.once('error', () => response.destroy())
  stream.pipe(response)
}

function cachedHealth(probe: () => Promise<unknown>, ttlMs: number): () => Promise<unknown> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 5 * 60_000) {
    throw new Error('invalid health cache interval')
  }
  let cached: { value: unknown; expiresAt: number } | undefined
  let pending: Promise<unknown> | undefined
  return async () => {
    const now = Date.now()
    if (cached !== undefined && cached.expiresAt > now) return cached.value
    pending ??= probe().then(value => {
      cached = { value, expiresAt: Date.now() + ttlMs }
      return value
    }).finally(() => { pending = undefined })
    return pending
  }
}
