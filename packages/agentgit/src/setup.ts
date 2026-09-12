/**
 * `agentgit setup` — turning the helper on, which is one line of git config.
 *
 * It exists because that line is easy to get subtly wrong: the config key
 * carries the whole ORIGIN (`credential.https://host.helper`), not the
 * hostname, and a key that is off by a scheme is a helper git silently never
 * calls. The symptom of getting it wrong is a password prompt, which on a
 * machine with no human at it is a hang.
 */

import { git, toplevel } from './git'
import { originOf, parseRemoteList, pickRemote } from './remote'

/** What the helper is invoked as. `!` is git's "run this as a command". */
export const HELPER_COMMAND = '!agentgit credential'

export interface SetupDeps {
  /** The origin of the walgit remote in the current checkout, if there is one. */
  remoteOrigin(): string | null
  /** `git config …`. A non-zero code with git's own message is a failure. */
  writeConfig(args: readonly string[]): { code: number; stderr: string }
}

export interface SetupRequest {
  host: string | null
  global: boolean
}

export interface SetupResult {
  stdout: string
  stderr: string
  code: number
}

/**
 * The origin a `setup` argument names.
 *
 * A bare hostname means https, because that is every deployment; a
 * self-hosted node on plain http is named in full (`http://127.0.0.1:8787`),
 * which is also what the remote of a clone of it says.
 */
export function originFromArgument(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, '')
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** The config key git looks the helper up under, for one origin. */
export function helperConfigKey(origin: string): string {
  return `credential.${origin}.helper`
}

export async function runSetup(request: SetupRequest, deps: SetupDeps): Promise<SetupResult> {
  const origin = request.host === null ? deps.remoteOrigin() : originFromArgument(request.host)
  if (origin === null) {
    return {
      stdout: '',
      stderr:
        'agentgit: no walgit remote here to take a host from.\n' +
        'Run this in a clone, or name the host: agentgit setup agentgit.zabaca.com\n',
      code: 2,
    }
  }

  const key = helperConfigKey(origin)
  const scope = request.global ? '--global' : '--local'
  const written = deps.writeConfig(['config', scope, key, HELPER_COMMAND])
  if (written.code !== 0) {
    return {
      stdout: '',
      stderr: `agentgit: git config ${scope} ${key} failed (${written.code}): ${written.stderr.trim()}\n`,
      code: 1,
    }
  }

  return {
    stdout:
      `${scope === '--global' ? 'git config --global' : 'git config'} ${key} '${HELPER_COMMAND}'\n` +
      `agentgit now answers ${origin} for git — clone, fetch and push need nothing typed.\n`,
    stderr: '',
    code: 0,
  }
}

/** The deps as they are on a real machine. */
export function realSetupDeps(cwd: string = process.cwd()): SetupDeps {
  return {
    remoteOrigin() {
      const root = toplevel(cwd)
      if (!root) return null
      const remotes = parseRemoteList(git(root, ['remote', '-v']).stdout)
      // The same remote `watch` would subscribe to, so `setup` and `watch`
      // can never disagree about which host this clone belongs to.
      const chosen = pickRemote(remotes)
      const url = chosen && remotes.find((remote) => remote.name === chosen.name)?.url
      return url ? originOf(url) : null
    },
    writeConfig(args) {
      const run = git(cwd, args)
      return { code: run.code, stderr: run.stderr }
    },
  }
}
