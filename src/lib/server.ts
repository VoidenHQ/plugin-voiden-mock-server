/**
 * The mock HTTP server. Plain Node — no Electron — so it can be tested on a
 * real socket outside the app. main-process.ts wires it to IPC.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { MockConfig, MockRoute } from './config'
import { findRoute } from './router'

/** Request bodies above this are drained but not kept in the log. */
const MAX_LOGGED_BODY_BYTES = 64 * 1024
export const MAX_LOG_ENTRIES = 200

export interface MockLogEntry {
  id: string
  time: number
  method: string
  path: string
  query: string
  requestHeaders: Record<string, string>
  requestBody: string
  requestBodyTruncated: boolean
  /** null when nothing matched (the server answered 404) or a CORS preflight was answered automatically. */
  routeId: string | null
  routeLabel: string | null
  params: Record<string, string>
  status: number
  durationMs: number
}

export interface MockServerStatus {
  running: boolean
  host: string
  port: number
  url: string | null
  projectPath: string | null
  error: string | null
  /** When the port was taken: the nearest free port above it, to offer instead. */
  suggestedPort: number | null
  /** LAN mode only: URLs other devices on the network can use (one per IPv4 interface). */
  networkUrls: string[]
  routeCount: number
}

/** This machine's IPv4 addresses on real networks (Wi-Fi, Ethernet) — not loopback. */
export function lanAddresses(): string[] {
  const out: string[] = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal || (a.family !== 'IPv4' && (a.family as unknown) !== 4)) continue
      // Skip link-local (169.254.x.x) — not reachable by other devices in practice.
      if (a.address.startsWith('169.254.')) continue
      // Prefer the usual Wi-Fi/Ethernet interfaces (en0, eth0, wlan0) first.
      if (/^(en|eth|wl)/.test(name)) out.unshift(a.address)
      else out.push(a.address)
    }
  }
  return [...new Set(out)]
}

function isAllInterfaces(host: string): boolean {
  return host === '0.0.0.0' || host === '::'
}

/** Can we listen on host:port right now? */
function portIsFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, host)
  })
}

/** First free port after `from` (checks up to 50), or null. */
export async function findFreePort(from: number, host: string): Promise<number | null> {
  for (let port = from + 1; port <= Math.min(65535, from + 50); port++) {
    if (await portIsFree(port, host)) return port
  }
  return null
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
}

export function routeLabel(route: MockRoute): string {
  return route.name?.trim() || `${route.method} ${route.path}`
}

function flattenHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    out[k] = Array.isArray(v) ? v.join(', ') : v
  }
  return out
}

function readBody(req: IncomingMessage): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let truncated = false
    req.on('data', (chunk: Buffer) => {
      if (size >= MAX_LOGGED_BODY_BYTES) { truncated = true; return }
      const room = MAX_LOGGED_BODY_BYTES - size
      if (chunk.length > room) { chunks.push(chunk.subarray(0, room)); truncated = true }
      else chunks.push(chunk)
      size += Math.min(chunk.length, room)
    })
    req.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated }))
    req.on('error', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated }))
  })
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase()
  return Object.keys(headers).some((k) => k.toLowerCase() === lower)
}

function displayHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return 'localhost'
  return host.includes(':') ? `[${host}]` : host
}

export interface MockServerEvents {
  onRequest?: (entry: MockLogEntry) => void
  onStatus?: (status: MockServerStatus) => void
}

export class MockServer {
  private server: Server | null = null
  private config: MockConfig | null = null
  private projectPath: string | null = null
  private lastError: string | null = null
  private suggestedPort: number | null = null
  private log: MockLogEntry[] = []
  private seq = 0
  /** Pending delayed responses, so stop() doesn't leave timers firing into closed sockets. */
  private timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(private readonly events: MockServerEvents = {}) {}

  get running(): boolean {
    return this.server !== null
  }

  getStatus(): MockServerStatus {
    const addr = this.server?.address() as AddressInfo | null | undefined
    const host = this.config?.host ?? '127.0.0.1'
    const port = addr?.port ?? this.config?.port ?? 0
    return {
      running: this.server !== null,
      host,
      port,
      url: this.server ? `http://${displayHost(host)}:${port}` : null,
      projectPath: this.projectPath,
      error: this.lastError,
      suggestedPort: this.suggestedPort,
      networkUrls: this.server && isAllInterfaces(host) ? lanAddresses().map((ip) => `http://${ip}:${port}`) : [],
      routeCount: this.config?.routes.filter((r) => r.enabled).length ?? 0,
    }
  }

  getLog(): MockLogEntry[] {
    return [...this.log]
  }

  clearLog(): void {
    this.log = []
  }

  /** Swap routes/CORS on a running server without dropping the socket. Port/host changes need a restart. */
  updateConfig(config: MockConfig): void {
    if (!this.server || !this.config) return
    this.config = { ...config, port: this.config.port, host: this.config.host }
    this.emitStatus()
  }

  async start(config: MockConfig, projectPath: string | null): Promise<MockServerStatus> {
    if (this.server) await this.stop()
    this.config = config
    this.projectPath = projectPath
    this.lastError = null
    this.suggestedPort = null

    const server = createServer((req, res) => { void this.handle(req, res) })
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => { server.off('listening', onListening); reject(err) }
        const onListening = () => { server.off('error', onError); resolve() }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(config.port, config.host)
      })
    } catch (err: any) {
      if (err?.code === 'EADDRINUSE') this.suggestedPort = await findFreePort(config.port, config.host)
      this.lastError = err?.code === 'EADDRINUSE'
        ? `Port ${config.port} is already used by another program.`
        : err?.code === 'EACCES'
          ? `Not allowed to listen on port ${config.port}. Pick a port above 1024.`
          : `Could not start: ${err?.message || err}`
      this.config = null
      this.emitStatus()
      return this.getStatus()
    }

    server.on('error', (err) => {
      this.lastError = `Server error: ${err.message}`
      this.emitStatus()
    })
    this.server = server
    this.emitStatus()
    return this.getStatus()
  }

  async stop(): Promise<MockServerStatus> {
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    const server = this.server
    this.server = null
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // Keep-alive connections would otherwise hold close() open indefinitely.
        ;(server as any).closeAllConnections?.()
      })
    }
    this.config = null
    this.lastError = null
    this.suggestedPort = null
    this.emitStatus()
    return this.getStatus()
  }

  private emitStatus(): void {
    this.events.onStatus?.(this.getStatus())
  }

  private record(entry: MockLogEntry): void {
    this.log.push(entry)
    if (this.log.length > MAX_LOG_ENTRIES) this.log.splice(0, this.log.length - MAX_LOG_ENTRIES)
    this.events.onRequest?.(entry)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now()
    const config = this.config
    const method = (req.method || 'GET').toUpperCase()
    const rawUrl = req.url || '/'
    const qIndex = rawUrl.indexOf('?')
    const path = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl
    const query = qIndex >= 0 ? rawUrl.slice(qIndex + 1) : ''
    const body = await readBody(req)

    const base = {
      id: `${started}-${++this.seq}`,
      time: started,
      method,
      path,
      query,
      requestHeaders: flattenHeaders(req),
      requestBody: body.text,
      requestBodyTruncated: body.truncated,
    }

    if (!config) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Mock server is stopping' }))
      return
    }

    const cors = config.cors ? CORS_HEADERS : {}
    const match = findRoute(config.routes, method, path)

    if (!match) {
      // Answer browser preflights automatically unless a route claims OPTIONS itself.
      if (method === 'OPTIONS' && config.cors) {
        res.writeHead(204, { ...cors, 'Access-Control-Max-Age': '600' })
        res.end()
        this.record({ ...base, routeId: null, routeLabel: 'CORS preflight', params: {}, status: 204, durationMs: Date.now() - started })
        return
      }
      const payload = JSON.stringify({
        error: 'No mock route matches this request',
        method,
        path,
        hint: `Add a route for ${method} ${path} in the Mock Server panel.`,
      }, null, 2)
      res.writeHead(404, { ...cors, 'Content-Type': 'application/json', 'X-Voiden-Mock': 'unmatched' })
      res.end(method === 'HEAD' ? undefined : payload)
      this.record({ ...base, routeId: null, routeLabel: null, params: {}, status: 404, durationMs: Date.now() - started })
      return
    }

    const { route, params } = match
    const respond = () => {
      if (res.destroyed) return
      const headers: Record<string, string> = { ...cors, ...route.headers }
      if (!hasHeader(headers, 'X-Voiden-Mock')) headers['X-Voiden-Mock'] = 'matched'
      try {
        res.writeHead(route.status, headers)
      } catch {
        // A header the user typed that Node rejects (e.g. a newline in a value) — tell them instead of hanging.
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Route "${routeLabel(route)}" has an invalid header` }))
        this.record({ ...base, routeId: route.id, routeLabel: routeLabel(route), params, status: 500, durationMs: Date.now() - started })
        return
      }
      // 204/304 and HEAD must not carry a body.
      const noBody = method === 'HEAD' || route.status === 204 || route.status === 304 || route.status < 200
      res.end(noBody ? undefined : route.body)
      this.record({ ...base, routeId: route.id, routeLabel: routeLabel(route), params, status: route.status, durationMs: Date.now() - started })
    }

    if (route.delayMs > 0) {
      const t = setTimeout(() => { this.timers.delete(t); respond() }, route.delayMs)
      this.timers.add(t)
    } else {
      respond()
    }
  }
}
