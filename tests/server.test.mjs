import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Bundle the TS sources (config + router + server) into one ESM module for Node.
async function load() {
  const entry = fileURLToPath(new URL('./entry.ts', import.meta.url))
  const result = await build({
    stdin: {
      contents: `export * from '../src/lib/config'; export * from '../src/lib/router'; export * from '../src/lib/server';`,
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'ts',
      sourcefile: entry,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  })
  const code = result.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}

const lib = await load()

// ─── config ────────────────────────────────────────────────────────────────

test('normalizeConfig fills defaults and cleans routes', () => {
  const c = lib.normalizeConfig({
    port: '5000',
    routes: [
      { method: 'post', path: 'users', status: 99, delayMs: -5, headers: [{ key: 'X-A', value: 1 }], body: { ok: true } },
      { method: '*', path: 'http://example.com/a/b?x=1' },
    ],
  })
  assert.equal(c.port, 5000)
  assert.equal(c.host, '127.0.0.1')
  assert.equal(c.cors, true)
  const [a, b] = c.routes
  assert.equal(a.method, 'POST')
  assert.equal(a.path, '/users')
  assert.equal(a.status, 200)
  assert.equal(a.delayMs, 0)
  assert.deepEqual(a.headers, { 'X-A': '1' })
  assert.equal(a.body, '{\n  "ok": true\n}')
  assert.equal(b.method, 'ANY')
  assert.equal(b.path, '/a/b')
  assert.notEqual(a.id, b.id)
})

test('normalizeConfig makes duplicate ids unique', () => {
  const c = lib.normalizeConfig({ routes: [{ id: 'x', path: '/a' }, { id: 'x', path: '/b' }] })
  assert.notEqual(c.routes[0].id, c.routes[1].id)
})

test('parseConfigText reports invalid JSON without throwing', () => {
  const r = lib.parseConfigText('{ nope')
  assert.ok(r.error)
  assert.deepEqual(r.config.routes, [])
  assert.equal(lib.parseConfigText('').error, undefined)
})

// ─── router ────────────────────────────────────────────────────────────────

test('matchPath handles exact, params, wildcard and trailing slashes', () => {
  assert.deepEqual(lib.matchPath('/users', '/users/'), {})
  assert.equal(lib.matchPath('/users', '/users/1'), null)
  assert.deepEqual(lib.matchPath('/users/:id', '/users/42'), { id: '42' })
  assert.deepEqual(lib.matchPath('/users/:id', '/users/a%20b'), { id: 'a b' })
  assert.equal(lib.matchPath('/users/:id', '/users'), null)
  assert.deepEqual(lib.matchPath('/files/*', '/files/a/b.txt'), { '*': 'a/b.txt' })
  assert.deepEqual(lib.matchPath('/files/*', '/files'), { '*': '' })
  assert.deepEqual(lib.matchPath('/*', '/anything/at/all'), { '*': 'anything/at/all' })
})

test('findRoute: first enabled match wins, ANY and HEAD→GET fallback', () => {
  const routes = lib.normalizeConfig({
    routes: [
      { id: 'off', method: 'GET', path: '/users/me', enabled: false },
      { id: 'me', method: 'GET', path: '/users/me' },
      { id: 'byId', method: 'GET', path: '/users/:id' },
      { id: 'any', method: 'ANY', path: '/echo' },
    ],
  }).routes
  assert.equal(lib.findRoute(routes, 'GET', '/users/me').route.id, 'me')
  assert.equal(lib.findRoute(routes, 'get', '/users/7').route.id, 'byId')
  assert.equal(lib.findRoute(routes, 'HEAD', '/users/7').route.id, 'byId')
  assert.equal(lib.findRoute(routes, 'DELETE', '/echo').route.id, 'any')
  assert.equal(lib.findRoute(routes, 'POST', '/users/7'), null)
})

// ─── server (real socket) ──────────────────────────────────────────────────

async function withServer(config, fn) {
  const events = { requests: [], statuses: [] }
  const server = new lib.MockServer({
    onRequest: (e) => events.requests.push(e),
    onStatus: (s) => events.statuses.push(s),
  })
  const status = await server.start(lib.normalizeConfig(config), '/tmp/project')
  try {
    await fn({ server, status, events, url: status.url })
  } finally {
    await server.stop()
  }
}

test('serves a matched route with status, headers, body and logs it', async () => {
  const port = 41000 + Math.floor(Math.random() * 2000)
  await withServer({
    port,
    routes: [{ method: 'GET', path: '/users/:id', status: 201, headers: { 'Content-Type': 'application/json', 'X-Test': 'yes' }, body: '{"id":1}' }],
  }, async ({ url, events, status }) => {
    assert.equal(status.running, true)
    assert.equal(url, `http://127.0.0.1:${port}`)
    const res = await fetch(`${url}/users/9?x=1`, { headers: { 'X-Client': 'c' } })
    assert.equal(res.status, 201)
    assert.equal(res.headers.get('x-test'), 'yes')
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.equal(res.headers.get('x-voiden-mock'), 'matched')
    assert.equal(await res.text(), '{"id":1}')
    const [entry] = events.requests
    assert.equal(entry.method, 'GET')
    assert.equal(entry.path, '/users/9')
    assert.equal(entry.query, 'x=1')
    assert.deepEqual(entry.params, { id: '9' })
    assert.equal(entry.requestHeaders['x-client'], 'c')
    assert.equal(entry.status, 201)
  })
})

test('unmatched → 404 JSON; preflight → 204; request body is logged', async () => {
  const port = 43000 + Math.floor(Math.random() * 2000)
  await withServer({ port, routes: [] }, async ({ url, events }) => {
    const res = await fetch(`${url}/nope`, { method: 'POST', body: 'hello' })
    assert.equal(res.status, 404)
    assert.equal((await res.json()).path, '/nope')
    const pre = await fetch(`${url}/nope`, { method: 'OPTIONS' })
    assert.equal(pre.status, 204)
    assert.equal(events.requests[0].requestBody, 'hello')
    assert.equal(events.requests[0].routeId, null)
    assert.equal(events.requests[1].routeLabel, 'CORS preflight')
  })
})

test('cors:false sends no CORS headers', async () => {
  const port = 45000 + Math.floor(Math.random() * 2000)
  await withServer({ port, cors: false, routes: [{ path: '/a', body: 'x' }] }, async ({ url }) => {
    const res = await fetch(`${url}/a`)
    assert.equal(res.headers.get('access-control-allow-origin'), null)
    await res.text()
  })
})

test('delay is applied; updateConfig swaps routes live', async () => {
  const port = 47000 + Math.floor(Math.random() * 2000)
  await withServer({ port, routes: [{ path: '/slow', delayMs: 250, body: 'late' }] }, async ({ server, url }) => {
    const t0 = Date.now()
    const res = await fetch(`${url}/slow`)
    assert.equal(await res.text(), 'late')
    assert.ok(Date.now() - t0 >= 240, 'response should be delayed')

    server.updateConfig(lib.normalizeConfig({ routes: [{ path: '/slow', body: 'fast now', status: 202 }] }))
    const res2 = await fetch(`${url}/slow`)
    assert.equal(res2.status, 202)
    assert.equal(await res2.text(), 'fast now')
  })
})

test('204 route sends no body; HEAD gets headers only', async () => {
  const port = 49000 + Math.floor(Math.random() * 2000)
  await withServer({ port, routes: [{ method: 'DELETE', path: '/x', status: 204, body: 'ignored' }, { path: '/y', body: 'body' }] }, async ({ url }) => {
    const del = await fetch(`${url}/x`, { method: 'DELETE' })
    assert.equal(del.status, 204)
    assert.equal(await del.text(), '')
    const head = await fetch(`${url}/y`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
  })
})

test('port in use → readable error and a free port to use instead', async () => {
  const port = 51000 + Math.floor(Math.random() * 2000)
  await withServer({ port, routes: [] }, async () => {
    const second = new lib.MockServer()
    const status = await second.start(lib.normalizeConfig({ port }), null)
    assert.equal(status.running, false)
    assert.match(status.error, /already used by another program/)
    assert.ok(status.suggestedPort > port, 'suggests a higher port')
    // The suggestion actually works.
    const retry = await second.start(lib.normalizeConfig({ port: status.suggestedPort }), null)
    assert.equal(retry.running, true)
    assert.equal(retry.suggestedPort, null)
    await second.stop()
  })
})

test('stop() frees the port even with keep-alive connections', async () => {
  const port = 53000 + Math.floor(Math.random() * 2000)
  const server = new lib.MockServer()
  await server.start(lib.normalizeConfig({ port, routes: [{ path: '/a', body: 'a' }] }), null)
  await (await fetch(`http://127.0.0.1:${port}/a`)).text()
  const stopped = await server.stop()
  assert.equal(stopped.running, false)
  const again = await server.start(lib.normalizeConfig({ port }), null)
  assert.equal(again.running, true)
  await server.stop()
})

test('log is capped at MAX_LOG_ENTRIES', async () => {
  const port = 55000 + Math.floor(Math.random() * 2000)
  await withServer({ port, routes: [{ path: '/*' }] }, async ({ server, url }) => {
    const n = lib.MAX_LOG_ENTRIES + 5
    for (let i = 0; i < n; i++) await (await fetch(`${url}/${i}`)).text()
    const log = server.getLog()
    assert.equal(log.length, lib.MAX_LOG_ENTRIES)
    assert.equal(log[log.length - 1].path, `/${n - 1}`)
  })
})

test('LAN mode lists network URLs that actually reach the server', async () => {
  const port = 57000 + Math.floor(Math.random() * 1000)
  await withServer({ port, host: '0.0.0.0', routes: [{ path: '/lan', body: 'hi from lan' }] }, async ({ status }) => {
    assert.equal(status.url, `http://localhost:${port}`)
    const ips = lib.lanAddresses()
    assert.equal(status.networkUrls.length, ips.length)
    if (ips.length === 0) return // no network on this machine (e.g. CI sandbox)
    const res = await fetch(`${status.networkUrls[0]}/lan`)
    assert.equal(await res.text(), 'hi from lan')
  })
})

test('local-only mode has no network URLs', async () => {
  const port = 58000 + Math.floor(Math.random() * 1000)
  await withServer({ port, routes: [] }, async ({ status }) => {
    assert.deepEqual(status.networkUrls, [])
  })
})
