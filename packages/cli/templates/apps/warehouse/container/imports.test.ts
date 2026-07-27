// A structural guard, not a behavioural test.
//
// container/ runs as a plain Bun process inside the warehouse image; worker/ runs in
// workerd. worker/index.ts statically imports '@cloudflare/sandbox', and merely LOADING
// that package outside workerd crashes the Bun process outright (a Bus error, not a
// catchable exception). So a container→worker import is a runtime landmine: the image still
// builds, `bun test` still passes if nothing exercises that path, and the failure only
// appears when the materialize run actually executes in production.
//
// It also used to be a packaging landmine: the Dockerfile cherry-picked exactly two files
// out of worker/, so a third such import would be missing from the image entirely and die
// with "Cannot find module" — which is precisely how this template's first deploy failed.
//
// Cross-runtime code belongs in shared/ (compiled by BOTH tsconfigs, copied wholesale into
// the image). This test fails the moment anything under container/ reaches into worker/.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const CONTAINER_DIR = import.meta.dir

describe('container/ module boundary', () => {
  test('nothing under container/ imports from worker/', () => {
    const offenders: string[] = []

    for (const entry of readdirSync(CONTAINER_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
      const source = readFileSync(join(CONTAINER_DIR, entry.name), 'utf8')
      // Match real import/export-from specifiers only, so a prose mention of "worker/" in a
      // comment doesn't trip the guard.
      const specifiers = source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)
      for (const [, specifier] of specifiers) {
        if (specifier?.includes('worker/')) offenders.push(`${entry.name} -> ${specifier}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
