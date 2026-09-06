import * as path from 'node:path'
import { defineCommand } from 'citty'
import { discoverInstances } from '../engine/discover'
import { isEphemeral, resolveOrder } from '../engine/resolve'
import { findProjectRoot } from '../utils/find-project-root'
import { loadConfig } from '../utils/load-config'

/** One instance as `zbc list` reports it. The `--json` document is `{ env, instances }`. */
export interface ListedInstance {
  name: string
  module: string
  ephemeral: boolean
  /** Whether the module defines `destroy` — i.e. whether `zbc destroy` reaches it. */
  destroyable: boolean
  imports: string[]
}

/**
 * What an environment declares, in the order the engine would apply it.
 *
 * The engine has always computed this — discovery and the topological sort run
 * on every apply — and has never had a way to say it out loud, so a consumer
 * reconciling live provider state against "what should exist" had to enumerate
 * the providers and guess the second half. Nothing here talks to a provider or
 * runs a module: it is the declaration, read.
 */
export const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List the module instances an environment declares, in dependency order',
  },
  args: {
    env: {
      type: 'positional',
      description: 'Environment name (e.g., production, preview)',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Emit the listing as JSON on stdout',
      default: false,
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
    const instances = await discoverInstances(envDir)
    const sorted = resolveOrder(instances, { envLabel: envDir })

    const listed: ListedInstance[] = sorted.map((instance) => ({
      name: instance.name,
      module: instance.moduleName,
      ephemeral: isEphemeral(instance),
      destroyable: instance._definition.destroy !== undefined,
      imports: instance.imports.map((dep) => dep.name),
    }))

    if (args.json) {
      // No trailing prose: `zbc list --json | jq` is the point of the flag.
      process.stdout.write(`${JSON.stringify({ env: args.env, instances: listed }, null, 2)}\n`)
      return
    }

    if (listed.length === 0) {
      console.log(`No module instances declared in ${args.env}.`)
      return
    }

    for (const instance of listed) {
      const notes = [
        instance.ephemeral ? 'ephemeral' : '',
        instance.destroyable ? 'destroyable' : 'no destroy',
        instance.imports.length > 0 ? `imports: ${instance.imports.join(', ')}` : '',
      ].filter((note) => note.length > 0)
      console.log(`${instance.name.padEnd(24)} ${instance.module.padEnd(20)} ${notes.join('  ')}`)
    }
  },
})
