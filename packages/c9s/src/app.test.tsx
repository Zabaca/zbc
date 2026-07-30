import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { App, fitWidths, viewportStart } from './app'
import { demoInstances, demoLoad } from './fixture'
import { KINDS, completion, isMeta, matchKinds } from './resources'

const ESC = ''
const ENTER = '\r'
const TAB = '\t'
const settle = () => new Promise((r) => setTimeout(r, 20))

const stripBox = (frame: string) => frame.split('\n').map((l) => l.replace(/[│╭╰─╮╯]/g, '').trim())

/** The candidate line inside the prompt box: the line right after the one holding the cursor. */
function candidates(frame: string): string[] {
  const lines = stripBox(frame)
  const at = lines.findIndex((l) => l.startsWith('>') && l.endsWith('▌'))
  return at === -1 ? [] : (lines[at + 1]?.split(/\s+/).filter(Boolean) ?? [])
}

async function boot() {
  const app = render(<App account="test" load={demoLoad} />)
  await settle()
  return app
}

test('boots on workers and lists them', async () => {
  const { lastFrame } = await boot()
  expect(lastFrame()).toContain('Workers(all)[3]')
  expect(lastFrame()).toContain('agent-canvas')
})

test('every kind renders its own columns and rows', async () => {
  const { lastFrame, stdin } = await boot()
  for (const [i, kind] of KINDS.entries()) {
    stdin.write(String(i + 1))
    await settle()
    const frame = lastFrame()!
    expect(frame).toContain(kind.title)
    for (const col of kind.columns) expect(frame).toContain(col)
  }
})

test('filter narrows rows, and the title keeps showing the scope', async () => {
  const { lastFrame, stdin } = await boot()
  stdin.write('/')
  stdin.write('tour')
  await settle()
  expect(lastFrame()).toContain('tour-guide')
  expect(lastFrame()).not.toContain('zbc-inbox')
  // Parens hold the project scope, k9s-style. The filter lives in the prompt.
  expect(lastFrame()).toContain('Workers(all)[1]')
})

test('escape clears the filter', async () => {
  const { lastFrame, stdin } = await boot()
  stdin.write('/')
  stdin.write('tour')
  await settle()
  stdin.write(ESC)
  await settle()
  expect(lastFrame()).toContain('zbc-inbox')
  expect(lastFrame()).toContain('Workers(all)[3]')
})

test('cursor moves and stops at the ends', async () => {
  const { lastFrame, stdin } = await boot()
  expect(lastFrame()).toContain('> agent-canvas')
  stdin.write('j')
  await settle()
  expect(lastFrame()).toContain('> zbc-inbox')
  for (let i = 0; i < 5; i++) stdin.write('j')
  await settle()
  expect(lastFrame()).toContain('> tour-guide')
  for (let i = 0; i < 9; i++) stdin.write('k')
  await settle()
  expect(lastFrame()).toContain('> agent-canvas')
})

test('an empty kind says so rather than rendering a bare header', async () => {
  const { lastFrame, stdin } = await boot()
  stdin.write(String(KINDS.findIndex((k) => k.key === 'kv') + 1))
  await settle()
  expect(lastFrame()).toContain('no resources')
})

test('a failing load surfaces the error instead of an empty table', async () => {
  const { lastFrame } = render(
    <App
      account="test"
      load={async () => {
        throw new Error('Unable to authenticate request')
      }}
    />,
  )
  await settle()
  expect(lastFrame()).toContain('Unable to authenticate request')
})

test('every kind declares columns its rows actually use', async () => {
  for (const kind of KINDS) {
    const rows = await demoLoad(kind)
    for (const row of rows) {
      // `_`-prefixed keys are metadata carried to the panes, not table columns.
      expect(
        Object.keys(row)
          .filter((c) => !isMeta(c))
          .toSorted(),
      ).toEqual(kind.columns.toSorted())
    }
  }
})

test('command mode jumps to a kind by key', async () => {
  const { lastFrame, stdin } = await boot()
  stdin.write(':')
  stdin.write('containers')
  await settle()
  stdin.write(ENTER)
  await settle()
  expect(lastFrame()).toContain('Containers(all)[2]')
  expect(lastFrame()).toContain('warehouse-warehouse')
})

test('command mode jumps by alias', async () => {
  const { lastFrame, stdin } = await boot()
  stdin.write(':')
  stdin.write('db')
  await settle()
  stdin.write(ENTER)
  await settle()
  expect(lastFrame()).toContain('D1(all)[1]')
})

test('command mode lists candidates and narrows as you type', async () => {
  const { lastFrame, stdin } = await boot()
  stdin.write(':')
  await settle()
  expect(lastFrame()).toContain('workers')
  expect(lastFrame()).toContain('queues')
  stdin.write('co')
  await settle()
  // Assert on the candidate line specifically: every kind name also appears in
  // the always-visible key-hints panel, so a whole-frame check proves nothing.
  expect(candidates(lastFrame()!)).toEqual(['containers'])
})

test('tab accepts the ghost completion, changing what the prompt resolves to', async () => {
  const { lastFrame, stdin } = await boot()
  stdin.write(':')
  stdin.write('d')
  await settle()
  // `d` is ambiguous, so both candidates show. The rendered prompt text cannot
  // prove tab (value + ghost reads the same before and after), but the candidate
  // list is derived from the value alone, so it can.
  expect(candidates(lastFrame()!)).toEqual(['do', 'd1'])
  stdin.write(TAB)
  await settle()
  expect(candidates(lastFrame()!)).toEqual(['do'])
  stdin.write(ENTER)
  await settle()
  expect(lastFrame()).toContain('Durable Objects(all)[1]')
})

test('escape leaves command mode without navigating', async () => {
  const { lastFrame, stdin } = await boot()
  stdin.write(':')
  stdin.write('d1')
  await settle()
  stdin.write(ESC)
  await settle()
  expect(lastFrame()).toContain('Workers(all)[3]')
})

test('viewport keeps the cursor on screen without scrolling past the ends', () => {
  const cap = 10
  // Short list: never scrolls.
  expect(viewportStart(0, 3, cap)).toBe(0)
  expect(viewportStart(2, 3, cap)).toBe(0)
  // Long list: flush at the top until the cursor passes the midpoint.
  expect(viewportStart(0, 26, cap)).toBe(0)
  expect(viewportStart(4, 26, cap)).toBe(0)
  expect(viewportStart(5, 26, cap)).toBe(0)
  expect(viewportStart(6, 26, cap)).toBe(1)
  // Last page stays full rather than trailing blank rows.
  expect(viewportStart(25, 26, cap)).toBe(16)
  // The cursor is always inside the returned window.
  for (let c = 0; c < 26; c++) {
    const s = viewportStart(c, 26, cap)
    expect(c).toBeGreaterThanOrEqual(s)
    expect(c).toBeLessThan(s + cap)
  }
})

test('enter describes the selected row, escape returns to the table', async () => {
  const { lastFrame, stdin } = await boot()
  stdin.write(ENTER)
  await settle()
  expect(lastFrame()).toContain('Workers: agent-canvas')
  expect(lastFrame()).toContain('cf:service=agent-canvas')
  stdin.write(ESC)
  await settle()
  expect(lastFrame()).toContain('Workers(all)[3]')
})

test('describing a container fetches its instances', async () => {
  const { lastFrame, stdin } = render(
    <App account="test" load={demoLoad} instances={demoInstances} />,
  )
  await settle()
  stdin.write(String(KINDS.findIndex((k) => k.key === 'containers') + 1))
  await settle()
  stdin.write(ENTER)
  await settle()
  expect(lastFrame()).toContain('Containers: warehouse-warehouse')
  // Header and data must be on their OWN lines. A whole-frame `toContain` passed
  // happily while Ink was overlapping them into `-OCATION` on one row.
  const lines = lastFrame()!.split('\n')
  const header = lines.findIndex((l) => l.includes('INSTANCE') && l.includes('LOCATION'))
  expect(header).toBeGreaterThan(-1)
  const row = lines[header + 1] ?? ''
  expect(row).toContain('running')
  expect(row).toContain('sjc01')
  expect(row).not.toContain('LOCATION')
})

test('an instances lookup failure is shown, not swallowed', async () => {
  const { lastFrame, stdin } = render(
    <App
      account="test"
      load={demoLoad}
      instances={async () => {
        throw new Error('NOT_ENABLED')
      }}
    />,
  )
  await settle()
  stdin.write(String(KINDS.findIndex((k) => k.key === 'containers') + 1))
  await settle()
  stdin.write(ENTER)
  await settle()
  expect(lastFrame()).toContain('instances: NOT_ENABLED')
})

test('l tails a worker and streams lines into the pane', async () => {
  const emitters: ((line: string) => void)[] = []
  let stopped = false
  const { lastFrame, stdin } = render(
    <App
      account="test"
      load={demoLoad}
      tail={(_worker, onLine) => {
        emitters.push(onLine)
        return () => {
          stopped = true
        }
      }}
    />,
  )
  await settle()
  stdin.write('l')
  await settle()
  expect(lastFrame()).toContain('tail agent-canvas')
  emitters[0]!('GET / - Ok @ 12:00:00')
  await settle()
  expect(lastFrame()).toContain('GET / - Ok @ 12:00:00')
  // Closing the pane must kill the subprocess, or every `l` leaks a wrangler.
  stdin.write(ESC)
  await settle()
  expect(stopped).toBe(true)
})

test('l does nothing on a kind that cannot be tailed', async () => {
  const { lastFrame, stdin } = render(<App account="test" load={demoLoad} tail={() => () => {}} />)
  await settle()
  stdin.write(String(KINDS.findIndex((k) => k.key === 'd1') + 1))
  await settle()
  stdin.write('l')
  await settle()
  expect(lastFrame()).toContain('D1(all)[1]')
  expect(lastFrame()).not.toContain('tail ')
})

test('s hands the container id to the shell hook, and only for containers', async () => {
  const calls: string[] = []
  const { stdin } = render(<App account="test" load={demoLoad} shell={(id) => calls.push(id)} />)
  await settle()
  stdin.write('s') // on Workers: no ssh action, so nothing happens
  await settle()
  expect(calls).toEqual([])
  stdin.write(String(KINDS.findIndex((k) => k.key === 'containers') + 1))
  await settle()
  stdin.write('s')
  await settle()
  expect(calls).toEqual(['a0369a59-b4dc-40a3-9a8e-48175721c363'])
})

test('the All view attributes every resource to a project', async () => {
  const rows = await demoLoad(KINDS.find((k) => k.key === 'all')!)
  const byName = new Map(rows.map((r) => [`${r._kind}:${r.NAME}`, r.PROJECT]))
  // Tag wins where Cloudflare set one.
  expect(byName.get('workers:agent-canvas')).toBe('agent-canvas')
  // Bucket named after the Worker it serves.
  expect(byName.get('r2:tour-guide-cache')).toBe('tour-guide')
  // A DO namespace belongs to its script, not to a name guess.
  expect(byName.get('do:agent-canvas_Sandbox')).toBe('agent-canvas')
  // Container prefixed by its Worker.
  expect(byName.get('containers:agent-canvas-sandbox')).toBe('agent-canvas')
})

test('the Projects view rolls up counts per product, biggest first', async () => {
  const rows = await demoLoad(KINDS.find((k) => k.key === 'projects')!)
  const canvas = rows.find((r) => r.PROJECT === 'agent-canvas')!
  expect(canvas.WORKERS).toBe('1')
  expect(canvas.CONTAINERS).toBe('1')
  expect(canvas.DO).toBe('1')
  expect(canvas.R2).toBe('1')
  expect(canvas.TOTAL).toBe('4')
  const totals = rows.map((r) => Number(r.TOTAL))
  expect(totals).toEqual(totals.toSorted((a, b) => b - a))
})

test('a wide table clips instead of wrapping, keeping the box intact', async () => {
  const { lastFrame, stdin } = await boot()
  stdin.write(String(KINDS.findIndex((k) => k.key === 'all') + 1))
  await settle()
  const lines = lastFrame()!.split('\n')
  const box = lines.filter((l) => l.startsWith('│'))
  // Every row inside the box is exactly as wide as the box: no wrapped remainder,
  // which is what silently ate the last row and the title before this was fixed.
  const widths = new Set(box.map((l) => l.length))
  expect(widths.size).toBe(1)
  expect(lastFrame()).toContain('All(all)[')
})

test('column widths shrink the widest column, never the rightmost', () => {
  // Fits already: untouched.
  expect(fitWidths([10, 5, 5], 100)).toEqual([10, 5, 5])
  // Over budget: the 40 gives up width, the small columns keep theirs.
  const out = fitWidths([40, 5, 6], 30)
  expect(out[1]).toBe(5)
  expect(out[2]).toBe(6)
  expect(out.reduce((a, b) => a + b, 0) + 4).toBeLessThanOrEqual(30)
  // Impossible budget: stops at the floor rather than looping forever or going negative.
  expect(fitWidths([40, 30], 4, 2, 3)).toEqual([3, 3])
})

test(':proj scopes every view, and the scope survives switching kinds', async () => {
  const { lastFrame, stdin } = await boot()
  stdin.write(':')
  stdin.write('proj agent-canvas')
  await settle()
  stdin.write(ENTER)
  await settle()
  expect(lastFrame()).toContain('Workers(agent-canvas)[1]')
  expect(lastFrame()).toContain('agent-canvas')
  expect(lastFrame()).not.toContain('tour-guide')
  // The whole point of a scope: it persists as you browse, unlike a filter.
  stdin.write(String(KINDS.findIndex((k) => k.key === 'r2') + 1))
  await settle()
  expect(lastFrame()).toContain('R2(agent-canvas)[1]')
  expect(lastFrame()).not.toContain('tour-guide-cache')
})

test('0 clears the project scope', async () => {
  const { lastFrame, stdin } = await boot()
  stdin.write(':')
  stdin.write('proj agent-canvas')
  await settle()
  stdin.write(ENTER)
  await settle()
  expect(lastFrame()).toContain('Workers(agent-canvas)[1]')
  stdin.write('0')
  await settle()
  expect(lastFrame()).toContain('Workers(all)[3]')
  expect(lastFrame()).toContain('tour-guide')
})

test('enter on a Projects row scopes to it and drills into All', async () => {
  const { lastFrame, stdin } = await boot()
  stdin.write(String(KINDS.findIndex((k) => k.key === 'projects') + 1))
  await settle()
  expect(lastFrame()).toContain('Projects(all)')
  stdin.write(ENTER)
  await settle()
  expect(lastFrame()).toContain('All(agent-canvas)[4]')
})

test('scope applies to a product whose rows carry no project of their own', async () => {
  const { lastFrame, stdin } = await boot()
  stdin.write(':')
  stdin.write('proj tour-guide')
  await settle()
  stdin.write(ENTER)
  await settle()
  // The bucket is attributed by name prefix against the Worker anchors, not by a tag.
  stdin.write(String(KINDS.findIndex((k) => k.key === 'r2') + 1))
  await settle()
  expect(lastFrame()).toContain('R2(tour-guide)[1]')
  expect(lastFrame()).toContain('tour-guide-cache')
})

test('completion prefers key prefixes, and :q is not a kind', () => {
  expect(completion('cont')).toBe('ainers')
  // `d` is ambiguous between do and d1; first-in-KINDS-order wins, as k9s does.
  expect(completion('d')).toBe('o')
  expect(completion('d1')).toBe('')
  expect(matchKinds('q').map((k) => k.key)).toEqual(['queues'])
  expect(matchKinds('zzz')).toEqual([])
  // `queue` reaches Queues by alias; bare `q` must stay free for quit.
  expect(KINDS.every((k) => !k.aliases.includes('q'))).toBe(true)
})
