import { defineCommand } from 'citty'
import { findProjectRoot } from '../utils/find-project-root'
import { refreshCopiedTemplates } from '../utils/copy-refresh'
import { describeForeignFiles, foreignVendorFiles } from '../utils/vendor-audit'
import { engineIsLinked, writeStamp } from '../utils/vendor-stamp'
import {
  coreRefForVersion,
  DEFAULT_CORE_URL,
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
    if (!(await isVendorMode(projectRoot))) {
      // The zbc repo itself consumes its own templates through symlinks: there
      // is nothing vendored to refresh, and nothing to stamp.
      if (await engineIsLinked(projectRoot)) {
        console.log(
          'zbc update: packages/infra/src is a symlink into the templates — this project develops zbc itself, nothing to refresh.',
        )
        return
      }
      console.log(`zbc update: copy mode — refreshing bundled templates from zbc v${pkg.version}`)
      const result = await refreshCopiedTemplates(projectRoot)
      for (const skip of result.skipped) console.log(`  skip ${skip.path} (${skip.reason})`)
      if (result.refreshed.length === 0) {
        console.log('  nothing to refresh (no copied engine or built-in modules found)')
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
