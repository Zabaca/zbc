// Fixed rows so the UI boots with no network and no token: `c9s --demo`, and
// every test. Values are pre-rendered strings (no clock, no PRNG) so frames are
// byte-stable across runs.
import type { Resource, Sample } from './cost'
import { costRows } from './resources'
import type { Kind, Row } from './resources'
import { projectOf } from './project'
import type { Instance } from './wrangler'

const raw = (o: unknown) => JSON.stringify(o, null, 2)

const FIXTURE: Record<string, Row[]> = {
  workers: [
    {
      NAME: 'agent-canvas',
      REQ: '412',
      ERR: '0',
      P50: '1.2ms',
      DEPLOYED: '2h',
      LOGS: 'on',
      _id: 'agent-canvas',
      _project: 'agent-canvas',
      _raw: raw({
        id: 'agent-canvas',
        tags: ['cf:service=agent-canvas'],
        observability: { enabled: true },
      }),
    },
    {
      NAME: 'zbc-inbox',
      REQ: '37',
      ERR: '2',
      P50: '860µs',
      DEPLOYED: '4d',
      LOGS: 'on',
      _id: 'zbc-inbox',
      _project: '',
      _raw: raw({ id: 'zbc-inbox', tags: [], observability: { enabled: true } }),
    },
    {
      NAME: 'tour-guide',
      REQ: '1',
      ERR: '0',
      P50: '792µs',
      DEPLOYED: '1d',
      LOGS: 'off',
      _id: 'tour-guide',
      _project: '',
      _raw: raw({ id: 'tour-guide', tags: [], observability: { enabled: false } }),
    },
  ],
  containers: [
    {
      NAME: 'warehouse-warehouse',
      DESIRED: '1',
      VCPU: '4',
      MEMORY: '12GiB',
      VER: '20',
      AGE: '2d',
      _id: 'a0369a59-b4dc-40a3-9a8e-48175721c363',
      _raw: raw({ name: 'warehouse-warehouse', configuration: { vcpu: 4, memory: '12GiB' } }),
    },
    {
      NAME: 'agent-canvas-sandbox',
      DESIRED: '3',
      VCPU: '0.5',
      MEMORY: '4GiB',
      VER: '7',
      AGE: '5d',
      _id: 'b1470b60-c5ed-51b4-af9f-59286832d474',
      _raw: raw({ name: 'agent-canvas-sandbox', configuration: { vcpu: 0.5, memory: '4GiB' } }),
    },
  ],
  do: [
    {
      NAME: 'agent-canvas_Sandbox',
      SCRIPT: 'agent-canvas',
      CLASS: 'Sandbox',
      SQLITE: 'yes',
      CONTAINER: 'yes',
      _id: 'c0ebd89e',
      _project: 'agent-canvas',
      _raw: raw({ name: 'agent-canvas_Sandbox', script: 'agent-canvas' }),
    },
  ],
  d1: [
    {
      NAME: 'crux-production',
      SIZE: '360KB',
      AGE: '5d',
      _id: '18dc8b49',
      _raw: raw({ name: 'crux-production' }),
    },
  ],
  r2: [
    { NAME: 'agent-canvas', AGE: '33d', _id: 'agent-canvas', _raw: raw({ name: 'agent-canvas' }) },
    {
      NAME: 'tour-guide-cache',
      AGE: '9d',
      _id: 'tour-guide-cache',
      _raw: raw({ name: 'tour-guide-cache' }),
    },
  ],
  kv: [],
  queues: [],
}

/**
 * Halfway through the month. Pinned rather than read off the clock: `estimate`
 * projects month-to-date usage forward, so a live `elapsed` would make the demo's
 * dollar figures — and every frame a test asserts on — drift day to day.
 */
const DEMO_ELAPSED = 0.5

const DEMO_ANCHORS = (FIXTURE.workers ?? []).map((w) => w.NAME ?? '')

const DEMO_RESOURCES: Resource[] = Object.entries(FIXTURE).flatMap(([kind, rows]) =>
  rows.map((r) => ({
    kind,
    id: r._id ?? '',
    name: r.NAME ?? '',
    project: r._project || projectOf(r.NAME ?? '', DEMO_ANCHORS),
  })),
)

/**
 * Half a month of usage, chosen to show the shape of a real account rather than a
 * pretty one: Workers sit inside their included allowance and cost nothing, while
 * a container nobody thinks about bills for memory it merely reserved.
 */
const DEMO_USAGE: Sample[] = [
  { rate: 'workers.requests', id: 'agent-canvas', amount: 900_000 },
  { rate: 'workers.requests', id: 'zbc-inbox', amount: 37_000 },
  { rate: 'workers.requests', id: 'tour-guide', amount: 13_000 },
  { rate: 'workers.cpu', id: 'agent-canvas', amount: 4_900_000 },
  { rate: 'workers.cpu', id: 'zbc-inbox', amount: 96_000 },
  { rate: 'workers.cpu', id: 'tour-guide', amount: 7_000 },

  { rate: 'containers.memory', id: 'b1470b60-c5ed-51b4-af9f-59286832d474', amount: 6_200_000 },
  { rate: 'containers.memory', id: 'a0369a59-b4dc-40a3-9a8e-48175721c363', amount: 500_000 },
  { rate: 'containers.cpu', id: 'b1470b60-c5ed-51b4-af9f-59286832d474', amount: 60_000 },
  { rate: 'containers.cpu', id: 'a0369a59-b4dc-40a3-9a8e-48175721c363', amount: 5_000 },
  { rate: 'containers.disk', id: 'b1470b60-c5ed-51b4-af9f-59286832d474', amount: 12_340_000 },
  { rate: 'containers.disk', id: 'a0369a59-b4dc-40a3-9a8e-48175721c363', amount: 900_000 },

  { rate: 'do.requests', id: 'c0ebd89e', amount: 160_000 },
  { rate: 'do.duration', id: 'c0ebd89e', amount: 520_000 },
  { rate: 'do.rowsRead', id: 'c0ebd89e', amount: 340_000 },
  { rate: 'do.rowsWritten', id: 'c0ebd89e', amount: 12_000 },
  { rate: 'do.storage', id: 'c0ebd89e', amount: 0.2 },

  { rate: 'd1.rowsRead', id: '18dc8b49', amount: 3_300_000 },
  { rate: 'd1.rowsWritten', id: '18dc8b49', amount: 30_000_000 },
  { rate: 'd1.storage', id: '18dc8b49', amount: 0.36 },

  { rate: 'r2.classA', id: 'agent-canvas', amount: 900_000 },
  { rate: 'r2.classA', id: 'tour-guide-cache', amount: 400_000 },
  { rate: 'r2.classB', id: 'agent-canvas', amount: 5_000_000 },
  { rate: 'r2.storage', id: 'agent-canvas', amount: 12 },
  { rate: 'r2.storage', id: 'tour-guide-cache', amount: 3 },
]

const DEMO_COST = costRows(DEMO_USAGE, DEMO_RESOURCES, DEMO_ELAPSED)

export const demoInstances = async (): Promise<Instance[]> => [
  {
    id: '18200440edded555',
    name: 'warehouse',
    state: 'running',
    location: 'sjc01',
    created: '2026-07-29',
  },
]

/** A canned tail, so `l` demonstrates the pane without a live Worker. */
export const demoTail = (worker: string, onLine: (line: string) => void): (() => void) => {
  const canned = [
    `GET https://${worker}.workers.dev/ - Ok @ 12:04:31`,
    '  (log) handling request',
    `GET https://${worker}.workers.dev/api/health - Ok @ 12:04:33`,
  ]
  let i = 0
  const id = setInterval(() => onLine(canned[i++ % canned.length]!), 700)
  return () => clearInterval(id)
}

export const demoLoad = async (kind: Kind): Promise<Row[]> => {
  // Cost is computed, not canned: its `list` would otherwise reach the network for
  // usage, and `--demo` promises to be genuinely offline.
  const own = kind.key === 'cost' ? DEMO_COST : FIXTURE[kind.key]
  if (own) return own
  // `all` and `projects` are derived views: run their real logic over the fixture
  // by handing them this same loader, so the demo exercises the real aggregation.
  return kind.list({ token: '', accountId: '' }, demoLoad)
}
