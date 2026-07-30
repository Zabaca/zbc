// Fixed rows so the UI boots with no network and no token: `c9s --demo`, and
// every test. Values are pre-rendered strings (no clock, no PRNG) so frames are
// byte-stable across runs.
import type { Kind, Row } from './resources'
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
  const own = FIXTURE[kind.key]
  if (own) return own
  // `all` and `projects` are derived views: run their real logic over the fixture
  // by handing them this same loader, so the demo exercises the real aggregation.
  return kind.list({ token: '', accountId: '' }, demoLoad)
}
