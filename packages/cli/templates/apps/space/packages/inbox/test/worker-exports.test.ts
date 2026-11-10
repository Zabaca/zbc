import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * The dev seed, the stand-in Google, the stand-in push service and the dev routes are for `vite dev` only. They reach the Worker
 * through ONE import (`./dev`, plus a dynamic one inside a method) and each use sits under the build-time
 * constant `import.meta.env.DEV`, which is false in everything `vite build` produces, so none of it is in
 * the deployed bundle (checked by hand against `dist/` too: no seed text in it). Crude: it reads
 * durable.ts and checks that no use of `./dev` is outside a DEV guard.
 */
test('src/durable.ts uses ./dev only under import.meta.env.DEV', () => {
  const lines = readFileSync(new URL('../src/durable.ts', import.meta.url), 'utf8').split('\n')
  const uses = lines.flatMap((line, n) =>
    /DEV_GOOGLE|DEV_PUSH|from '\.\/dev'|import\('\.\/dev'\)/.test(line) ? [n] : [],
  )
  expect(uses.length).toBeGreaterThan(0)
  for (const n of uses) {
    const line = lines[n] as string
    // The static import is the one line that is not itself guarded: it is dropped with its only use.
    if (/^import .* from '\.\/dev'/.test(line)) continue
    // A use is guarded on its own line, or by the guard in the few lines above it.
    const near = lines.slice(Math.max(0, n - 6), n + 1).join('\n')
    expect(near, `line ${n + 1}: ${line.trim()}`).toContain('import.meta.env.DEV')
  }
})

/**
 * The Durable Object class is src/durable.ts, built into the space's Worker (which owns the store since the transfer; the Worker that gave it is deleted): the file exports the class and the typed
 * face of its `call`, never a string constant (the space's entry module re-exports `InboxDO` and nothing else of it; packages/space/test/worker-exports.test.ts holds that line). Its methods are the ones the runtime and the operator reach: `call` (the store's one way in), the
 * operator's three (`bookmark`, `counts`, `restart`), the dev seed's two, the alarm and the overridable knowledge port.
 */
test('src/durable.ts defines the Durable Object class with exactly these methods', () => {
  const source = readFileSync(new URL('../src/durable.ts', import.meta.url), 'utf8')
  const start = source.indexOf('export class InboxDO ')
  const body = source.slice(start, source.indexOf('\n}\n', start))
  const methods = [
    ...body.matchAll(/^ {2}(?:override |protected |async |static |get |set )*([A-Za-z_$#][\w$]*)\(/gm),
  ].map((m) => m[1])
  expect(methods.sort()).toEqual([
    'alarm',
    'bookmark',
    'call',
    'constructor',
    'counts',
    'devArrive',
    'devSeed',
    'knowledgePort',
    'restart',
  ])
})
