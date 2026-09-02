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
    only: {
      type: 'string',
      description: 'Comma-separated instances to apply (+ their dependencies)',
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

    // `--only a,b` is the positional's plural. Empty entries are dropped so a
    // trailing comma — the shape a shell loop produces when its list is empty —
    // does not become an instance named "", which would fail as "not found"
    // and read as a bug in the environment rather than in the caller.
    const only = (args.only ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0)

    if (args.instance && only.length > 0) {
      console.error('Pass either an instance positional or --only, not both.')
      process.exit(1)
    }

    // An `--only` that was given but resolved to nothing is a caller that meant
    // to scope and produced an empty list. Applying the whole environment there
    // is the opposite of what it asked for, so refuse rather than widen.
    if (args.only !== undefined && only.length === 0) {
      console.error('--only was given but named no instances.')
      process.exit(1)
    }

    const target = args.instance ?? (only.length > 0 ? only : undefined)

    const envDir = path.join(projectRoot, 'packages', 'infra', 'environments', args.env)

    const scope = target ? ` (instance: ${[target].flat().join(', ')})` : ''
    console.log(`Applying ${args.env}${scope}...`)
    await applyEnvironment(projectRoot, envDir, target)
    console.log('\nDone.')
  },
})
