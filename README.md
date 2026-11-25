# Voiden Mock Server

Run a local mock HTTP server from inside Voiden. Define routes (method + path → status, headers, body, optional delay), point your frontend, client or tests at the server, and watch the requests that hit it.

Tracks [VoidenHQ/voiden#633](https://github.com/VoidenHQ/voiden/issues/633).

## Using it

1. Open the **Mock Server** tab in the left sidebar.
2. Click **Add route**, then set the method, path, status, headers and body.
3. Click **Start**. The server listens on `http://127.0.0.1:4010` by default. Click the URL to copy it.
4. Send requests to it from your app, a test, or a Voiden request. They show up under **Requests**.

The command palette also has **Mock Server: Start**, **Stop** and **Copy URL**.

## Routes

| Field   | Notes |
|---------|-------|
| Method  | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, or `ANY`. `HEAD` requests fall back to `GET` routes. |
| Path    | Exact (`/users`), a named segment (`/users/:id`), or a trailing wildcard (`/files/*`). The query string is ignored, and so is a trailing slash. |
| Status  | 200–599. `204`, `304` and `HEAD` responses are sent without a body. |
| Headers | Sent exactly as written. |
| Body    | Sent exactly as written (static). |
| Delay   | Milliseconds to wait before responding (max 120000), for testing slow backends and timeouts. |

Routes are checked top to bottom and **the first enabled match wins**. Put specific routes above catch-alls and reorder them with ↑/↓. A request that matches nothing gets a `404` with a JSON hint. Its log entry has a button that adds a route for it.

Every mock response carries `X-Voiden-Mock: matched` (or `unmatched`), so you can tell it apart from a real backend.

## Settings

- **Port**: default `4010`. A port change applies when you restart the server.
- **CORS** (on by default): adds `Access-Control-Allow-*: *` headers and answers browser preflight `OPTIONS` requests automatically. A route that explicitly matches `OPTIONS` overrides this.
- **LAN**: listens on `0.0.0.0` instead of `127.0.0.1`, so a phone or VM on your network can reach the mock.

## Config file

Routes and settings are saved in `voiden-mocks.json` at the project root. Nothing goes under `.voiden/`, because that folder is gitignored, and this file is meant to be committed and shared with your team.

```json
{
  "port": 4010,
  "host": "127.0.0.1",
  "cors": true,
  "routes": [
    {
      "id": "r_get_user",
      "name": "Get user",
      "enabled": true,
      "method": "GET",
      "path": "/users/:id",
      "status": 200,
      "headers": { "Content-Type": "application/json" },
      "body": "{ \"id\": 1, \"name\": \"Ada\" }",
      "delayMs": 0
    }
  ]
}
```

You can edit the file by hand. While the server runs, saved changes to it (from the editor, a `git checkout`, and so on) are applied right away. For hand-written configs, `body` may also be a JSON object, and `headers` may be a list of `{ "key", "value" }` pairs. Missing fields get defaults.

## How it works

- `src/main-process.ts`: runs in Electron's main process (the renderer has no Node sockets). It runs the server and reads and writes `voiden-mocks.json`, and the sidebar talks to it over `ext:voiden-mock-server:*` IPC.
- `src/lib/server.ts`: the HTTP server, plain Node with no Electron, so it's tested on a real socket.
- `src/lib/router.ts`: route matching.
- `src/lib/config.ts`: the config schema and normalization, shared by both sides.
- `src/components/MockServerSidebar.tsx`: the sidebar panel.

Only one mock server runs at a time. It keeps serving the project it was started from until you stop it, and the panel tells you if that's a different project from the one open. Stopping the server, disabling the plugin or quitting Voiden always frees the port.

## Development

```bash
npm install
npm test          # config, router and real-socket server tests
npm run build     # dist/voiden-mock-server.js + dist/voiden-mock-server-main.cjs
```

From the app repo, `node scripts/build-plugins.mjs voiden-mock-server --dev` builds the plugin and copies it into `apps/electron/bundled-plugins/` and `bundled-main-plugins/`.

## Not in v1

- Serving from saved responses or an OpenAPI spec (see #536)
- Templated or dynamic responses
