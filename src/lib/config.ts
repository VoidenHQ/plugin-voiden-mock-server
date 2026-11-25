/**
 * Mock server config — shared by the sidebar (renderer) and the server
 * (main process). Lives in `voiden-mocks.json` at the project root so it can
 * be committed and shared (everything under .voiden/ is gitignored).
 */

export const CONFIG_FILE_NAME = 'voiden-mocks.json'

export const HTTP_METHODS = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
export type MockMethod = (typeof HTTP_METHODS)[number]

export interface MockRoute {
  id: string
  /** Optional label shown in the sidebar and the request log. */
  name?: string
  enabled: boolean
  method: MockMethod
  /** Express-style path: `/users/:id`, `/files/*`. Query strings are ignored when matching. */
  path: string
  status: number
  headers: Record<string, string>
  /** Response body, sent exactly as written. */
  body: string
  /** Wait this long before responding, to simulate a slow backend. */
  delayMs: number
}

export interface MockConfig {
  port: number
  host: string
  /** Add permissive CORS headers and answer preflight requests, so browser frontends can call the mock. */
  cors: boolean
  routes: MockRoute[]
}

export const DEFAULT_PORT = 4010
export const DEFAULT_HOST = '127.0.0.1'
export const MAX_DELAY_MS = 120_000

export function newRouteId(): string {
  return 'r_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

export function defaultRoute(): MockRoute {
  return {
    id: newRouteId(),
    name: '',
    enabled: true,
    method: 'GET',
    path: '/hello',
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: '{\n  "message": "Hello from Voiden mock server"\n}',
    delayMs: 0,
  }
}

export function defaultConfig(): MockConfig {
  return { port: DEFAULT_PORT, host: DEFAULT_HOST, cors: true, routes: [] }
}

function toInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function normalizeMethod(value: unknown): MockMethod {
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : ''
  if (upper === '*' || upper === '') return 'ANY'
  return (HTTP_METHODS as readonly string[]).includes(upper) ? (upper as MockMethod) : 'GET'
}

export function normalizePath(value: unknown): string {
  let p = typeof value === 'string' ? value.trim() : ''
  // A full URL pasted in by mistake → keep just the path.
  if (/^https?:\/\//i.test(p)) {
    try { p = new URL(p).pathname } catch { /* keep as typed */ }
  }
  p = p.split('?')[0].split('#')[0]
  if (!p.startsWith('/')) p = '/' + p
  return p
}

function normalizeHeaders(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(value)) {
    // Also accept [{ key, value }] — easier to hand-write for some people.
    for (const item of value) {
      if (item && typeof item === 'object' && typeof (item as any).key === 'string') {
        const key = (item as any).key.trim()
        if (key) out[key] = String((item as any).value ?? '')
      }
    }
    return out
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = k.trim()
      if (key) out[key] = String(v ?? '')
    }
  }
  return out
}

function normalizeBody(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  // Hand-written configs may put a JSON object/array straight in `body`.
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

export function normalizeRoute(raw: unknown): MockRoute {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    id: typeof r.id === 'string' && r.id ? r.id : newRouteId(),
    name: typeof r.name === 'string' ? r.name : '',
    enabled: r.enabled !== false,
    method: normalizeMethod(r.method),
    path: normalizePath(r.path),
    // 1xx codes are informational and can't be a final response.
    status: toInt(r.status, 200, 200, 599),
    headers: normalizeHeaders(r.headers),
    body: normalizeBody(r.body),
    delayMs: toInt(r.delayMs, 0, 0, MAX_DELAY_MS),
  }
}

/** Turn whatever is in the file (possibly hand-edited, partial or old) into a valid config. */
export function normalizeConfig(raw: unknown): MockConfig {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const host = typeof c.host === 'string' && c.host.trim() ? c.host.trim() : DEFAULT_HOST
  const routes = Array.isArray(c.routes) ? c.routes.map(normalizeRoute) : []
  // Ids must be unique — the request log and the editor key on them.
  const seen = new Set<string>()
  for (const route of routes) {
    while (seen.has(route.id)) route.id = newRouteId()
    seen.add(route.id)
  }
  return {
    port: toInt(c.port, DEFAULT_PORT, 1, 65535),
    host,
    cors: c.cors !== false,
    routes,
  }
}

export interface ParsedConfig {
  config: MockConfig
  /** Set when the file exists but isn't valid JSON — the defaults are returned instead. */
  error?: string
}

export function parseConfigText(text: string | null | undefined): ParsedConfig {
  if (text === null || text === undefined || text.trim() === '') return { config: defaultConfig() }
  try {
    return { config: normalizeConfig(JSON.parse(text)) }
  } catch (err: any) {
    return { config: defaultConfig(), error: `${CONFIG_FILE_NAME} is not valid JSON: ${err?.message || err}` }
  }
}

export function serializeConfig(config: MockConfig): string {
  return JSON.stringify(normalizeConfig(config), null, 2) + '\n'
}
