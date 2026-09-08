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
  isVendorMode,
  subtreePull,
  VENDOR_PREFIX,
} from '../utils/subtree'
import pkg from '../../package.json' with { type: 'json' }

export const updateCommand = defineCommand({
  meta: {
    name: 'update',
    description: `Bring the vendored zbc engine + built-in modules up to this CLI's version`,
  },
  args: {
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

    // Copy mode used to be a dead end here — the only way to receive an engine
    // fix was a hand diff, which is how consumers ended up reimplementing what
    // we ship. The CLI carries the templates, so it can re-lay them in place.
    const stamp = await readStamp(projectRoot)

    if (!(await isVendorMode(projectRoot))) {
      // A stamp saying `subtree` with no engine under the prefix is the varnick
      // failure itself: the vendoring did not land. Refreshing copied templates
      // would repair nothing (subtree init copies no engine) and would erase the
      // record that this is a subtree project — so say what is wrong instead.
      if (stamp?.mode === 'subtree') {
        console.error(
          `✗ ${STAMP_FILE} says this project vendors zbc as a subtree, but ${VENDOR_PREFIX}/src is missing — the subtree never landed, or was removed.`,
        )
        console.error(
          `  Re-vendor it: git subtree add --prefix=${VENDOR_PREFIX} ${DEFAULT_CORE_URL} ${stamp.coreRef ?? coreRefForVersion(pkg.version)} --squash`,
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
    console.log(`zbc update: ${url} @ ${ref} → ${VENDOR_PREFIX}`)
    try {
      subtreePull(projectRoot, { url, ref })
    } catch (err) {
      console.error(`✗ ${(err as Error).message}`)
      process.exit(1)
    }
    await writeStamp(projectRoot, { mode: 'subtree', cliVersion: pkg.version, coreRef: ref })
    console.log('✓ vendor/zbc updated — review the squash merge commit and push')

    // The push direction nobody watches: files written inside the prefix.
    const foreign = await foreignVendorFiles(projectRoot)
    for (const line of describeForeignFiles(foreign)) console.warn(line)
    if (args.strict && foreign.length > 0) process.exit(1)
  },
})
