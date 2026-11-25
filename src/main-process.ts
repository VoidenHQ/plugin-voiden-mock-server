/**
 * Mock Server — main-process part.
 *
 * Runs the HTTP server (it needs Node sockets, which the renderer doesn't
 * have) and owns reading/writing `voiden-mocks.json` in the active project.
 *
 * Renderer → main (invoke):  ext:voiden-mock-server:<channel>
 *   getState, saveConfig, start, stop, clearLog
 * Main → renderer (events):  ext:voiden-mock-server:<event>
 *   status, request, config
 *
 * One server at a time. It keeps serving the project it was started from
 * until stopped, even if another project becomes active — the status says
 * which project that is.
 */

import type { ElectronExtensionContext } from '@voiden/sdk/electron'
import { existsSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_FILE_NAME, parseConfigText, serializeConfig, type MockConfig } from './lib/config'
import { MockServer } from './lib/server'

function configPathFor(projectPath: string): string {
  return join(projectPath, CONFIG_FILE_NAME)
}

function readConfig(projectPath: string) {
  const path = configPathFor(projectPath)
  const exists = existsSync(path)
  const text = exists ? readFileSync(path, 'utf8') : null
  return { path, exists, ...parseConfigText(text) }
}

export default function createMockServerMainPlugin(context: ElectronExtensionContext) {
  const server = new MockServer({
    onRequest: (entry) => context.ipc.send('request', entry),
    onStatus: (status) => context.ipc.send('status', status),
  })

  let watcher: FSWatcher | null = null
  let watchTimer: ReturnType<typeof setTimeout> | null = null
  /** Text we last wrote ourselves — so the watcher ignores our own saves. */
  let lastWrittenText: string | null = null

  const stopWatching = () => {
    if (watchTimer) clearTimeout(watchTimer)
    watchTimer = null
    try { watcher?.close() } catch { /* already closed */ }
    watcher = null
  }

  /** While running, pick up hand edits to the config file (from the code editor, git checkout…). */
  const watchConfig = (projectPath: string) => {
    stopWatching()
    try {
      // Watch the directory: editors often save by replacing the file, which drops a file watch.
      watcher = watch(projectPath, (_event, filename) => {
        if (filename && filename.toString() !== CONFIG_FILE_NAME) return
        if (watchTimer) clearTimeout(watchTimer)
        watchTimer = setTimeout(() => {
          const path = configPathFor(projectPath)
          const text = existsSync(path) ? readFileSync(path, 'utf8') : null
          if (text !== null && text === lastWrittenText) return
          const parsed = parseConfigText(text)
          if (parsed.error) {
            context.ipc.send('config', { projectPath, path, exists: text !== null, config: null, error: parsed.error })
            return
          }
          server.updateConfig(parsed.config)
          context.ipc.send('config', { projectPath, path, exists: text !== null, config: parsed.config, error: null })
        }, 150)
      })
    } catch {
      // Watching is a convenience — the panel's own saves still apply live.
      watcher = null
    }
  }

  const activeProject = async (event: unknown): Promise<string | null> => {
    try {
      return (await context.project.getActive(event as any)) || null
    } catch {
      return null
    }
  }

  return {
    onload() {
      context.ipc.handle('getState', async (event: unknown) => {
        const projectPath = await activeProject(event)
        const file = projectPath ? readConfig(projectPath) : null
        return {
          projectPath,
          configPath: file?.path ?? null,
          configExists: file?.exists ?? false,
          config: file?.config ?? null,
          configError: file?.error ?? null,
          status: server.getStatus(),
          log: server.getLog(),
        }
      })

      context.ipc.handle('saveConfig', async (event: unknown, config: MockConfig) => {
        const projectPath = await activeProject(event)
        if (!projectPath) return { success: false, error: 'Open a project first.' }
        const text = serializeConfig(config)
        try {
          lastWrittenText = text
          writeFileSync(configPathFor(projectPath), text, 'utf8')
        } catch (err: any) {
          return { success: false, error: `Could not write ${CONFIG_FILE_NAME}: ${err?.message || err}` }
        }
        const saved = parseConfigText(text).config
        // Apply route edits live when the server is serving this project.
        if (server.running && server.getStatus().projectPath === projectPath) server.updateConfig(saved)
        return { success: true, config: saved }
      })

      context.ipc.handle('start', async (event: unknown) => {
        const projectPath = await activeProject(event)
        if (!projectPath) return { success: false, error: 'Open a project first.', status: server.getStatus() }
        const file = readConfig(projectPath)
        if (file.error) return { success: false, error: file.error, status: server.getStatus() }
        const status = await server.start(file.config, projectPath)
        if (status.running) watchConfig(projectPath)
        return { success: status.running, error: status.error, status }
      })

      context.ipc.handle('stop', async () => {
        stopWatching()
        const status = await server.stop()
        return { success: true, status }
      })

      context.ipc.handle('clearLog', async () => {
        server.clearLog()
        return { success: true }
      })
    },

    async onunload() {
      stopWatching()
      for (const ch of ['getState', 'saveConfig', 'start', 'stop', 'clearLog']) context.ipc.removeHandler(ch)
      // Never leave a port bound after the plugin is disabled, updated or the app quits.
      await server.stop()
    },
  }
}
