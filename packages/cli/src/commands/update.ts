import { defineCommand } from 'citty'
import { findProjectRoot } from '../utils/find-project-root'
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
    description: `Pull a newer zbc-core into ${VENDOR_PREFIX} (subtree projects only)`,
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
  },
  async run({ args }) {
    const projectRoot = await findProjectRoot()

    if (!(await isVendorMode(projectRoot))) {
      console.error(
        `✗ ${VENDOR_PREFIX}/ not found — this project doesn't consume zbc as a subtree. (Copy-mode projects re-vendor modules with \`zbc add\`.)`,
      )
      process.exit(1)
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
    console.log('✓ vendor/zbc updated — review the squash merge commit and push')
  },
})
