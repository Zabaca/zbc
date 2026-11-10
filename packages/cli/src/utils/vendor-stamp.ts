import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { VENDOR_PREFIX } from './subtree'

/**
 * The vintage stamp: what engine a project is actually running, recorded where
 * a `git subtree push` can never carry it upstream.
 *
 * Three consumers reimplemented engine features they already had, because
 * nothing in the project said which engine it was on — varnick's `git subtree
 * add` failed quietly enough that the only visible consequence was a
 * hand-rolled `ctx.output`. The stamp is written by `zbc init` and refreshed by
 * `zbc update`; `zbc apply` reads it and says when the vintage has drifted from
 * the CLI running the apply.
 *
 * It lives at the PROJECT ROOT, deliberately: a file inside `vendor/zbc/` is
 * exactly the consumer-authored-file-in-the-prefix hazard this closes.
 */

/** Project-root-relative. Never inside VENDOR_PREFIX — see the note above. */
export const STAMP_FILE = '.zbc-vendor.json'

export interface VendorStamp {
  /** How the engine got here: a git subtree of zbc-core, or copied templates. */
  mode: 'subtree' | 'copy'
  /** CLI version that vendored it. */
  cliVersion: string
  /** zbc-core ref pulled, for subtree mode. */
  coreRef?: string
  /** ISO timestamp of the vendoring. */
  vendoredAt: string
}

export function stampPath(projectRoot: string): string {
  return path.join(projectRoot, STAMP_FILE)
}

/** Read the stamp. A missing or unparseable stamp is "unknown", not an error. */
export async function readStamp(projectRoot: string): Promise<VendorStamp | null> {
  const file = Bun.file(stampPath(projectRoot))
  if (!(await file.exists())) return null
  try {
    const raw = (await file.json()) as Partial<VendorStamp>
    if (raw.mode !== 'subtree' && raw.mode !== 'copy') return null
    if (typeof raw.cliVersion !== 'string') return null
    return {
      mode: raw.mode,
      cliVersion: raw.cliVersion,
      coreRef: typeof raw.coreRef === 'string' ? raw.coreRef : undefined,
      vendoredAt: typeof raw.vendoredAt === 'string' ? raw.vendoredAt : '',
    }
  } catch {
    return null
  }
}

export async function writeStamp(
  projectRoot: string,
  stamp: Omit<VendorStamp, 'vendoredAt'> & { vendoredAt?: string },
): Promise<void> {
  const body: VendorStamp = {
    mode: stamp.mode,
    cliVersion: stamp.cliVersion,
    ...(stamp.coreRef ? { coreRef: stamp.coreRef } : {}),
    vendoredAt: stamp.vendoredAt ?? new Date().toISOString(),
  }
  // The engine's stamp and the vendored apps' share the file, and each writer
  // owns only its half: an `update` of the engine must not forget which apps
  // the project pulled.
  const apps = await readAppStamps(projectRoot)
  const whole = Object.keys(apps).length > 0 ? { ...body, apps } : body
  await Bun.write(stampPath(projectRoot), `${JSON.stringify(whole, null, 2)}\n`)
}

/**
 * What one vendored app is on: an app (`space`) is pulled as a subtree of its
 * own public copy at its own prefix, on its own versions, so it has a vintage
 * the engine's stamp cannot say. `commit` is the upstream commit, which is what
 * tells a tag pull from a pull of the newest commit and what a survey compares
 * a consumer's files against.
 */
export interface AppStamp {
  /** The repository pulled from. */
  url: string
  /** The ref asked for: a tag, or a branch for the newest commit. */
  ref: string
  /** The upstream commit that ref resolved to. */
  commit: string
  /** ISO timestamp of the pull. */
  vendoredAt: string
}

/** Every vendored app's stamp, by app name. A missing or unreadable file is none. */
export async function readAppStamps(projectRoot: string): Promise<Record<string, AppStamp>> {
  const file = Bun.file(stampPath(projectRoot))
  if (!(await file.exists())) return {}
  try {
    const raw = (await file.json()) as { apps?: Record<string, Partial<AppStamp>> }
    const out: Record<string, AppStamp> = {}
    for (const [name, app] of Object.entries(raw.apps ?? {})) {
      if (typeof app?.ref !== 'string' || typeof app.commit !== 'string') continue
      out[name] = {
        url: typeof app.url === 'string' ? app.url : '',
        ref: app.ref,
        commit: app.commit,
        vendoredAt: typeof app.vendoredAt === 'string' ? app.vendoredAt : '',
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Refuse a stamp file that is there and cannot be read, BEFORE a pull: found after it, the pull is already a commit
 * and the project is left half way. A missing file is fine; it is written whole.
 */
export async function assertStampReadable(projectRoot: string): Promise<void> {
  const file = Bun.file(stampPath(projectRoot))
  if (!(await file.exists())) return
  try {
    await file.json()
  } catch {
    throw new Error(`${STAMP_FILE} is not valid JSON; fix or delete it, then run the command again`)
  }
}

/**
 * Record one app's pull, leaving the engine's stamp and the other apps' as they
 * are. A project with no engine stamp gets a file holding only `apps`, which
 * `readStamp` reads as "unknown", exactly as it read the missing file.
 */
export async function writeAppStamp(
  projectRoot: string,
  name: string,
  stamp: Omit<AppStamp, 'vendoredAt'> & { vendoredAt?: string },
): Promise<void> {
  const file = Bun.file(stampPath(projectRoot))
  let whole: Record<string, unknown> = {}
  if (await file.exists()) {
    try {
      whole = (await file.json()) as Record<string, unknown>
    } catch {
      // Writing over a file that cannot be read would drop the engine's half of it without a word.
      throw new Error(
        `${STAMP_FILE} is not valid JSON; fix or delete it, then run the command again`,
      )
    }
  }
  const apps = await readAppStamps(projectRoot)
  apps[name] = {
    url: stamp.url,
    ref: stamp.ref,
    commit: stamp.commit,
    vendoredAt: stamp.vendoredAt ?? new Date().toISOString(),
  }
  await Bun.write(stampPath(projectRoot), `${JSON.stringify({ ...whole, apps }, null, 2)}\n`)
}

function parseVersion(v: string): number[] {
  return v.split('.').map((part) => Number.parseInt(part, 10) || 0)
}

/** -1 / 0 / 1 on dotted numeric versions; non-numeric parts compare as 0. */
function compareVersions(a: string, b: string): number {
  const [av, bv] = [parseVersion(a), parseVersion(b)]
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

export interface Vintage {
  /** The vendored engine is not the one this CLI ships (or is unknown). */
  stale: boolean
  /** Lines to print, in order. Empty means nothing to say. */
  warnings: string[]
}

/**
 * What a project's distribution mode + stamp mean, given the CLI running now.
 * Pure — the command layer only prints what this returns. Never fatal: an old
 * engine is a warning, not a refusal to apply.
 */
export function vendorVintage(input: {
  /** vendor/zbc/src present → subtree (or a hand-copied stand-in for one). */
  vendorMode: boolean
  cliVersion: string
  stamp: VendorStamp | null
  /**
   * packages/infra/src is a symlink — the zbc repo itself, which develops the
   * templates in place. It has no vintage to drift from.
   */
  engineIsLinked?: boolean
}): Vintage {
  const { vendorMode, cliVersion, stamp } = input

  if (input.engineIsLinked) return { stale: false, warnings: [] }

  // A stamp that says subtree with no engine under the prefix is the failure
  // this whole surface exists for: the vendoring did not land. Telling that
  // project to "try --subtree" is the misdiagnosis, so name the prefix instead.
  if (!vendorMode && stamp?.mode === 'subtree') {
    return {
      stale: true,
      warnings: [
        `⚠ ${STAMP_FILE} says this project vendors zbc at ${VENDOR_PREFIX}/, but no engine is there — the subtree never landed, or was removed.`,
        '  Run `zbc update` for the exact re-vendoring command.',
      ],
    }
  }

  if (!vendorMode) {
    // Copy mode is loudly temporary: template changes never flow into it, which
    // is how three consumers ended up reimplementing shipped engine features.
    const at = stamp ? ` (vendored by zbc v${stamp.cliVersion})` : ''
    return {
      stale: stamp === null || compareVersions(stamp.cliVersion, cliVersion) !== 0,
      warnings: [
        `⚠ copy mode${at}: upstream engine changes do not flow into this project.`,
        '  `zbc update` refreshes the copied engine + built-in modules in place; `zbc init --subtree` makes updates flow with history.',
      ],
    }
  }

  if (!stamp) {
    return {
      stale: true,
      warnings: [
        `⚠ ${VENDOR_PREFIX}/ vintage is unknown — no ${STAMP_FILE} records what was vendored (zbc v${cliVersion} is running).`,
        '  Run `zbc update` to pull the matching zbc-core and record it.',
      ],
    }
  }

  // Exact string match is the only "current": 0.15.0 and 0.15.0-rc.1 compare
  // equal numerically but are different engines.
  if (stamp.cliVersion === cliVersion) return { stale: false, warnings: [] }

  const cmp = compareVersions(stamp.cliVersion, cliVersion)

  const ref = stamp.coreRef ?? `zbc-core-v${stamp.cliVersion}`
  if (cmp <= 0) {
    return {
      stale: true,
      warnings: [
        `⚠ ${VENDOR_PREFIX}/ is on ${ref}, but zbc v${cliVersion} is running — the vendored engine is behind.`,
        `  Run \`zbc update\` to pull zbc-core-v${cliVersion}.`,
      ],
    }
  }
  return {
    stale: true,
    warnings: [
      `⚠ ${VENDOR_PREFIX}/ is on ${ref}, newer than the zbc v${cliVersion} running this apply — upgrade the CLI (\`bun add -g @zabaca/zbc\`).`,
    ],
  }
}

/**
 * True when packages/infra/src is a symlink: the zbc repo consuming its own
 * templates in place. Nothing was vendored, so there is no vintage to report.
 */
export async function engineIsLinked(projectRoot: string): Promise<boolean> {
  try {
    return (await fs.lstat(path.join(projectRoot, 'packages/infra/src'))).isSymbolicLink()
  } catch {
    return false
  }
}
