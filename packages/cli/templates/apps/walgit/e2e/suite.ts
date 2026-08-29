#!/usr/bin/env bun
/**
 * The seven-scenario verification suite.
 *
 *     bun run e2e/suite.ts               # all seven, against a local FileStore
 *     bun run e2e/suite.ts --quick       # smaller fixtures, disclosed in the output
 *     bun run e2e/suite.ts --only 2,7    # a subset, disclosed in the output
 *
 * Against a real bucket, export the store's four variables first — the suite
 * picks the store up from the environment and changes nothing else:
 *
 *     WALGIT_S3_ENDPOINT=… WALGIT_S3_BUCKET=… WALGIT_S3_ACCESS_KEY_ID=… \
 *     WALGIT_S3_SECRET_ACCESS_KEY=… bun run e2e/suite.ts
 *
 * Two rules govern the output. Every scenario says what it observed, not just
 * that it passed — a green tick over a weakened assertion is indistinguishable
 * from a green tick over a real one. And any narrowing of coverage is printed:
 * `--quick`, `--only`, an unbaselined size, a store that is not a real bucket.
 * A suite that silently ran less than it claims reads as a clean sweep, which
 * is worse than no suite at all.
 */

import { Run, type Run as RunType } from './harness'
import { SCENARIOS } from './scenarios'

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(`--${name}`)
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? null : (argv[i + 1] ?? null)
}

const quick = flag('quick')
const only = value('only')
  ?.split(',')
  .map((n) => Number(n.trim()))
const selected = only ? SCENARIOS.filter((s) => only.includes(s.n)) : SCENARIOS

interface Outcome {
  n: number
  name: string
  ok: boolean
  ms: number
  notes: string[]
  error?: string
}

const run: RunType = new Run()

// Cleanup on the way out by every route, including the ones that skip `finally`.
// A run that leaks its prefix costs storage; a run that leaks a deployed app costs
// two dollars a month forever.
let cleaned = false
const cleanup = async () => {
  if (cleaned) return
  cleaned = true
  await run.cleanup()
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void cleanup().then(() => process.exit(130))
  })
}

console.log(`walgit verification suite — run ${run.id}`)
console.log(
  `store: ${run.storeKind === 's3' ? 'S3-compatible bucket (real)' : 'FileStore on local disk'}`,
)
if (run.storeKind !== 's3') {
  console.log(
    'NOTE: not run against a real bucket. FileStore is a real store with a real ' +
      'compare-and-swap, but only a bucket exercises the network round trip and ' +
      "the provider's own conditional-write semantics. Set WALGIT_S3_* to do that.",
  )
}
if (quick)
  console.log('NOTE: --quick — several scenarios use smaller fixtures than the design specifies.')
if (only)
  console.log(
    `NOTE: --only ${only.join(',')} — ${SCENARIOS.length - selected.length} scenario(s) NOT run.`,
  )
console.log('')

const outcomes: Outcome[] = []
try {
  for (const scenario of selected) {
    const startedAt = performance.now()
    process.stdout.write(`[${scenario.n}/7] ${scenario.name}\n`)
    try {
      const notes = await scenario.run(run, { quick })
      const ms = Math.round(performance.now() - startedAt)
      outcomes.push({ n: scenario.n, name: scenario.name, ok: true, ms, notes })
      for (const note of notes) console.log(`      · ${note}`)
      console.log(`      PASS (${ms}ms)\n`)
    } catch (err) {
      const ms = Math.round(performance.now() - startedAt)
      const error = err instanceof Error ? (err.stack ?? err.message) : String(err)
      outcomes.push({ n: scenario.n, name: scenario.name, ok: false, ms, notes: [], error })
      console.log(`      FAIL (${ms}ms)\n${indent(error)}\n`)
    }
  }
} finally {
  await cleanup()
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n')
}

const failed = outcomes.filter((o) => !o.ok)
console.log('─'.repeat(72))
for (const o of outcomes) console.log(`${o.ok ? 'PASS' : 'FAIL'}  ${o.n}. ${o.name} (${o.ms}ms)`)
console.log(
  `${outcomes.length - failed.length}/${SCENARIOS.length} scenarios passed` +
    (selected.length < SCENARIOS.length ? ` (${SCENARIOS.length - selected.length} not run)` : ''),
)

if (process.env.WALGIT_E2E_JSON) {
  await Bun.write(
    process.env.WALGIT_E2E_JSON,
    JSON.stringify({ run: run.id, store: run.storeKind, quick, outcomes }, null, 2),
  )
}

// 1 = something is broken. 2 = nothing broke but the suite ran less than the
// full seven, which must not be readable as a clean sweep by a script either.
if (failed.length > 0) process.exit(1)
if (selected.length < SCENARIOS.length) {
  console.log('PARTIAL RUN — exiting 2 so this cannot be mistaken for a full pass.')
  process.exit(2)
}
process.exit(0)
