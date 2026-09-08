import * as path from 'node:path'
import { defineCommand } from 'citty'
import { listInstanceActions, runEnvironmentAction } from '../engine/actions'
import { findProjectRoot } from '../utils/find-project-root'
import { loadConfig } from '../utils/load-config'

/**
 * `zbc run <env> <instance> <action>` — the operator's verb.
 *
 * `apply` and `destroy` are the world converging and the world going away.
 * This is neither: a domain purchase, a key rotation, a verification mail. It
 * runs exactly one action on exactly one instance, never the instance's own
 * `apply`, and never as part of `zbc apply`.
 */
export const runCommand = defineCommand({
  meta: {
    name: 'run',
    description: "Run one of an instance's module actions (omit the action to list them)",
  },
  args: {
    env: {
      type: 'positional',
      description: 'Environment name (e.g., production, preview)',
      required: true,
    },
    instance: { type: 'positional', description: 'Instance to act on', required: true },
    action: {
      type: 'positional',
      description: 'Action to run (omit to list what the instance declares)',
      required: false,
    },
    yes: {
      type: 'boolean',
      description: 'Confirm an irreversible action',
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

    try {
      if (!args.action) {
        const actions = await listInstanceActions(envDir, args.instance)
        if (actions.length === 0) {
          console.log(`${args.instance} declares no actions.`)
          return
        }
        console.log(`Actions on ${args.instance}:`)
        for (const action of actions) {
          const note = action.irreversible ? ' (irreversible — needs --yes)' : ''
          console.log(`  ${action.name.padEnd(20)} ${action.description}${note}`)
        }
        return
      }

      await runEnvironmentAction(projectRoot, envDir, {
        instance: args.instance,
        action: args.action,
        confirmed: args.yes,
      })
      console.log('\nDone.')
    } catch (err) {
      // A refusal is the normal outcome of half of these — an unknown action,
      // an unconfirmed purchase — so it reads as a message and an exit code,
      // not as a stack trace.
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  },
})
