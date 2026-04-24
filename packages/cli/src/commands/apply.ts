import * as path from 'node:path'
import { defineCommand } from 'citty'
import { findProjectRoot } from '../utils/find-project-root'
import { loadConfig } from '../utils/load-config'
import { applyEnvironment } from '../engine/apply'

export const applyCommand = defineCommand({
  meta: {
    name: 'apply',
    description: 'Apply infrastructure for an environment',
  },
  args: {
    env: {
      type: 'positional',
      description: 'Environment name (e.g., production, preview)',
      required: true,
    },
    instance: {
      type: 'positional',
      description: 'Specific instance to apply (+ its dependencies)',
      required: false,
    },
  },
  async run({ args }) {
    const projectRoot = await findProjectRoot()
    const config = await loadConfig(projectRoot)

    if (!config.environments.includes(args.env)) {
      console.error(
        `Unknown environment: "${args.env}". Available: ${config.environments.join(', ')}`,
      )
      process.exit(1)
    }

    const envDir = path.join(
      projectRoot,
      'packages',
      'infra',
      'environments',
      args.env,
    )

    console.log(`Applying ${args.env}${args.instance ? ` (instance: ${args.instance})` : ''}...`)
    await applyEnvironment(projectRoot, envDir, args.instance)
    console.log('\nDone.')
  },
})
