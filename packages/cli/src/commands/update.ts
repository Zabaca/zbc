import * as path from 'node:path'
import { defineCommand } from 'citty'
import { findProjectRoot } from '../utils/find-project-root'
import { refreshCopiedTemplates } from '../utils/copy-refresh'
import { describeForeignFiles, foreignVendorFiles } from '../utils/vendor-audit'
import { STAMP_FILE } from '../utils/vendor-stamp'
import { engineIsLinked, readStamp, writeStamp } from '../utils/vendor-stamp'
import {
  coreRefForVersion,
  DEFAULT_CORE_URL,
  ensureCleanGitTree,
  gitPrefix,
  gitTopLevel,
  isVendorMode,
  subtreePull,
  VENDOR_PREFIX,
} from '../utils/subtree'
import { describeAppAudit, updateVendoredApp, VENDORED_APPS } from '../utils/vendored-app'
import pkg from '../../package.json' with { type: 'json' }

export const updateCommand = defineCommand({
  meta: {
    name: 'update',
    description: `Bring the vendored zbc engine + built-in modules up to this CLI's version`,
  },
  args: {
    app: {
      type: 'positional',
      description: `A vendored app to update instead of the engine (${Object.keys(VENDORED_APPS).join(', ')})`,
      required: false,
    },
    ref: {
      type: 'string',
      description:
        'With an app: the ref to pull (default: the newest version tag; a branch pulls the newest commit)',
    },
    'app-url': {
      type: 'string',
      description: 'With an app: pull from this repository instead (a fork)',
    },
    'core-url': {
      type: 'string',
      description: `zbc-core repository (default: ${DEFAULT_CORE_URL})`,
    },
    'core-ref': {
      type: 'string',
      description: 'zbc-core ref to pull (default: the tag matching this CLI version)',
    },
    strict: {
      type: 'boolean',
      description: `Exit non-zero if ${VENDOR_PREFIX}/ holds files zbc-core does not ship`,
      default: false,
    },
  },
  async run({ args }) {
    const projectRoot = await findProjectRoot()

    // A vendored app is updated by name, and only it: the engine's vintage is a
    // separate pull of a separate repository, on its own versions.
    if (args.app !== undefined) {
      const app = VENDORED_APPS[args.app]
      if (!app) {
        console.error(
          `✗ "${args.app}" is not a vendored app. Available: ${Object.keys(VENDORED_APPS).join(', ')}. Run \`zbc update\` alone for the engine and modules.`,
        )
        process.exit(1)
      }
      console.log(`zbc update: ${app.name} → ${app.prefix}`)
      let result: Awaited<ReturnType<typeof updateVendoredApp>>
      try {
        result = await updateVendoredApp(projectRoot, app, { ref: args.ref, url: args['app-url'] })
      } catch (err) {
        console.error(`✗ ${(err as Error).message}`)
        process.exit(1)
      }
      console.log(`✓ ${app.prefix} is on ${result.ref} (${result.commit.slice(0, 12)})`)
      for (const pattern of result.workspacesAdded) console.log(`  workspace added: ${pattern}`)
      for (const line of describeAppAudit(app, result.audit)) console.log(line)
      console.log(
        '  Review the squash merge commit, commit .zbc-vendor.json, and run `bun install`.',
      )
      return
    }

    // Copy mode used to be a dead end here — the only way to receive an engine
    // fix was a hand diff, which is how consumers ended up reimplementing what
    // we ship. The CLI carries the templates, so it can re-lay them in place.
    const stamp = await readStamp(projectRoot)
    // The subtree prefix as git sees it: `vendor/zbc` at the top level,
    // `deploy/zbc/vendor/zbc` for a project in a subfolder. Always derived; the
    // stamp's copy is information, and a stale one is said and then ignored.
    const prefix = gitPrefix(projectRoot)
    const recordedPrefix = stamp?.mode === 'subtree' ? (stamp.prefix ?? VENDOR_PREFIX) : prefix
    if (recordedPrefix !== prefix) {
      console.warn(
        `⚠ ${STAMP_FILE} records the subtree at ${recordedPrefix}/, but this project's is ${prefix}/ (the folder moved?) — using ${prefix}/.`,
      )
    }

    if (!(await isVendorMode(projectRoot))) {
      // A stamp saying `subtree` with no engine under the prefix is the varnick
      // failure itself: the vendoring did not land. Refreshing copied templates
      // would repair nothing (subtree init copies no engine) and would erase the
      // record that this is a subtree project — so say what is wrong instead.
      if (stamp?.mode === 'subtree') {
        console.error(
          `✗ ${STAMP_FILE} says this project vendors zbc as a subtree, but ${prefix}/src is missing — the subtree never landed, or was removed.`,
        )
        // git subtree runs only at the top level; say how to get there from here.
        const top = gitTopLevel(projectRoot)
        const fromTop =
          top === null || prefix === VENDOR_PREFIX
            ? ''
            : `-C ${path.relative(process.cwd(), top) || '.'} `
        console.error(
          `  Re-vendor it: git ${fromTop}subtree add --prefix=${prefix} ${DEFAULT_CORE_URL} ${stamp.coreRef ?? coreRefForVersion(pkg.version)} --squash`,
        )
        process.exit(1)
      }

      // The zbc repo itself consumes its own templates through symlinks: there
      // is nothing vendored to refresh, and nothing to stamp.
      if (await engineIsLinked(projectRoot)) {
        console.log(
          'zbc update: packages/infra/src is a symlink into the templates — this project develops zbc itself, nothing to refresh.',
        )
        return
      }
      console.log(`zbc update: copy mode — refreshing bundled templates from zbc v${pkg.version}`)
      // The refresh overwrites and deletes; without this an uncommitted engine
      // edit is gone with no way back. The subtree path gets this from git.
      try {
        ensureCleanGitTree(projectRoot)
      } catch (err) {
        console.error(`✗ ${(err as Error).message}`)
        process.exit(1)
      }
      const result = await refreshCopiedTemplates(projectRoot)
      for (const skip of result.skipped) console.log(`  skip ${skip.path} (${skip.reason})`)
      for (const gone of result.removed) console.log(`  remove ${gone} (no longer shipped)`)
      if (result.refreshed.length === 0) {
        console.log('  nothing to refresh (no copied engine or built-in modules found)')
      }
      const missing = Object.entries(result.missingDependencies)
      if (missing.length > 0) {
        console.log('')
        console.log('  Refreshed modules declare dependencies this project does not have:')
        console.log(
          `    cd packages/infra && bun add ${missing.map(([n, v]) => `${n}@${v}`).join(' ')}`,
        )
      }
      await writeStamp(projectRoot, { mode: 'copy', cliVersion: pkg.version })
      console.log(
        `✓ refreshed ${result.refreshed.length} path(s) — review the diff before committing.`,
      )
      console.log(
        `  Copy mode still receives nothing automatically: \`zbc init --subtree\` vendors ${VENDOR_PREFIX}/ with upstream history so updates flow.`,
      )
      return
    }

    const url = args['core-url'] ?? DEFAULT_CORE_URL
    const ref = args['core-ref'] ?? coreRefForVersion(pkg.version)
    console.log(`zbc update: ${url} @ ${ref} → ${prefix}`)
    try {
      subtreePull(projectRoot, { url, ref })
    } catch (err) {
      console.error(`✗ ${(err as Error).message}`)
      process.exit(1)
    }
    await writeStamp(projectRoot, {
      mode: 'subtree',
      cliVersion: pkg.version,
      coreRef: ref,
      prefix,
    })
    console.log(`✓ ${prefix} updated — review the squash merge commit and push`)

    // The push direction nobody watches: files written inside the prefix.
    const foreign = await foreignVendorFiles(projectRoot)
    for (const line of describeForeignFiles(foreign, prefix)) console.warn(line)
    if (args.strict && foreign.length > 0) process.exit(1)
  },
})
