import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HEADER_ROWS, InfoPanel, KeyHints, Logo, Prompt } from './chrome'
import { REVISED } from './cost'
import { Describe, Logs } from './panes'
import type { Kind, Row } from './resources'
import { KINDS, matchKinds, suggest } from './resources'
import { projectOf } from './project'
import type { Instance } from './wrangler'

const REFRESH_MS = 10_000

/**
 * First visible row: keep the cursor centred, but never scroll past either end,
 * so short lists sit flush at the top and the last page stays full.
 */
export function viewportStart(cursor: number, total: number, capacity: number): number {
  return Math.min(Math.max(cursor - Math.floor(capacity / 2), 0), Math.max(total - capacity, 0))
}

/**
 * Shrink the widest column repeatedly until the row fits. Clipping the whole line
 * instead would always eat the rightmost column, so a narrow terminal would lose
 * the very fields (REQ, STATE, AGE) you opened c9s to see.
 */
export function fitWidths(widths: number[], available: number, gap = 2, min = 3): number[] {
  const out = [...widths]
  const total = () => out.reduce((a, b) => a + b, 0) + gap * Math.max(out.length - 1, 0)
  while (total() > available) {
    let widest = 0
    for (let i = 1; i < out.length; i++) if (out[i]! > out[widest]!) widest = i
    if (out[widest]! <= min) break
    out[widest] = out[widest]! - 1
  }
  return out
}

/** Pad a value into a fixed column, ellipsising rather than overflowing it. */
const cell = (v: string, w: number) => (v.length > w ? `${v.slice(0, w - 1)}…` : v.padEnd(w))

/** Everything that touches the network or the terminal is injected, so tests and `--demo` drive the real UI. */
export type AppProps = {
  account: string
  load: (kind: Kind) => Promise<Row[]>
  instances?: (appId: string) => Promise<Instance[]>
  tail?: (worker: string, onLine: (line: string) => void) => () => void
  shell?: (appId: string, name: string) => void
  initialKind?: string
}

type Mode = 'normal' | 'command' | 'filter'
type View = 'table' | 'describe' | 'logs'

export function App({ account, load, instances, tail, shell, initialKind }: AppProps) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [k, setK] = useState(() =>
    Math.max(
      KINDS.findIndex((x) => x.key === initialKind),
      0,
    ),
  )
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [cursor, setCursor] = useState(0)
  const [filter, setFilter] = useState('')
  const [command, setCommand] = useState('')
  const [mode, setModeState] = useState<Mode>('normal')
  const [view, setViewState] = useState<View>('table')
  const [scroll, setScroll] = useState(0)
  const [inst, setInst] = useState<Instance[] | 'loading' | { error: string } | undefined>(
    undefined,
  )
  const [tick, setTick] = useState(0)
  const [scope, setScope] = useState('')
  const [anchors, setAnchors] = useState<string[]>([])
  const [projectNames, setProjectNames] = useState<string[]>([])

  const kind = KINDS[k]!

  // Read fresh inside useInput: two keystrokes in one React batch would otherwise
  // both see the pre-batch mode, so `:wk` drops the `wk` (or worse, runs it as
  // commands). Real keyboards hit this, not just tests.
  const modeRef = useRef<Mode>('normal')
  const viewRef = useRef<View>('table')
  const setMode = useCallback((m: Mode) => {
    modeRef.current = m
    setModeState(m)
  }, [])
  const setView = useCallback((v: View) => {
    viewRef.current = v
    setViewState(v)
  }, [])

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let live = true
    setLoading(true)
    load(kind)
      .then((r) => {
        if (!live) return
        setRows(r)
        setError(null)
      })
      .catch((e: Error) => {
        if (!live) return
        setRows([])
        setError(e.message)
      })
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [kind, load, tick])

  useEffect(() => {
    // Polling a table you are not looking at is pure noise; panes own their own updates.
    if (view !== 'table') return
    const id = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(id)
  }, [refresh, view])

  // Worker names anchor project attribution for every other product, so fetch them
  // once rather than re-deriving per view. Failure just means weaker grouping.
  useEffect(() => {
    const workers = KINDS.find((x) => x.key === 'workers')
    if (!workers) return
    let live = true
    load(workers)
      .then((ws) => live && setAnchors(ws.map((w) => w.NAME ?? '').filter(Boolean)))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [load])

  const projectOfRow = useCallback(
    (r: Row) => r.PROJECT || r._project || projectOf(r.NAME ?? '', anchors),
    [anchors],
  )

  // The completion source for `:proj <name>`. Cloudflare has no project list to
  // query — c9s infers it — so accumulate the names attribution has produced so
  // far instead of paying for a `projects` fan-out on boot. Monotonic: a refresh
  // or a kind switch only ever adds.
  useEffect(() => {
    const seen = rows.map(projectOfRow).filter(Boolean)
    if (seen.length === 0) return
    setProjectNames((prev) => {
      const next = new Set(prev)
      for (const p of seen) next.add(p)
      return next.size === prev.length ? prev : [...next].toSorted()
    })
  }, [rows, projectOfRow])

  const visible = useMemo(() => {
    let out = rows
    // Scope first: it is a persistent lens, filter is a transient search inside it.
    if (scope) out = out.filter((r) => projectOfRow(r) === scope)
    if (filter) {
      const f = filter.toLowerCase()
      out = out.filter((r) => Object.values(r).some((v) => v.toLowerCase().includes(f)))
    }
    return out
  }, [rows, filter, scope, projectOfRow])

  const selected = visible[cursor]
  /** The kind a row belongs to, which is not the current kind inside the All view. */
  const rowKind = useMemo(
    () => (selected?._kind ? (KINDS.find((x) => x.key === selected._kind) ?? kind) : kind),
    [selected, kind],
  )

  const goto = useCallback(
    (text: string) => {
      const q = text.trim().toLowerCase()
      if (q === 'q' || q === 'quit') return exit()
      // `:proj <name>` sets the scope; bare `:proj` is still the Projects view.
      const scoped = /^(proj|project|p)\s+(.+)$/.exec(q)
      if (scoped) {
        const name = scoped[2]!.trim()
        setScope(name === 'all' || name === '*' ? '' : name)
        setCursor(0)
        setFilter('')
        return
      }
      const hit = matchKinds(q)[0]
      if (!hit) return
      setK(KINDS.indexOf(hit))
      setCursor(0)
      setFilter('')
    },
    [exit],
  )

  const openDescribe = useCallback(() => {
    if (!selected) return
    // On the Projects rollup, a row IS a project, so enter scopes to it and drills
    // into All rather than describing a synthetic aggregate row.
    if (kind.key === 'projects') {
      setScope(selected.PROJECT ?? '')
      setK(KINDS.findIndex((x) => x.key === 'all'))
      setCursor(0)
      return
    }
    setScroll(0)
    setInst(undefined)
    setView('describe')
    const appId = selected._id
    if (rowKind.actions?.ssh && instances && appId) {
      setInst('loading')
      instances(appId)
        .then(setInst)
        .catch((e: Error) => setInst({ error: e.message }))
    }
  }, [selected, rowKind, instances, setView, kind])

  useInput((input, key) => {
    const m = modeRef.current

    if (m !== 'normal') {
      const set = m === 'command' ? setCommand : setFilter
      if (key.escape) {
        setMode('normal')
        set('')
      } else if (key.return) {
        if (m === 'command') {
          goto(command)
          setCommand('')
        }
        setMode('normal')
      } else if (key.tab && m === 'command') {
        setCommand((c) => c + suggest(c, projectNames).completion)
      } else if (key.backspace || key.delete) {
        set((c) => c.slice(0, -1))
      } else if (input) {
        set((c) => c + input)
      }
      return
    }

    if (viewRef.current !== 'table') {
      if (key.escape || input === 'q') return setView('table')
      if (input === 'j' || key.downArrow) setScroll((s) => s + 1)
      if (input === 'k' || key.upArrow) setScroll((s) => Math.max(s - 1, 0))
      return
    }

    if (input === 'q' || (key.ctrl && input === 'c')) return exit()
    if (input === 'r') return refresh()
    if (input === ':') return setMode('command')
    if (input === '/') return setMode('filter')
    if (key.return) return openDescribe()
    if (input === 'l' && rowKind.actions?.tail && tail) return setView('logs')
    if (input === 's' && rowKind.actions?.ssh && shell && selected?._id) {
      return shell(selected._id, selected.NAME ?? '')
    }
    if (key.escape) return setFilter('')

    if (key.tab) {
      setK((i) => (i + (key.shift ? KINDS.length - 1 : 1)) % KINDS.length)
      setCursor(0)
      return
    }
    if (input === '0') {
      setScope('')
      setCursor(0)
      return
    }
    const n = Number(input)
    if (n >= 1 && n <= KINDS.length) {
      setK(n - 1)
      setCursor(0)
      return
    }
    if (input === 'j' || key.downArrow)
      setCursor((c) => Math.min(c + 1, Math.max(visible.length - 1, 0)))
    if (input === 'k' || key.upArrow) setCursor((c) => Math.max(c - 1, 0))
  })

  const prompted = useMemo(() => suggest(command, projectNames), [command, projectNames])

  const cols = stdout?.columns ?? 100
  const inner = Math.max(cols - 6, 20)
  const widths = useMemo(
    () =>
      fitWidths(
        kind.columns.map((c) => Math.max(c.length, ...visible.map((r) => (r[c] ?? '').length), 0)),
        inner - 2, // the `> ` cursor gutter
      ),
    [kind, visible, inner],
  )
  /**
   * Pad to the box width so the selected row highlights edge to edge, and clip to
   * it so a long row cannot wrap: Ink reflows overflow onto a second line, which
   * pushes the fixed-height box past the terminal and silently eats the last row.
   */
  const fit = (s: string) => (s.length > inner ? `${s.slice(0, inner - 1)}…` : s.padEnd(inner))
  const line = (cells: string[]) => cells.map((v, i) => cell(v, widths[i] ?? 0)).join('  ')

  // Fill the terminal: the main box takes whatever the header and prompt leave.
  const promptRows = mode !== 'normal' || filter ? 3 : 0
  const bodyRows = Math.max((stdout?.rows ?? 24) - HEADER_ROWS - promptRows, 5)
  // Border (2) + title + column header. Whatever is left is rows we can show.
  const capacity = Math.max(bodyRows - 4, 1)
  const start = viewportStart(cursor, visible.length, capacity)
  const page = visible.slice(start, start + capacity)

  const more =
    visible.length > capacity ? ` ${start + 1}-${start + page.length}/${visible.length}` : ''
  // Parens hold the scope, as k9s puts the namespace there. The filter shows in the prompt.
  const title = ` ${kind.title}(${scope || 'all'})[${visible.length}]${more} `

  const tailFor = useCallback(
    (onLine: (l: string) => void) =>
      tail && selected ? tail(selected.NAME ?? '', onLine) : () => {},
    [tail, selected],
  )

  return (
    <Box flexDirection="column">
      <Box width={cols}>
        <InfoPanel
          account={account}
          project={scope}
          count={visible.length}
          refreshSecs={REFRESH_MS / 1000}
          rates={kind.key === 'cost' ? REVISED : undefined}
        />
        <KeyHints />
        <Box flexGrow={1} />
        <Logo />
      </Box>

      {mode !== 'normal' || filter ? (
        <Prompt
          mode={mode === 'filter' || (mode === 'normal' && !!filter) ? 'filter' : 'command'}
          value={mode === 'command' ? command : filter}
          completion={mode === 'command' ? prompted.completion : ''}
          candidates={mode === 'command' ? prompted.candidates : []}
        />
      ) : null}

      {view === 'describe' && selected ? (
        <Describe
          // A row's identity is its first column, which is NAME for a product and
          // PROJECT for a rollup — reaching for NAME alone titles Cost as `Cost: `.
          title={`${rowKind.title}: ${selected[rowKind.columns[0] ?? 'NAME'] ?? ''}`}
          raw={selected._raw ?? '(no detail)'}
          instances={inst}
          height={bodyRows}
          scroll={scroll}
        />
      ) : view === 'logs' && selected ? (
        <Logs worker={selected.NAME ?? ''} subscribe={tailFor} height={bodyRows} />
      ) : (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
          height={bodyRows}
        >
          <Text color="cyan" bold>
            {title}
          </Text>
          <Text color="cyan" bold>
            {fit('  ' + line(kind.columns))}
          </Text>

          {error ? (
            <Text color="red">{error}</Text>
          ) : visible.length === 0 ? (
            <Text dimColor>{loading ? 'loading…' : 'no resources'}</Text>
          ) : (
            page.map((row, n) => {
              const i = start + n
              const text = fit(
                (i === cursor ? '> ' : '  ') + line(kind.columns.map((c) => row[c] ?? '-')),
              )
              // Name alone collides across products in the All view: a Worker and
              // an R2 bucket can both be called `agent-canvas`.
              const id = `${row._kind ?? kind.key}:${row.NAME ?? i}`
              return i === cursor ? (
                <Text key={id} backgroundColor="cyan" color="black" bold>
                  {text}
                </Text>
              ) : (
                <Text key={id}>{text}</Text>
              )
            })
          )}
        </Box>
      )}
    </Box>
  )
}
