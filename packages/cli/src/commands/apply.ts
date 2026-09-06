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
    json: {
      type: 'string',
      description:
        'Write the apply result (instance outputs) as JSON to this path. Treat the file as secret: outputs carry credentials.',
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

    // A path, not a flag on stdout: modules run child processes with inherited
    // stdio (the cloudflare and fly build steps), so stdout is not a channel
    // this CLI controls and could never be promised to hold only JSON.
    if (args.json !== undefined && (typeof args.json !== 'string' || args.json.length === 0)) {
      console.error('--json needs a path to write the result document to.')
      process.exit(1)
    }

    const scope = target ? ` (instance: ${[target].flat().join(', ')})` : ''
    console.log(`Applying ${args.env}${scope}...`)
    const result = await applyEnvironment(projectRoot, envDir, target)

    if (args.json) {
      // Written only once the apply has finished: a document listing half an
      // environment reads exactly like one listing all of it.
      const jsonPath = path.resolve(process.cwd(), args.json)
      const document = { env: args.env, instances: result.instances }
      try {
        await Bun.write(jsonPath, `${JSON.stringify(document, null, 2)}\n`)
      } catch (err) {
        // The apply already happened. Saying so is the difference between "the
        // deploy failed" and "the deploy worked and I could not tell you what
        // it produced" — one of those is a rollback and the other is a path.
        console.error(
          `Applied ${args.env}, but could not write ${args.json}: ${(err as Error).message}`,
        )
        process.exit(1)
      }
      console.log(`\nWrote ${args.json}`)
    }

    console.log('\nDone.')
  },
})
