/**
 * Renderer-side state for the Mock Server panel. Module-level (not React
 * state) so status and the request log survive the sidebar tab being
 * switched away from and back, and so IPC listeners are registered once.
 */

import type { MockConfig } from './config'
import type { MockLogEntry, MockServerStatus } from './server'

export const PLUGIN_ID = 'voiden-mock-server'
const channel = (name: string) => `ext:${PLUGIN_ID}:${name}`

export interface PanelState {
  loaded: boolean
  projectPath: string | null
  configPath: string | null
  configExists: boolean
  config: MockConfig | null
  configError: string | null
  status: MockServerStatus | null
  log: MockLogEntry[]
  /** Bumped when the file changed on disk, so an open editor can reload. */
  externalConfigVersion: number
}

let state: PanelState = {
  loaded: false,
  projectPath: null,
  configPath: null,
  configExists: false,
  config: null,
  configError: null,
  status: null,
  log: [],
  externalConfigVersion: 0,
}

const listeners = new Set<() => void>()

function set(patch: Partial<PanelState>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export const mockStore = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}

function ipc(): any {
  return (window as any).electron?.ipc
}

export async function invoke<T = any>(name: string, ...args: any[]): Promise<T> {
  const bridge = ipc()
  if (!bridge) throw new Error('Mock server needs the Voiden desktop app')
  return bridge.invoke(channel(name), ...args)
}

export async function refresh(): Promise<void> {
  try {
    const s = await invoke('getState')
    set({
      loaded: true,
      projectPath: s.projectPath,
      configPath: s.configPath,
      configExists: s.configExists,
      config: s.config,
      configError: s.configError,
      status: s.status,
      log: s.log ?? [],
    })
  } catch (err: any) {
    set({ loaded: true, configError: err?.message || String(err) })
  }
}

const MAX_LOG = 200

const onStatus = (_e: unknown, status: MockServerStatus) => set({ status })
const onRequest = (_e: unknown, entry: MockLogEntry) => {
  const log = [...state.log, entry]
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG)
  set({ log })
}
const onConfig = (_e: unknown, payload: { projectPath: string; config: MockConfig | null; error: string | null; exists: boolean }) => {
  if (payload.projectPath !== state.projectPath) return
  if (payload.error) { set({ configError: payload.error }); return }
  set({
    config: payload.config,
    configExists: payload.exists,
    configError: null,
    externalConfigVersion: state.externalConfigVersion + 1,
  })
}

export function attachListeners(): () => void {
  const bridge = ipc()
  if (!bridge?.on) return () => {}
  bridge.on(channel('status'), onStatus)
  bridge.on(channel('request'), onRequest)
  bridge.on(channel('config'), onConfig)
  return () => {
    bridge.removeListener?.(channel('status'), onStatus)
    bridge.removeListener?.(channel('request'), onRequest)
    bridge.removeListener?.(channel('config'), onConfig)
  }
}

export function setConfigLocal(config: MockConfig) {
  set({ config, configExists: true, configError: null })
}

export function clearLogLocal() {
  set({ log: [] })
}
