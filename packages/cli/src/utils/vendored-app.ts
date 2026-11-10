import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { copyTemplateFile } from './copy-template'
import {
  ensureCleanGitTree,
  git,
  isVendorMode,
  subtreeAdd,
  subtreePull,
  subtreeSplitCommit,
  VENDOR_PREFIX,
} from './subtree'
import { assertStampReadable, readAppStamps, writeAppStamp } from './vendor-stamp'

/**
 * A vendored app: a whole application a project pulls as a git subtree of the
 * app's own public copy, at a prefix of its own, and keeps as files it may
 * change. It is the engine's distribution (ADR-0005) applied to an app that is
 * too large, and changes too often, to be a template copied once: `zbc add
 * <app>` runs the squashed `subtree add`, `zbc update <app>` the squashed pull,
 * and the project's own edits ride through a pull as any merge carries them.
 *
 * The app is NOT in the npm package. The CLI knows only its name, where its
 * public copy is and where it lands; everything else about it (its workspace
 * folders, the modules its deploy needs, the files a new install starts from)
 * is the app's own manifest, read from the pulled copy, so the app can change
 * those without a CLI release.
 */
export interface VendoredApp {
  name: string
  /** The app's public copy: a repository CI splits from this one, never edited directly. */
  url: string
  /** Where it lands in a project, relative to the project root. */
  prefix: string
}

export const VENDORED_APPS: Record<string, VendoredApp> = {
  space: {
    name: 'space',
    url: 'https://github.com/Zabaca/zbc-space.git',
    prefix: 'vendor/space',
  },
}

/** The app's manifest, at the root of its folder. */
export const APP_MANIFEST = 'zbc-app.json'

export interface AppManifest {
  name: string
  /** Workspace patterns, relative to the app's folder (`packages/*`). */
  workspaces?: string[]
  /** The zbc modules the app's deploy builds its instances from. */
  modules?: string[]
  /**
   * Files a new install starts from: `from` is relative to the app's folder,
   * `to` to the project root. Both may hold `{{ENV}}`; what a file's body may
   * hold is `layStarter`'s to say. Written only when absent: they are the
   * project's own from then on.
   */
  starter?: { from: string; to: string }[]
}

export async function readAppManifest(projectRoot: string, app: VendoredApp): Promise<AppManifest> {
  const file = Bun.file(path.join(projectRoot, app.prefix, APP_MANIFEST))
  if (!(await file.exists())) return { name: app.name }
  return (await file.json()) as AppManifest
}

/** `v1.4.0` as its three numbers. */
const numbers = (tag: string) => tag.slice(1).split('.').map(Number)

/**
 * The newest version tag of a repository (`v1.4.0`, read as numbers), asked of
 * the remote without fetching it. An app's tags are its own versions, not the
 * CLI's, so there is no version to compute a ref from as the engine does.
 */
export function newestTag(url: string, cwd: string = process.cwd()): string {
  const listing = git(cwd, ['ls-remote', '--tags', '--refs', url])
  const tags = listing
    .split('\n')
    .map((line) => /refs\/tags\/(v\d+\.\d+\.\d+)$/.exec(line)?.[1])
    .filter((tag): tag is string => tag !== undefined)
  if (tags.length === 0) {
    throw new Error(
      `${url} has no version tag (vX.Y.Z). Name a ref instead: --ref main pulls the newest commit.`,
    )
  }
  return tags.toSorted((a, b) => {
    const [x, y] = [numbers(a), numbers(b)]
    return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!
  })[tags.length - 1]!
}

/**
 * Add the app's workspace folders to the project's root manifest. Returns the
 * patterns it added; one already listed is left alone, so a second run adds
 * nothing.
 */
export async function addWorkspaces(
  projectRoot: string,
  app: VendoredApp,
  patterns: string[],
): Promise<string[]> {
  const file = path.join(projectRoot, 'package.json')
  const pkg = JSON.parse(await fs.readFile(file, 'utf8')) as {
    workspaces?: string[] | { packages?: string[] }
  }
  // Both spellings a root manifest may use: a list, or `{ packages: [...] }`.
  const listed = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? [])
  const wanted = patterns.map((pattern) => path.posix.join(app.prefix, pattern))
  const added = wanted.filter((pattern) => !listed.includes(pattern))
  if (added.length === 0) return []
  const next = [...listed, ...added]
  if (Array.isArray(pkg.workspaces) || pkg.workspaces === undefined) pkg.workspaces = next
  else pkg.workspaces.packages = next
  await fs.writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`)
  return added
}

/**
 * Where the things a starter file imports are, from the project root. The app's
 * glue imports the project's own zbc modules, and where those are depends on
 * how the project took the engine: a subtree project has them under
 * `vendor/zbc`, a copy-mode one under `packages/infra`.
 */
export async function starterRoots(
  projectRoot: string,
  app: VendoredApp,
): Promise<{ APP: string; MODULES: string; ENGINE: string }> {
  const vendored = await isVendorMode(projectRoot)
  return {
    APP: app.prefix,
    MODULES: vendored ? `${VENDOR_PREFIX}/modules` : 'packages/infra/modules',
    ENGINE: vendored ? `${VENDOR_PREFIX}/src` : 'packages/infra/src',
  }
}

/**
 * Write the files a new install starts from, each only when absent. Returns the
 * project-relative paths written and the ones left as they were.
 *
 * A file's body may hold `{{ENV}}`, and `{{APP}}`, `{{MODULES}}` and
 * `{{ENGINE}}`, which become the path from THAT file's folder to the app's
 * folder, the project's zbc modules and its engine, so a starter's imports are
 * right wherever the manifest puts it.
 */
export async function layStarter(
  projectRoot: string,
  app: VendoredApp,
  manifest: AppManifest,
  env: string,
): Promise<{ written: string[]; kept: string[] }> {
  const roots = await starterRoots(projectRoot, app)
  const inPath = (text: string) => text.replaceAll('{{ENV}}', env)
  const written: string[] = []
  const kept: string[] = []
  for (const entry of manifest.starter ?? []) {
    const appRoot = path.join(projectRoot, app.prefix)
    const from = path.resolve(appRoot, inPath(entry.from))
    // And it is copied from the app's own folder, never from somewhere else in the project.
    if (path.relative(appRoot, from).startsWith('..')) {
      throw new Error(
        `${app.name}'s manifest names a starter file outside its own folder: ${entry.from}`,
      )
    }
    const to = inPath(entry.to)
    // A starter path is the app's to name, and it names a place in the project:
    // one that climbs out of the project root is refused before anything is written.
    const dest = path.resolve(projectRoot, to)
    if (path.isAbsolute(to) || path.relative(projectRoot, dest).startsWith('..')) {
      throw new Error(`${app.name}'s manifest names a starter file outside the project: ${to}`)
    }
    const fromHere = (target: string) => {
      const relative = path.posix.relative(path.posix.dirname(to), target)
      return relative.startsWith('.') ? relative : `./${relative}`
    }
    const vars = {
      ENV: env,
      APP: fromHere(roots.APP),
      MODULES: fromHere(roots.MODULES),
      ENGINE: fromHere(roots.ENGINE),
    }
    const wrote = await copyTemplateFile(from, dest, { vars, skipIfExists: true })
    ;(wrote ? written : kept).push(to)
  }
  return { written, kept }
}

export interface AppAudit {
  /** Files the project tracks under the prefix that the pulled commit does not ship. */
  own: string[]
  /** Files that differ from the pulled commit: the project's edits. */
  edited: string[]
  /** Files the pulled commit ships that the project no longer has. */
  removed: string[]
}

/**
 * Compare what the project tracks under the app's prefix with the commit it
 * pulled, blob for blob. Offline and exact: a pull has just fetched that commit,
 * so git holds its tree. Null when git does not hold it (a fresh clone of the
 * project, where the squashed history keeps only the commit's id).
 */
export function auditVendoredApp(
  projectRoot: string,
  app: VendoredApp,
  commit: string,
): AppAudit | null {
  let upstreamListing: string
  try {
    upstreamListing = git(projectRoot, ['ls-tree', '-r', '-z', commit])
  } catch {
    return null
  }
  const blobs = (listing: string, strip: string) => {
    const map = new Map<string, string>()
    for (const entry of listing.split('\0')) {
      // `<mode> blob <sha>\t<path>` from ls-tree, `<mode> <sha> <stage>\t<path>` from ls-files.
      const match = /^\d+ (?:blob )?([0-9a-f]+)(?: \d)?\t(.+)$/.exec(entry)
      if (!match) continue
      map.set(path.posix.relative(strip, match[2]!), match[1]!)
    }
    return map
  }
  const upstream = blobs(upstreamListing, '')
  const local = blobs(git(projectRoot, ['ls-files', '-s', '-z', '--', app.prefix]), app.prefix)
  const own = [...local.keys()].filter((file) => !upstream.has(file)).toSorted()
  const edited = [...local.keys()]
    .filter((file) => upstream.has(file) && upstream.get(file) !== local.get(file))
    .toSorted()
  const removed = [...upstream.keys()].filter((file) => !local.has(file)).toSorted()
  return { own, edited, removed }
}

/** The audit as lines to print: information for whoever pulled, never a failure. */
export function describeAppAudit(app: VendoredApp, audit: AppAudit | null): string[] {
  if (audit === null) {
    return [
      `  (the pulled commit is not in this clone, so ${app.prefix}/ was not compared with it)`,
    ]
  }
  const lines: string[] = []
  const list = (title: string, files: string[]) => {
    if (files.length === 0) return
    lines.push(`  ${files.length} ${title}`)
    for (const file of files.slice(0, 40)) lines.push(`    ${app.prefix}/${file}`)
    if (files.length > 40) lines.push(`    ... and ${files.length - 40} more`)
  }
  list(
    `file(s) under ${app.prefix}/ are this project's own (the copy does not ship them):`,
    audit.own,
  )
  list("file(s) differ from the pulled copy (this project's edits, kept):", audit.edited)
  list('file(s) the copy ships are not in this project:', audit.removed)
  if (lines.length === 0) lines.push(`  ${app.prefix}/ is the pulled copy, file for file.`)
  return lines
}

export interface VendorResult {
  ref: string
  commit: string
  workspacesAdded: string[]
  starter: { written: string[]; kept: string[] }
  manifest: AppManifest
}

/**
 * `zbc add <app>`: the squashed subtree add at the newest tag (or the ref
 * named), then what makes the folder usable: its workspace folders in the root
 * manifest, the starting files of one environment, and the stamp. The subtree
 * add is a commit; everything after it is left in the working tree for the
 * operator to read and commit.
 */
export async function addVendoredApp(
  projectRoot: string,
  app: VendoredApp,
  opts: { ref?: string; url?: string; env: string },
): Promise<VendorResult> {
  if (await exists(path.join(projectRoot, app.prefix))) {
    throw new Error(
      `${app.prefix}/ is already there. \`zbc update ${app.name}\` pulls a newer copy over it.`,
    )
  }
  ensureCleanGitTree(projectRoot)
  await assertStampReadable(projectRoot)
  const url = opts.url ?? app.url
  const ref = opts.ref ?? newestTag(url, projectRoot)
  subtreeAdd(projectRoot, { url, ref, prefix: app.prefix })
  // The pull is a commit by now. What follows only writes files, so a failure in it leaves the app in place and
  // says so: a second `add` would refuse the folder, and an `update` never writes the starting files.
  try {
    return await finishPull(projectRoot, app, { url, ref, env: opts.env })
  } catch (err) {
    throw new Error(
      `${app.prefix}/ was pulled and committed (${ref}), but what follows the pull failed: ${(err as Error).message}\n` +
        `  To start over: git reset --hard HEAD~1 (the pull is the last commit), delete what git status then lists as new, and run \`zbc add ${app.name}\` again.`,
      { cause: err },
    )
  }
}

/**
 * `zbc update <app>`: the squashed pull of the newest tag, or of the ref named
 * (a branch for the newest commit). A conflict with the project's own edits is
 * git's, left for the operator: it is the same merge any pull is.
 */
export async function updateVendoredApp(
  projectRoot: string,
  app: VendoredApp,
  opts: { ref?: string; url?: string },
): Promise<VendorResult & { audit: AppAudit | null }> {
  if (!(await exists(path.join(projectRoot, app.prefix)))) {
    throw new Error(`${app.prefix}/ is not there. \`zbc add ${app.name}\` pulls it first.`)
  }
  ensureCleanGitTree(projectRoot)
  await assertStampReadable(projectRoot)
  // A fork pulls from where it was added from, unless told otherwise.
  const stamped = (await readAppStamps(projectRoot))[app.name]
  const url = opts.url ?? (stamped?.url || app.url)
  const ref = opts.ref ?? newestTag(url, projectRoot)
  subtreePull(projectRoot, { url, ref, prefix: app.prefix })
  const result = await finishPull(projectRoot, app, { url, ref })
  return { ...result, audit: auditVendoredApp(projectRoot, app, result.commit) }
}

async function finishPull(
  projectRoot: string,
  app: VendoredApp,
  opts: { url: string; ref: string; env?: string },
): Promise<VendorResult> {
  const commit = subtreeSplitCommit(projectRoot, app.prefix)
  if (commit === null) {
    throw new Error(`git recorded no pulled commit for ${app.prefix}/: the subtree did not land.`)
  }
  const manifest = await readAppManifest(projectRoot, app)
  const workspacesAdded = await addWorkspaces(projectRoot, app, manifest.workspaces ?? [])
  // Starting files are an `add`'s: an update never writes into an environment.
  const starter =
    opts.env === undefined
      ? { written: [], kept: [] }
      : await layStarter(projectRoot, app, manifest, opts.env)
  await writeAppStamp(projectRoot, app.name, { url: opts.url, ref: opts.ref, commit })
  return { ref: opts.ref, commit, workspacesAdded, starter, manifest }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}
