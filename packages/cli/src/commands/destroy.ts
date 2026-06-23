import * as path from 'node:path'
import { defineCommand } from 'citty'
import { findProjectRoot } from '../utils/find-project-root'
import { loadConfig } from '../utils/load-config'
import { destroyEnvironment } from '../engine/destroy'

export const destroyCommand = defineCommand({
  meta: {
    name: 'destroy',
    description: 'Tear down ephemeral resources for an environment',
  },
  args: {
    env: {
      type: 'positional',
      description: 'Environment name (e.g., preview)',
      required: true,
    },
    instance: {
      type: 'positional',
      description: 'Specific instance to destroy (omit to destroy the whole environment)',
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

    const envDir = path.join(projectRoot, 'packages', 'infra', 'environments', args.env)

    console.log(`Destroying ${args.env}${args.instance ? ` (instance: ${args.instance})` : ''}...`)
    await destroyEnvironment(projectRoot, envDir, args.instance)
    console.log('\nDone.')
  },
})
