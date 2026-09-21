/**
 * What a watch invocation MEANS, once the clone and the environment are read.
 *
 * It sits between `parseArgs` and `watch`, and it holds the same class of rule
 * the parser does: a host taken from the wrong place, a directory guessed, a
 * ref defaulted — each is a background watcher that quietly watches the wrong
 * thing. The parser is pure and exhaustively tested for exactly that reason,
 * and this step used to be neither: it read `process.cwd()`, spawned git, and
 * produced each of its refusals by exiting.
 *
 * So a refusal is a VALUE here. The environment, the working directory,
 * discovery and the credential factory are declared dependencies, and the exit
 * code belongs to the caller — which is what lets the whole of this be reached
 * from a test with no subprocess, and what makes the same resolution usable
 * from something that is not a CLI.
 */

import { proposalPusher } from './accept'
import type { CloneDiscovery } from './clone'
import type { WatchOptions } from './args'
import { type AgentgitEnv, envHost, envToken } from './env'
import type { WatchConfig } from './watch'

/** Everything this step reaches for that is not the command line. */
export interface ResolveDeps {
  /** The four variables this client reads (`src/env.ts`), already narrowed. */
  env: AgentgitEnv
  /** Where the command was run — the directory discovery starts from. */
  cwd: string
  /** Which clone this is (`src/clone.ts`). Called only where something is missing. */
  discover(cwd: string): CloneDiscovery
  /**
   * The `Authorization` a Private repository's event socket needs, for one
   * origin — a factory, because a challenge stands for five minutes and the
   * header is re-derived per connect rather than cached.
   */
  credential(origin: string): () => Promise<string | null>
}

/**
 * A resolved watch: everything `watch` takes, minus the two fields that are
 * about the PROCESS rather than the resolution.
 *
 * `onDone` decides an exit code and `emit` decides where the lines go; neither
 * is a fact about what was asked for, and leaving them out is how "the CLI owns
 * the exit code" stays structural instead of a convention somebody remembers.
 */
export type ResolvedWatch = Omit<WatchConfig, 'onDone' | 'emit'>

/**
 * Why a watch cannot be resolved, named.
 *
 * The code is the distinction, carried separately from the sentence: every one
 * of these exits 2 today, and an exit-code split later is then a change in the
 * caller rather than in this signature.
 */
export type RefusalCode =
  | 'no-repository'
  | 'no-host-outside-clone'
  | 'no-walgit-remote'
  | 'no-host'
  | 'proposals-detached-head'
  | 'no-directory'
  | 'host-is-url'

export interface WatchRefusal {
  kind: 'refusal'
  code: RefusalCode
  /** What the agent is told, without the `agentgit: ` the caller prefixes. */
  message: string
}

export type Resolution = { kind: 'watch'; config: ResolvedWatch } | WatchRefusal

const refuse = (code: RefusalCode, message: string): WatchRefusal => ({
  kind: 'refusal',
  code,
  message,
})

/**
 * Two host-with-port strings naming the same machine.
 *
 * Case-insensitive because host names are, and exact about the port because a
 * port is part of which thing is listening: `node.local` and `node.local:8080`
 * are two deployments, not one spelled twice.
 */
function sameHost(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Fill in whatever was not said, from the checkout the command was run in.
 *
 * Discovery only ever ADDS: a flag or an argument that was given is never
 * overridden by what git happens to say, so an explicit invocation behaves the
 * same in a clone and out of one — and, being conditional, an invocation that
 * names everything spawns no git at all.
 */
export function resolveWatch(options: WatchOptions, deps: ResolveDeps): Resolution {
  const presented = options.token ?? envToken(deps.env)

  let host = options.host ?? envHost(deps.env)
  let remoteName = 'origin'
  /** The clone's own origin, a candidate until the host it names is compared. */
  let cloneOrigin: { host: string; origin: string } | null = null
  const targets = new Map(options.targets)
  const refs = [...options.refs]

  const needsDiscovery =
    targets.size === 0 ||
    host === null ||
    (refs.length === 0 && !options.allRefs) ||
    [...targets.values()].some((dir) => dir === '')

  if (needsDiscovery) {
    // The one discovery (`src/clone.ts`), which `accept` and `setup` also ask,
    // so the three can never disagree about which remote a clone belongs to.
    const found = deps.discover(deps.cwd)
    if (found.kind === 'no-repository') {
      if (targets.size === 0) {
        return refuse(
          'no-repository',
          'not inside a git repository — name a repository, or run this in a clone',
        )
      }
      if (host === null) {
        return refuse(
          'no-host-outside-clone',
          'no --host and no $AGENTGIT_HOST, and not inside a clone to read one from',
        )
      }
    } else {
      if (found.kind === 'clone') {
        remoteName = found.remoteName
        host ??= found.host
        cloneOrigin = { host: found.host, origin: found.origin }
        if (targets.size === 0) targets.set(found.repo, found.root)
      } else if (targets.size === 0) {
        return refuse(
          'no-walgit-remote',
          'no https remote here that looks like a walgit repository — pass <repo> and --host',
        )
      }
      for (const [repo, dir] of targets) if (dir === '') targets.set(repo, found.root)
      // A detached HEAD is not an error — an agent mid-review is a normal
      // state — but it is no basis for a subscription, so the whole repository
      // is watched rather than a branch nobody is on. The ref rides on both
      // arms that have a root, so a checkout whose only remote is GitHub still
      // gets its default when a repository was named on the command line.
      if (refs.length === 0 && !options.allRefs && found.ref) refs.push(found.ref)
    }
  }

  if (host === null) return refuse('no-host', 'no host: pass --host or set $AGENTGIT_HOST')
  // A host is a name and a port, and the origin below spells the scheme. A URL
  // given here used to be concatenated — `https://https://walgit.example` — and
  // reached the socket and the challenge as a hostname nothing resolves.
  if (host.includes('/')) {
    return refuse('host-is-url', `host is a URL: pass the host name alone, not ${host}`)
  }
  // A Proposal's ref names the branch it targets, so with no branch to watch
  // there is no namespace to scope — every Proposal would be ignored, silently.
  // Said here rather than reported as nothing: a detached HEAD is the case,
  // and `--all-refs` is already refused at parse.
  if (options.proposals && refs.length === 0) {
    return refuse(
      'proposals-detached-head',
      '--proposals needs a branch to aim at, and HEAD is detached: check out the ' +
        'branch the Proposals target, or name it with --ref',
    )
  }
  for (const [repo, dir] of targets) {
    if (dir === '') return refuse('no-directory', `no directory for ${repo}: pass ${repo}=<dir>`)
  }

  // The one origin, and it always names the host above. A clone's origin is
  // adopted only where the clone is a clone of THIS host — the comparison, not
  // a provenance test: `--host node.local:8080` inside a clone of that node
  // keeps its plain http, and `--host elsewhere` inside the same clone does
  // not sign a challenge for a machine nobody is connected to.
  const origin =
    cloneOrigin && sameHost(cloneOrigin.host, host) ? cloneOrigin.origin : `https://${host}`

  return {
    kind: 'watch',
    config: {
      origin,
      token: presented,
      // Only where no token was given: a deployment token and a Read Challenge
      // signature arrive in the same header, and presenting both is not a thing
      // one request can do.
      credential: presented !== null ? null : deps.credential(origin),
      targets,
      refs: options.allRefs ? [] : refs,
      remoteName,
      fetch: options.fetch,
      once: options.once,
      onChange: options.onChange,
      ffOnClean: options.ffOnClean,
      json: options.json,
      proposals: options.proposals,
      // The fingerprint behind a Proposal is the Proposals read's business
      // (`src/accept.ts`), which is where the lookup lives; this only decides
      // that it is wanted, and with which targets and credential.
      pusher: options.proposals ? proposalPusher({ targets, origin, token: presented }) : null,
    },
  }
}
