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

/** Files git actually tracks — an untracked scratch file can't ride a push. */
const IGNORED_BASENAMES = new Set(['.DS_Store'])

async function walk(root: string, base = ''): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(path.join(root, base), { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry.name === '.git' || IGNORED_BASENAMES.has(entry.name)) continue
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await walk(root, rel)))
    else out.push(rel)
  }
  return out
}

/**
 * Paths (relative to VENDOR_PREFIX) that upstream does not ship at that path.
 * Test files are excluded from the comparison: the published core drops them,
 * so their absence upstream is not consumer authorship.
 */
export async function foreignVendorFiles(projectRoot: string): Promise<string[]> {
  const prefixDir = path.join(projectRoot, VENDOR_PREFIX)
  const upstreamDir = path.join(templatesRoot(), 'infra')
  const upstream = new Set(await walk(upstreamDir))
  const vendored = await walk(prefixDir)
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
