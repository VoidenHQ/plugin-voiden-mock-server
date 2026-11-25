/**
 * Route matching for the mock server. Pure, so it can be unit tested without
 * Electron or a socket.
 *
 * Path syntax:
 *   /users          exact (a trailing slash on either side is ignored)
 *   /users/:id      one segment, captured as `id`
 *   /files/*        any remaining segments (zero or more)
 *
 * The first enabled route, in config order, whose method and path match wins
 * — the same rule as Express, so people can put specific routes above
 * catch-alls.
 */

import type { MockRoute } from './config'

export interface RouteMatch {
  route: MockRoute
  params: Record<string, string>
}

function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0)
}

function safeDecode(segment: string): string {
  try { return decodeURIComponent(segment) } catch { return segment }
}

export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const pat = splitPath(pattern)
  const segs = splitPath(path)
  const params: Record<string, string> = {}

  for (let i = 0; i < pat.length; i++) {
    const p = pat[i]
    if (p === '*') {
      // Wildcard must be last; it swallows the rest (including nothing).
      params['*'] = segs.slice(i).map(safeDecode).join('/')
      return i === pat.length - 1 ? params : null
    }
    const s = segs[i]
    if (s === undefined) return null
    if (p.startsWith(':') && p.length > 1) {
      params[p.slice(1)] = safeDecode(s)
      continue
    }
    if (p !== s && safeDecode(p) !== safeDecode(s)) return null
  }
  return segs.length === pat.length ? params : null
}

function methodMatches(routeMethod: string, requestMethod: string): boolean {
  if (routeMethod === 'ANY') return true
  if (routeMethod === requestMethod) return true
  // HEAD falls back to GET routes, as every HTTP server does.
  return requestMethod === 'HEAD' && routeMethod === 'GET'
}

export function findRoute(routes: MockRoute[], method: string, path: string): RouteMatch | null {
  const m = method.toUpperCase()
  // Prefer an explicit HEAD route over a GET fallback when both match.
  if (m === 'HEAD') {
    for (const route of routes) {
      if (!route.enabled || route.method !== 'HEAD') continue
      const params = matchPath(route.path, path)
      if (params) return { route, params }
    }
  }
  for (const route of routes) {
    if (!route.enabled || !methodMatches(route.method, m)) continue
    const params = matchPath(route.path, path)
    if (params) return { route, params }
  }
  return null
}
