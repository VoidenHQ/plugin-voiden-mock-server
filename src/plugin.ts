/**
 * Voiden Mock Server Plugin
 *
 * Runs a local HTTP mock server from inside Voiden. Routes (method + path →
 * status, headers, body, optional delay) live in `voiden-mocks.json` at the
 * project root; the server itself runs in the main process (main-process.ts).
 */

import type { CorePluginContext } from '@voiden/sdk/ui'
import { attachListeners, invoke, mockStore, refresh } from './lib/store'

type PluginContext = CorePluginContext

export default function createMockServerPlugin(context: PluginContext) {
  const ctx = context as any
  let detach: (() => void) | null = null
  let offProject: (() => void) | null = null

  const toast = (message: string, type?: 'info' | 'success' | 'warning' | 'error') =>
    ctx.ui?.showToast?.(message, type)

  return {
    onload: async () => {
      detach = attachListeners()

      const { createMockServerSidebar } = await import('./components/MockServerSidebar')
      const MockServerSidebar = createMockServerSidebar({
        openFile: (relativePath: string) => ctx.project.openFile(relativePath),
        showToast: toast,
      })

      context.registerSidebarTab('left', {
        id: 'mock-server',
        title: 'Mock Server',
        icon: 'Server',
        component: MockServerSidebar,
      } as any)

      // Routes are per project — reload when the user switches.
      try {
        offProject = ctx.events?.on?.('project:changed', () => { void refresh() }) ?? null
      } catch {
        offProject = null
      }

      const run = async (name: 'start' | 'stop') => {
        const res = await invoke(name).catch((e: any) => ({ success: false, error: e?.message || String(e) }))
        if (!res?.success) {
          const free = res?.status?.suggestedPort
          toast(free ? `${res.error} Port ${free} is free — use it from the Mock Server panel.` : res?.error || `Mock server did not ${name}`, 'error')
          return
        }
        if (name === 'start') toast(`Mock server running at ${res.status?.url}`, 'success')
        else toast('Mock server stopped', 'info')
      }

      ctx.registerCommand?.({
        id: 'start',
        label: 'Mock Server: Start',
        description: 'Serve the routes in voiden-mocks.json',
        when: () => !mockStore.get().status?.running,
        action: () => { void run('start') },
      })
      ctx.registerCommand?.({
        id: 'stop',
        label: 'Mock Server: Stop',
        when: () => !!mockStore.get().status?.running,
        action: () => { void run('stop') },
      })
      ctx.registerCommand?.({
        id: 'copy-url',
        label: 'Mock Server: Copy URL',
        when: () => !!mockStore.get().status?.running,
        action: async () => {
          const url = mockStore.get().status?.url
          if (!url) return
          try { await navigator.clipboard.writeText(url); toast('Mock server URL copied', 'success') } catch { /* ignore */ }
        },
      })

      void refresh()
    },

    onunload: async () => {
      detach?.()
      detach = null
      offProject?.()
      offProject = null
    },
  }
}
