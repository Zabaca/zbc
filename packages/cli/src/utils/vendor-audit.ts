import { spawnSync } from 'node:child_process'
import type { Dirent } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { templatesRoot } from './copy-template'
import { VENDOR_PREFIX } from './subtree'

/**
 * The reverse drift hazard: files a consumer wrote *inside* `vendor/zbc/`.
 * The prefix is upstream's, and `git subtree push` sends everything under it —
 * three surveyed consumers each carry their own `vendor/zbc/VENDORING.md`,
 * which a push would deliver into zbc-core.
 *
 * The audit is offline: what upstream ships is the template tree this CLI is
 * built from, so anything under the prefix without a counterpart there is
 * consumer-authored (or belongs to a different zbc-core vintage — hence a
 * warning by default, and a hard failure only under --strict).
 */

/**
 * Files git tracks under the prefix, relative to it. Only a tracked file can
 * ride a `subtree push`; node_modules, build output and editor scratch under
 * vendor/zbc cannot, and must not be reported as consumer-authored.
 */
function trackedVendorFiles(projectRoot: string): string[] {
  const res = spawnSync('git', ['ls-files', '-z', '--', VENDOR_PREFIX], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
  if (res.status !== 0 || res.error) return []
  return res.stdout
    .split('\0')
    .filter((line) => line.length > 0)
    .map((line) => path.posix.relative(VENDOR_PREFIX, line))
}

async function walk(root: string, base = ''): Promise<string[]> {
  // `Dirent[]`, not `Awaited<ReturnType<typeof fs.readdir>>`: `readdir` is
  // overloaded, and `ReturnType` resolves to the LAST overload — the
  // `encoding: 'buffer'` one — so that spelling types `entry.name` as a Buffer
  // and every use of it as a string fails.
  let entries: Dirent[]
  try {
    entries = await fs.readdir(path.join(root, base), { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry.name === '.git') continue
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await walk(root, rel)))
    else out.push(rel)
  }
  return out
}

export async function foreignVendorFiles(projectRoot: string): Promise<string[]> {
  const upstreamDir = path.join(templatesRoot(), 'infra')
  const upstream = new Set(await walk(upstreamDir))
  const vendored = trackedVendorFiles(projectRoot)
  return vendored.filter((rel) => !rel.endsWith('.test.ts') && !upstream.has(rel)).toSorted()
}

export function describeForeignFiles(files: string[]): string[] {
  if (files.length === 0) return []
  return [
    `⚠ ${files.length} file(s) under ${VENDOR_PREFIX}/ are not shipped by zbc-core at that path:`,
    ...files.map((f) => `    ${VENDOR_PREFIX}/${f}`),
    `  ${VENDOR_PREFIX}/ is upstream's — \`git subtree push\` would carry these into zbc-core. Move consumer-authored files outside the prefix (e.g. docs/ or packages/infra/).`,
  ]
}
