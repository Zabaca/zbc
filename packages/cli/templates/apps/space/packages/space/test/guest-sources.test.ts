// What the guest pages draw (the space's ADR 0018). A guest page is served on the team's origin, so what keeps a signed-in person's browser safe
// from a guest page is that no outsider's words ever become markup or script in it. The content policy refuses inline and evaluated script (test/guests.test.ts); this holds the other half, at the source of the two
// bundles: they draw text, and nothing in them turns a string into HTML or code.
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))
const FORBIDDEN = /dangerouslySetInnerHTML|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\s*\(|setTimeout\s*\(\s*['"`]|setInterval\s*\(\s*['"`]/

describe('the guest bundles’ sources', () => {
  for (const [name, dir] of [['meet’s page', '../../meet/src/web'], ['forms’ signer page', '../../forms/src/public']] as const) {
    test(`${name} turns no string into markup or code`, () => {
      const root = fileURLToPath(new URL(dir, import.meta.url))
      const files = walk(root).filter((f) => /\.(ts|tsx)$/.test(f))
      expect(files.length).toBeGreaterThan(5)
      const offenders = files.filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')))
      expect(offenders).toEqual([])
    })
  }
})
