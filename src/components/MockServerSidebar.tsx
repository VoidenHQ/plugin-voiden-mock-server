/**
 * Left-sidebar panel: start/stop the mock server, edit its routes, and watch
 * requests come in.
 *
 * Three stacked sections — Server, Routes, Requests — each with its own
 * header bar, like the app's other sidebars. Routes and Requests share the
 * remaining height so requests stay visible while editing routes.
 *
 * Colors use the theme's CSS variables inline: the host's Tailwind build only
 * scans the app's own sources, so plugin-only utility classes wouldn't exist.
 */

import React from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  CopyPlus,
  FileJson,
  Inbox,
  Play,
  Plus,
  Server,
  Settings2,
  Square,
  Timer,
  Trash2,
} from 'lucide-react'
import {
  CONFIG_FILE_NAME,
  HTTP_METHODS,
  MAX_DELAY_MS,
  defaultConfig,
  defaultRoute,
  newRouteId,
  normalizePath,
  type MockConfig,
  type MockMethod,
  type MockRoute,
} from '../lib/config'
import type { MockLogEntry } from '../lib/server'
import { clearLogLocal, invoke, mockStore, refresh, setConfigLocal } from '../lib/store'

export interface SidebarApi {
  openFile: (relativePath: string) => Promise<void>
  showToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void
}

const AUTOSAVE_MS = 500
const STATUS_PRESETS = [200, 201, 204, 400, 401, 404, 500]
const DELAY_PRESETS = [0, 500, 2000, 5000]

function useMockState() {
  return React.useSyncExternalStore(mockStore.subscribe, mockStore.get)
}

// The few effects inline styles can't do (hover reveal). Class names are
// prefixed so they can't collide with the host's.
const SCOPED_CSS = `
.vms-row .vms-reveal { opacity: 0; transition: opacity 100ms; }
.vms-row:hover .vms-reveal, .vms-reveal:focus-visible { opacity: 1; }
.vms-num::-webkit-inner-spin-button, .vms-num::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
`

// UI state that should survive switching sidebar tabs away and back.
const uiMemory = { routesOpen: true, logOpen: true, settingsOpen: false }

// ─── Theme ─────────────────────────────────────────────────────────────────

const FG = 'var(--editor-fg)'
const BG = 'var(--ui-bg)'
const C = {
  muted: 'var(--syntax-comment)',
  line: 'var(--ui-line)',
  primary: 'var(--button-primary-bg)',
  primaryHover: 'var(--button-primary-hover)',
  success: 'var(--status-success)',
  error: 'var(--status-error)',
  warning: 'var(--status-warning)',
  info: 'var(--status-info)',
  /** Section header bars — a step lighter (dark themes) / darker (light themes) than the panel. */
  header: `color-mix(in srgb, ${FG} 6%, ${BG})`,
  /** Recessed area for an open editor / detail view. */
  well: 'var(--ui-surface)',
  input: 'var(--editor-bg)',
}

/** A translucent fill of any theme color — works in light and dark themes. */
const tint = (color: string, pct = 14) => `color-mix(in srgb, ${color} ${pct}%, transparent)`

const METHOD_VAR: Record<string, string> = {
  GET: 'var(--http-get)', POST: 'var(--http-post)', PUT: 'var(--http-put)', PATCH: 'var(--http-patch)',
  DELETE: 'var(--http-delete)', HEAD: 'var(--http-head)', OPTIONS: 'var(--http-options)',
}

function statusColor(status: number): string {
  if (status >= 500) return C.error
  if (status >= 400) return C.warning
  if (status >= 300) return C.info
  return C.success
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDelay(ms: number) {
  return ms >= 1000 ? `${+(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

const inputCls = 'w-full border border-border rounded px-2 py-1 text-xs text-text outline-none'
const inputStyle: React.CSSProperties = { background: C.input }
const iconBtn = 'p-1 rounded text-comment hover:text-text hover:bg-hover disabled:opacity-40 flex items-center'

// ─── Building blocks ───────────────────────────────────────────────────────

function MethodPill({ method, width = 48 }: { method: string; width?: number }) {
  const color = METHOD_VAR[method] ?? C.muted
  return (
    <span className="font-mono font-semibold shrink-0 text-center rounded"
      style={{ color, background: tint(color, 16), fontSize: 10, lineHeight: '18px', width, display: 'inline-block' }}>
      {method === 'OPTIONS' ? 'OPTS' : method === 'DELETE' ? 'DEL' : method}
    </span>
  )
}

function StatusPill({ status }: { status: number }) {
  const color = statusColor(status)
  return (
    <span className="font-mono font-semibold shrink-0 rounded text-center"
      style={{ color, background: tint(color, 16), fontSize: 10, lineHeight: '18px', minWidth: 30, padding: '0 4px' }}>
      {status}
    </span>
  )
}

function Switch({ checked, onChange, title }: { checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} title={title}
      onClick={(e) => { e.stopPropagation(); onChange(!checked) }}
      className="shrink-0 rounded-full relative"
      style={{ width: 24, height: 14, background: checked ? C.primary : tint(FG, 20), transition: 'background 120ms' }}>
      <span className="absolute rounded-full"
        style={{ top: 2, left: checked ? 12 : 2, width: 10, height: 10, background: '#fff', transition: 'left 120ms' }} />
    </button>
  )
}

function Label({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
      <span className="uppercase font-semibold" style={{ fontSize: 10, letterSpacing: '0.05em', color: C.muted }}>{children}</span>
      {right}
    </div>
  )
}

function Chip({ active, onClick, children, color }: { active?: boolean; onClick: () => void; children: React.ReactNode; color?: string }) {
  const c = color ?? C.primary
  return (
    <button type="button" onClick={onClick} className="font-mono rounded"
      style={{
        fontSize: 10, lineHeight: '18px', padding: '0 6px',
        border: `1px solid ${active ? c : C.line}`,
        color: active ? c : C.muted,
        background: active ? tint(c, 14) : 'transparent',
      }}>
      {children}
    </button>
  )
}

/** Full-width section header bar, collapsible, with a count and actions on the right. */
function SectionHeader(props: {
  title: string
  count?: number
  open?: boolean
  onToggle?: () => void
  badge?: React.ReactNode
  actions?: React.ReactNode
}) {
  const Chevron = props.open ? ChevronDown : ChevronRight
  return (
    <div className="flex items-center gap-1.5 shrink-0 select-none"
      style={{ height: 28, padding: '0 6px 0 8px', background: C.header, borderTop: `1px solid ${C.line}`, borderBottom: `1px solid ${C.line}`, cursor: props.onToggle ? 'pointer' : 'default' }}
      onClick={props.onToggle}>
      {props.onToggle && <Chevron size={13} style={{ color: C.muted }} className="shrink-0" />}
      <span className="uppercase font-semibold" style={{ fontSize: 11, letterSpacing: '0.06em' }}>{props.title}</span>
      {props.count !== undefined && (
        <span className="font-mono rounded" style={{ fontSize: 10, padding: '0 5px', lineHeight: '16px', color: C.muted, background: tint(FG, 9) }}>{props.count}</span>
      )}
      {props.badge}
      <span className="flex-1" />
      <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>{props.actions}</div>
    </div>
  )
}

function useCopy(api: SidebarApi) {
  const [copied, setCopied] = React.useState<string | null>(null)
  const copy = async (text: string, key: string, toast?: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      setTimeout(() => setCopied((k) => (k === key ? null : k)), 1200)
      if (toast) api.showToast(toast, 'success')
    } catch { /* clipboard unavailable */ }
  }
  return { copied, copy }
}

function EmptyState({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center gap-1.5" style={{ padding: '20px 16px', color: C.muted, fontSize: 11 }}>
      <div style={{ opacity: 0.7 }}>{icon}</div>
      <div className="font-semibold text-text" style={{ fontSize: 12 }}>{title}</div>
      {children}
    </div>
  )
}

// ─── Route editor ──────────────────────────────────────────────────────────

function HeadersEditor({ headers, onChange }: { headers: Record<string, string>; onChange: (h: Record<string, string>) => void }) {
  // Edit as rows so a half-typed key (or a duplicate while renaming) doesn't eat the value.
  const [rows, setRows] = React.useState(() => Object.entries(headers).map(([k, v]) => ({ k, v })))
  const commit = (next: { k: string; v: string }[]) => {
    setRows(next)
    const out: Record<string, string> = {}
    for (const r of next) if (r.k.trim()) out[r.k.trim()] = r.v
    onChange(out)
  }
  return (
    <div className="flex flex-col gap-1">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-1 items-center">
          <input className={inputCls + ' font-mono'} placeholder="Header" value={r.k} style={{ ...inputStyle, flex: '0 0 42%', minWidth: 0 }}
            onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
          <input className={inputCls + ' font-mono'} placeholder="Value" value={r.v} style={{ ...inputStyle, minWidth: 0 }}
            onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
          <button className={iconBtn} title="Remove header" onClick={() => commit(rows.filter((_, j) => j !== i))}>
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <button className="flex items-center gap-1 text-comment hover:text-text" style={{ fontSize: 11, alignSelf: 'flex-start' }}
        onClick={() => setRows([...rows, { k: '', v: '' }])}>
        <Plus size={11} /> Add header
      </button>
    </div>
  )
}

function RouteEditor(props: {
  route: MockRoute
  index: number
  count: number
  onChange: (r: MockRoute) => void
  onDelete: () => void
  onMove: (dir: -1 | 1) => void
  onDuplicate: () => void
}) {
  const { route, onChange } = props
  const patch = (p: Partial<MockRoute>) => onChange({ ...route, ...p })
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const isJson = Object.entries(route.headers).some(([k, v]) => k.toLowerCase() === 'content-type' && v.includes('json'))
  let jsonError: string | null = null
  if (isJson && route.body.trim()) {
    try { JSON.parse(route.body) } catch (e: any) { jsonError = e?.message || 'Invalid JSON' }
  }
  const noBody = route.status === 204 || route.status === 304
  const accent = METHOD_VAR[route.method] ?? C.muted

  return (
    <div className="flex flex-col gap-3" style={{ padding: '10px 10px 10px 12px', background: C.well, borderLeft: `2px solid ${accent}`, borderBottom: `1px solid ${C.line}` }}>
      <div>
        <Label>Name</Label>
        <input className={inputCls} style={inputStyle} value={route.name ?? ''} placeholder="Optional, e.g. Get user" onChange={(e) => patch({ name: e.target.value })} />
      </div>

      <div>
        <Label>Request</Label>
        <div className="flex gap-1">
          <select className={inputCls + ' font-mono font-semibold'} style={{ ...inputStyle, width: 84, flex: '0 0 84px', color: accent }} value={route.method}
            onChange={(e) => patch({ method: e.target.value as MockMethod })}>
            {HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <input className={inputCls + ' font-mono'} style={{ ...inputStyle, minWidth: 0 }} value={route.path} placeholder="/users/:id"
            onChange={(e) => patch({ path: e.target.value })}
            onBlur={(e) => patch({ path: normalizePath(e.target.value) })} />
        </div>
        <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>
          <code>:name</code> matches one segment, a final <code>*</code> matches the rest.
        </div>
      </div>

      <div>
        <Label>Status</Label>
        <div className="flex gap-1 items-center flex-wrap">
          {STATUS_PRESETS.map((s) => (
            <Chip key={s} active={route.status === s} color={statusColor(s)} onClick={() => patch({ status: s })}>{s}</Chip>
          ))}
          <input className={inputCls + ' font-mono vms-num'} title="Any status from 200 to 599"
            style={{ ...inputStyle, width: 52, padding: '0 6px', lineHeight: '18px', fontSize: 10, color: statusColor(route.status),
              borderColor: STATUS_PRESETS.includes(route.status) ? undefined : statusColor(route.status) }}
            type="number" min={200} max={599} placeholder="other"
            value={STATUS_PRESETS.includes(route.status) ? '' : route.status}
            onChange={(e) => { const n = Number(e.target.value); if (n >= 200 && n <= 599) patch({ status: n }) }} />
        </div>
      </div>

      <div>
        <Label>Delay</Label>
        <div className="flex gap-1 items-center flex-wrap">
          {DELAY_PRESETS.map((d) => (
            <Chip key={d} active={route.delayMs === d} onClick={() => patch({ delayMs: d })}>{d === 0 ? 'none' : formatDelay(d)}</Chip>
          ))}
          <input className={inputCls + ' font-mono vms-num'} title="Delay in milliseconds"
            style={{ ...inputStyle, width: 64, padding: '0 6px', lineHeight: '18px', fontSize: 10,
              borderColor: DELAY_PRESETS.includes(route.delayMs) ? undefined : C.primary }}
            type="number" min={0} max={MAX_DELAY_MS} step={100} placeholder="ms"
            value={DELAY_PRESETS.includes(route.delayMs) ? '' : route.delayMs}
            onChange={(e) => patch({ delayMs: Math.min(MAX_DELAY_MS, Math.max(0, Number(e.target.value) || 0)) })} />
        </div>
      </div>

      <div>
        <Label>Response headers</Label>
        <HeadersEditor headers={route.headers} onChange={(headers) => patch({ headers })} />
      </div>

      <div>
        <Label right={isJson && !noBody ? (
          <button className="text-comment hover:text-text disabled:opacity-40" style={{ fontSize: 10 }} disabled={!!jsonError || !route.body.trim()}
            onClick={() => { try { patch({ body: JSON.stringify(JSON.parse(route.body), null, 2) }) } catch { /* guarded */ } }}>
            Format JSON
          </button>
        ) : undefined}>Response body</Label>
        {noBody ? (
          <div style={{ fontSize: 11, color: C.muted }}>A {route.status} response is sent without a body.</div>
        ) : (
          <>
            <textarea className={inputCls + ' font-mono'} rows={7} spellCheck={false} value={route.body}
              style={{ ...inputStyle, resize: 'vertical', whiteSpace: 'pre', tabSize: 2, fontSize: 11, lineHeight: 1.5 }}
              onChange={(e) => patch({ body: e.target.value })} />
            {jsonError && <div style={{ fontSize: 10, color: C.warning, marginTop: 2 }}>Not valid JSON: {jsonError}</div>}
          </>
        )}
      </div>

      <div className="flex items-center gap-0.5" style={{ borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
        <button className={iconBtn} disabled={props.index === 0} onClick={() => props.onMove(-1)} title="Move up (routes higher in the list match first)"><ArrowUp size={13} /></button>
        <button className={iconBtn} disabled={props.index === props.count - 1} onClick={() => props.onMove(1)} title="Move down"><ArrowDown size={13} /></button>
        <button className={iconBtn} onClick={props.onDuplicate} title="Duplicate route"><CopyPlus size={13} /></button>
        <span className="flex-1" />
        {confirmDelete ? (
          <div className="flex items-center gap-1">
            <button className="rounded" style={{ fontSize: 11, padding: '2px 8px', color: '#fff', background: 'var(--button-danger-bg)' }} onClick={props.onDelete}>Delete</button>
            <button className="rounded text-comment hover:text-text" style={{ fontSize: 11, padding: '2px 6px' }} onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        ) : (
          <button className="flex items-center gap-1 rounded hover:bg-hover" style={{ fontSize: 11, padding: '2px 6px', color: C.error }} onClick={() => setConfirmDelete(true)}>
            <Trash2 size={12} /> Delete
          </button>
        )}
      </div>
    </div>
  )
}

function RouteRow(props: {
  route: MockRoute
  index: number
  count: number
  expanded: boolean
  hits: number
  baseUrl: string | null
  copied: boolean
  onCopy: () => void
  onToggle: () => void
  onChange: (r: MockRoute) => void
  onDelete: () => void
  onMove: (dir: -1 | 1) => void
  onDuplicate: () => void
}) {
  const { route, expanded } = props
  const meta: React.ReactNode[] = []
  if (route.name?.trim()) meta.push(<span key="n" className="truncate">{route.name}</span>)
  if (route.delayMs > 0) meta.push(<span key="d" className="flex items-center gap-0.5 shrink-0"><Timer size={10} />{formatDelay(route.delayMs)}</span>)
  if (props.hits > 0) meta.push(<span key="h" className="shrink-0">{props.hits} hit{props.hits === 1 ? '' : 's'}</span>)

  return (
    <div style={{ borderBottom: expanded ? undefined : `1px solid ${C.line}` }}>
      <div className="flex items-center gap-2 cursor-pointer hover:bg-hover vms-row"
        style={{
          padding: '6px 8px', minHeight: 40,
          background: expanded ? tint(FG, 6) : undefined,
          boxShadow: expanded ? `inset 2px 0 0 ${METHOD_VAR[route.method] ?? C.muted}` : undefined,
        }}
        onClick={props.onToggle}>
        <MethodPill method={route.method} />
        <div className="flex flex-col min-w-0 flex-1" style={{ opacity: route.enabled ? 1 : 0.45, gap: 1 }}>
          <span className="font-mono truncate" style={{ fontSize: 12 }} title={route.path}>{route.path}</span>
          {meta.length > 0 && (
            <span className="flex items-center gap-1.5 min-w-0" style={{ fontSize: 10, color: C.muted }}>
              {meta.flatMap((m, i) => (i ? [<span key={'s' + i} className="shrink-0">·</span>, m] : [m]))}
            </span>
          )}
        </div>
        {props.baseUrl && (
          <button className={iconBtn + ' vms-reveal'} title="Copy full URL" onClick={(e) => { e.stopPropagation(); props.onCopy() }}>
            {props.copied ? <Check size={12} style={{ color: C.success }} /> : <Copy size={12} />}
          </button>
        )}
        <StatusPill status={route.status} />
        <Switch checked={route.enabled} title={route.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'} onChange={(v) => props.onChange({ ...route, enabled: v })} />
      </div>
      {expanded && (
        <RouteEditor route={route} index={props.index} count={props.count} onChange={props.onChange}
          onDelete={props.onDelete} onMove={props.onMove} onDuplicate={props.onDuplicate} />
      )}
    </div>
  )
}

// ─── Request log ───────────────────────────────────────────────────────────

function KeyValues({ data }: { data: Record<string, string> }) {
  const entries = Object.entries(data)
  if (!entries.length) return <div style={{ color: C.muted }}>None</div>
  return (
    <div className="font-mono break-all flex flex-col" style={{ fontSize: 11, gap: 2 }}>
      {entries.map(([k, v]) => <div key={k}><span style={{ color: C.muted }}>{k}:</span> {v}</div>)}
    </div>
  )
}

function LogRow({ entry, onAddRoute }: { entry: MockLogEntry; onAddRoute: (e: MockLogEntry) => void }) {
  const [open, setOpen] = React.useState(false)
  const unmatched = entry.routeId === null && entry.status === 404
  return (
    <div style={{ borderBottom: `1px solid ${C.line}` }}>
      <div className="flex items-center gap-2 cursor-pointer hover:bg-hover"
        style={{ padding: '5px 8px', background: open ? tint(FG, 6) : undefined }} onClick={() => setOpen(!open)}>
        <StatusPill status={entry.status} />
        <div className="flex flex-col min-w-0 flex-1" style={{ gap: 1 }}>
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="font-mono font-semibold shrink-0" style={{ fontSize: 10, color: METHOD_VAR[entry.method] ?? C.muted }}>{entry.method}</span>
            <span className="font-mono truncate" style={{ fontSize: 12 }} title={entry.path + (entry.query ? '?' + entry.query : '')}>
              {entry.path}{entry.query && <span style={{ color: C.muted }}>?{entry.query}</span>}
            </span>
          </span>
          <span className="truncate" style={{ fontSize: 10, color: unmatched ? C.warning : C.muted }}>
            {unmatched ? 'No matching route' : `→ ${entry.routeLabel ?? ''}`}
          </span>
        </div>
        <div className="flex flex-col items-end shrink-0 font-mono" style={{ fontSize: 10, color: C.muted, gap: 1 }}>
          <span>{formatTime(entry.time)}</span>
          <span>{entry.durationMs} ms</span>
        </div>
      </div>
      {open && (
        <div className="flex flex-col gap-3" style={{ padding: '10px 10px 10px 12px', fontSize: 11, background: C.well, borderTop: `1px solid ${C.line}` }}>
          {unmatched && (
            <button className="flex items-center gap-1 rounded"
              style={{ alignSelf: 'flex-start', fontSize: 11, padding: '4px 8px', color: '#fff', background: C.primary }} onClick={() => onAddRoute(entry)}>
              <Plus size={11} /> Add route for {entry.method} {entry.path}
            </button>
          )}
          {Object.keys(entry.params).length > 0 && <div><Label>Path params</Label><KeyValues data={entry.params} /></div>}
          <div><Label>Request headers</Label><KeyValues data={entry.requestHeaders} /></div>
          {entry.requestBody && (
            <div>
              <Label>{`Request body${entry.requestBodyTruncated ? ' (first 64 KB)' : ''}`}</Label>
              <pre className="font-mono whitespace-pre-wrap break-all border border-border rounded m-0" style={{ fontSize: 11, padding: 8, background: C.input }}>{entry.requestBody}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Panel ─────────────────────────────────────────────────────────────────

type LogFilter = 'all' | 'matched' | 'unmatched'

export function createMockServerSidebar(api: SidebarApi) {
  return function MockServerSidebar() {
    const s = useMockState()
    const [expanded, setExpanded] = React.useState<string | null>(null)
    const [routesOpen, setRoutesOpenState] = React.useState(uiMemory.routesOpen)
    const [logOpen, setLogOpenState] = React.useState(uiMemory.logOpen)
    const [settingsOpen, setSettingsOpenState] = React.useState(uiMemory.settingsOpen)
    const setRoutesOpen = (v: boolean) => { uiMemory.routesOpen = v; setRoutesOpenState(v) }
    const setLogOpen = (v: boolean) => { uiMemory.logOpen = v; setLogOpenState(v) }
    const setSettingsOpen = (v: boolean) => { uiMemory.settingsOpen = v; setSettingsOpenState(v) }
    const [logFilter, setLogFilter] = React.useState<LogFilter>('all')
    const [draft, setDraft] = React.useState<MockConfig | null>(null)
    const [busy, setBusy] = React.useState(false)
    const [saveError, setSaveError] = React.useState<string | null>(null)
    const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
    const pendingSave = React.useRef<MockConfig | null>(null)
    // Bumped to remount editors when the file is replaced from disk.
    const [editorEpoch, setEditorEpoch] = React.useState(0)
    const { copied, copy } = useCopy(api)

    React.useEffect(() => { void refresh() }, [])

    // Take the stored config as the draft when it loads, the project changes, or the file changed on disk.
    React.useEffect(() => {
      if (pendingSave.current) return // don't clobber typing in progress
      setDraft(s.config ?? defaultConfig())
      setEditorEpoch((n) => n + 1)
    }, [s.projectPath, s.externalConfigVersion, s.loaded, s.config === null])

    const flush = React.useCallback(async () => {
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
      const cfg = pendingSave.current
      if (!cfg) return
      pendingSave.current = null
      const res = await invoke('saveConfig', cfg).catch((e: any) => ({ success: false, error: e?.message || String(e) }))
      if (res?.success) { setSaveError(null); setConfigLocal(res.config) }
      else setSaveError(res?.error || 'Could not save')
    }, [])

    // Save whatever is pending when the panel goes away.
    React.useEffect(() => () => { void flush() }, [flush])

    const update = (next: MockConfig) => {
      setDraft(next)
      pendingSave.current = next
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => { void flush() }, AUTOSAVE_MS)
    }

    const status = s.status
    const running = !!status?.running
    const servingOtherProject = !!(running && status?.projectPath && s.projectPath && status.projectPath !== s.projectPath)
    const needsRestart = !!(running && draft && status && !servingOtherProject &&
      (draft.port !== status.port || draft.host !== status.host))
    const baseUrl = running && !servingOtherProject ? status?.url ?? null : null

    const hits = React.useMemo(() => {
      const m: Record<string, number> = {}
      for (const e of s.log) if (e.routeId) m[e.routeId] = (m[e.routeId] ?? 0) + 1
      return m
    }, [s.log])
    const unmatchedCount = React.useMemo(() => s.log.filter((e) => e.routeId === null && e.status === 404).length, [s.log])

    const start = async () => {
      setBusy(true)
      try {
        await flush()
        const res = await invoke('start')
        // A busy port is explained in the panel, with a button to use a free one — no toast needed.
        if (!res?.success && !res?.status?.suggestedPort) api.showToast(res?.error || 'Mock server did not start', 'error')
      } finally { setBusy(false) }
    }
    const stop = async () => {
      setBusy(true)
      try { await invoke('stop') } finally { setBusy(false) }
    }
    const restart = async () => { await stop(); await start() }

    const openConfigFile = async () => {
      await flush()
      if (!s.configExists && draft) {
        const res = await invoke('saveConfig', draft)
        if (res?.success) setConfigLocal(res.config)
      }
      try { await api.openFile(CONFIG_FILE_NAME) } catch (e: any) { api.showToast(e?.message || 'Could not open file', 'error') }
    }

    if (!s.loaded || !draft) {
      return <div className="p-3 text-xs" style={{ color: C.muted }}>Loading mock server…</div>
    }
    if (!s.projectPath) {
      return (
        <EmptyState icon={<Server size={24} />} title="No project open">
          <div>Open a project to set up a mock server. Routes are saved in <code>{CONFIG_FILE_NAME}</code> at the project root.</div>
        </EmptyState>
      )
    }

    const routes = draft.routes
    const enabledCount = routes.filter((r) => r.enabled).length
    const setRoutes = (next: MockRoute[]) => update({ ...draft, routes: next })
    const addRoute = (seed?: Partial<MockRoute>) => {
      const r = { ...defaultRoute(), ...seed, id: newRouteId() }
      setRoutes([...routes, r])
      setExpanded(r.id)
      setRoutesOpen(true)
    }

    const visibleLog = [...s.log].reverse().filter((e) => {
      const unmatched = e.routeId === null && e.status === 404
      return logFilter === 'all' || (logFilter === 'unmatched' ? unmatched : !unmatched)
    })

    const notice = (color: string, children: React.ReactNode, key: string) => (
      <div key={key} className="rounded" style={{ fontSize: 11, padding: '6px 8px', color, background: tint(color, 10), border: `1px solid ${tint(color, 30)}` }}>{children}</div>
    )

    const statusBadge = (
      <span className="flex items-center gap-1 rounded font-semibold uppercase"
        style={{ fontSize: 9, letterSpacing: '0.05em', padding: '0 6px', lineHeight: '16px', color: running ? C.success : C.muted, background: running ? tint(C.success, 15) : tint(FG, 8) }}>
        <span className="relative inline-flex" style={{ width: 6, height: 6 }}>
          {running && <span className="absolute inline-flex rounded-full animate-ping" style={{ inset: 0, background: C.success, opacity: 0.6 }} />}
          <span className="relative inline-flex rounded-full" style={{ width: 6, height: 6, background: running ? C.success : C.muted }} />
        </span>
        {running ? 'Live' : 'Off'}
      </span>
    )

    // Routes take the leftover height. Requests size to their content, capped so
    // they never squeeze an open route editor — unless Routes is collapsed.
    const routesStyle: React.CSSProperties = routesOpen ? { flex: '1 1 0', minHeight: 0 } : { flex: '0 0 auto' }
    const logStyle: React.CSSProperties = !logOpen
      ? { flex: '0 0 auto' }
      : routesOpen ? { flex: '0 1 auto', minHeight: 0, maxHeight: '45%' } : { flex: '1 1 0', minHeight: 0 }

    return (
      <div className="flex flex-col h-full text-xs text-text" style={{ background: BG }}>
        <style>{SCOPED_CSS}</style>
        {/* ── Server ──────────────────────────────────────────────── */}
        <SectionHeader title="Server" badge={statusBadge} actions={<>
          <button className={iconBtn} title={`Open ${CONFIG_FILE_NAME}`} onClick={openConfigFile}><FileJson size={13} /></button>
          <button className={iconBtn} title="Server settings" onClick={() => setSettingsOpen(!settingsOpen)}
            style={settingsOpen ? { color: FG, background: tint(FG, 10) } : undefined}><Settings2 size={13} /></button>
        </>} />
        <div className="flex flex-col gap-2 shrink-0" style={{ padding: 10 }}>
          {running && status?.url ? (
            <div className="flex flex-col gap-1">
              {[
                { label: (status.networkUrls ?? []).length ? 'This machine' : null, url: status.url },
                ...(status.networkUrls ?? []).map((url) => ({ label: 'Network', url })),
              ].map(({ label, url }) => (
                <div key={url} className="flex items-center gap-1 rounded border border-border" style={{ background: C.input, padding: '2px 2px 2px 8px' }}>
                  {label && (
                    <span className="shrink-0 uppercase font-semibold" style={{ fontSize: 9, letterSpacing: '0.05em', color: C.muted, width: 62 }}>{label}</span>
                  )}
                  <span className="font-mono truncate flex-1" style={{ fontSize: 12, color: C.success }} title={url}>{url}</span>
                  <button className={iconBtn} title="Copy URL" onClick={() => copy(url, url, 'Mock server URL copied')}>
                    {copied === url ? <Check size={13} style={{ color: C.success }} /> : <Copy size={13} />}
                  </button>
                </div>
              ))}
              {draft.host === '0.0.0.0' && (status.networkUrls ?? []).length === 0 && (
                <div style={{ fontSize: 10, color: C.warning }}>LAN is on, but this machine isn't connected to a network.</div>
              )}
              {(status.networkUrls ?? []).length > 0 && (
                <div style={{ fontSize: 10, color: C.muted }}>Use a Network URL from a phone, VM or another computer on the same Wi-Fi.</div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: C.muted }}>
              {enabledCount === 0
                ? 'Add a route below, then start the server.'
                : <>Serves {enabledCount} route{enabledCount === 1 ? '' : 's'} at <span className="font-mono">{draft.host === '0.0.0.0' ? '0.0.0.0' : 'localhost'}:{draft.port}</span></>}
            </div>
          )}

          {running ? (
            <button className="flex items-center justify-center gap-1.5 rounded w-full disabled:opacity-50" disabled={busy} onClick={stop}
              style={{ fontSize: 12, padding: '6px 0', color: C.error, background: tint(C.error, 12), border: `1px solid ${tint(C.error, 35)}` }}>
              <Square size={11} fill="currentColor" /> Stop server
            </button>
          ) : (
            <button className="flex items-center justify-center gap-1.5 rounded w-full disabled:opacity-50" disabled={busy} onClick={start}
              style={{ fontSize: 12, padding: '6px 0', color: '#fff', background: C.primary }}>
              <Play size={11} fill="currentColor" /> Start server
            </button>
          )}

          {servingOtherProject && notice(C.warning, <>Serving routes from another project ({status!.projectPath}). Stop it to serve this one.</>, 'other')}
          {needsRestart && notice(C.warning, (
            <div className="flex items-center gap-2">
              <span className="flex-1">Port or access changed.</span>
              <button className="underline font-semibold" onClick={restart} disabled={busy}>Restart</button>
            </div>
          ), 'restart')}
          {status?.error && !running && notice(C.error, (
            <div className="flex flex-col gap-1.5">
              <span>{status.error}</span>
              {status.suggestedPort && (
                <button className="flex items-center justify-center gap-1.5 rounded w-full disabled:opacity-50" disabled={busy}
                  style={{ fontSize: 12, padding: '5px 0', color: '#fff', background: C.primary }}
                  onClick={() => { update({ ...draft, port: status.suggestedPort! }); void start() }}>
                  <Play size={11} fill="currentColor" /> Start on port {status.suggestedPort}
                </button>
              )}
            </div>
          ), 'status')}
          {s.configError && notice(C.error, s.configError, 'config')}
          {saveError && notice(C.error, saveError, 'save')}

          {settingsOpen && (
            <div className="flex flex-col gap-2 rounded border border-border" style={{ padding: 8, background: C.well }}>
              <div className="flex items-center gap-2">
                <span className="flex-1" style={{ fontSize: 11, color: C.muted }}>Port</span>
                <input className={inputCls + ' font-mono'} style={{ ...inputStyle, width: 72 }} type="number" min={1} max={65535} value={draft.port}
                  onChange={(e) => update({ ...draft, port: Number(e.target.value) || draft.port })} />
              </div>
              <div className="flex items-center gap-1" title="LAN listens on all network interfaces, so a phone or VM can reach the mock">
                <span className="flex-1" style={{ fontSize: 11, color: C.muted }}>Access</span>
                <Chip active={draft.host !== '0.0.0.0'} onClick={() => update({ ...draft, host: '127.0.0.1' })}>This machine</Chip>
                <Chip active={draft.host === '0.0.0.0'} onClick={() => update({ ...draft, host: '0.0.0.0' })}>LAN</Chip>
              </div>
              <div className="flex items-center gap-2" title="Adds Access-Control-Allow-* headers and answers preflight requests, so browser apps can call the mock">
                <span className="flex-1" style={{ fontSize: 11, color: C.muted }}>CORS for browser apps</span>
                <Switch checked={draft.cors} onChange={(v) => update({ ...draft, cors: v })} />
              </div>
            </div>
          )}
        </div>

        {/* ── Routes ──────────────────────────────────────────────── */}
        <div className="flex flex-col" style={routesStyle}>
          <SectionHeader title="Routes" count={routes.length} open={routesOpen} onToggle={() => setRoutesOpen(!routesOpen)}
            actions={<button className={iconBtn} title="New route" onClick={() => addRoute()}><Plus size={14} /></button>} />
          {routesOpen && (
            <div className="flex-1 overflow-y-auto min-h-0" key={editorEpoch}>
              {routes.length === 0 ? (
                <EmptyState icon={<Server size={22} />} title="No routes yet">
                  <div>A route answers a method and path, like <code>GET /users/:id</code>, with a fixed status, headers and body.</div>
                  <button className="flex items-center gap-1 rounded" style={{ marginTop: 6, fontSize: 11, padding: '4px 10px', color: '#fff', background: C.primary }} onClick={() => addRoute()}>
                    <Plus size={11} /> Add first route
                  </button>
                </EmptyState>
              ) : routes.map((r, i) => (
                <RouteRow key={r.id} route={r} index={i} count={routes.length} expanded={expanded === r.id} hits={hits[r.id] ?? 0}
                  baseUrl={baseUrl} copied={copied === r.id}
                  onCopy={() => baseUrl && copy(baseUrl + r.path, r.id)}
                  onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
                  onChange={(nr) => setRoutes(routes.map((x) => (x.id === r.id ? nr : x)))}
                  onDelete={() => { setRoutes(routes.filter((x) => x.id !== r.id)); setExpanded(null) }}
                  onDuplicate={() => {
                    const dup = { ...r, id: newRouteId(), headers: { ...r.headers } }
                    const next = [...routes]; next.splice(i + 1, 0, dup); setRoutes(next); setExpanded(dup.id)
                  }}
                  onMove={(dir) => {
                    const next = [...routes]; const j = i + dir
                    ;[next[i], next[j]] = [next[j], next[i]]; setRoutes(next)
                  }} />
              ))}
            </div>
          )}
        </div>

        {/* ── Requests ────────────────────────────────────────────── */}
        <div className="flex flex-col" style={logStyle}>
          <SectionHeader title="Requests" count={s.log.length} open={logOpen} onToggle={() => setLogOpen(!logOpen)}
            badge={unmatchedCount > 0 ? (
              <span className="font-mono rounded" title={`${unmatchedCount} request(s) matched no route`}
                style={{ fontSize: 10, padding: '0 5px', lineHeight: '16px', color: C.warning, background: tint(C.warning, 15) }}>{unmatchedCount} unmatched</span>
            ) : undefined}
            actions={s.log.length > 0 ? (
              <button className={iconBtn} title="Clear requests" onClick={async () => { clearLogLocal(); await invoke('clearLog') }}><Trash2 size={13} /></button>
            ) : undefined} />
          {logOpen && (
            <>
              {s.log.length > 0 && (
                <div className="flex items-center gap-1 shrink-0" style={{ padding: '6px 8px', borderBottom: `1px solid ${C.line}` }}>
                  {(['all', 'matched', 'unmatched'] as LogFilter[]).map((f) => (
                    <Chip key={f} active={logFilter === f} onClick={() => setLogFilter(f)} color={f === 'unmatched' ? C.warning : undefined}>
                      {f === 'all' ? 'All' : f === 'matched' ? 'Matched' : 'Unmatched'}
                    </Chip>
                  ))}
                </div>
              )}
              <div className="flex-1 overflow-y-auto min-h-0">
                {s.log.length === 0 ? (
                  <EmptyState icon={<Inbox size={22} />} title="No requests yet">
                    <div>{running ? <>Send a request to <code>{status?.url}</code> and it shows up here.</> : 'Start the server to see incoming requests here.'}</div>
                  </EmptyState>
                ) : visibleLog.length === 0 ? (
                  <div style={{ padding: 12, fontSize: 11, color: C.muted }}>No {logFilter} requests.</div>
                ) : visibleLog.map((e) => (
                  <LogRow key={e.id} entry={e} onAddRoute={(entry) => addRoute({
                    method: (HTTP_METHODS as readonly string[]).includes(entry.method) ? entry.method as MockMethod : 'GET',
                    path: entry.path,
                    body: '{}',
                  })} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    )
  }
}
