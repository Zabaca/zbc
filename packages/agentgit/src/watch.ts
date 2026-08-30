/**
 * One socket, and what to do with what comes down it.
 *
 * The protocol is latest state, not a log (docs/adr/0009): the reply to a
 * `watch` is the current sha of everything named, and after that one message
 * per ref that moves. There is no cursor, no replay and no keepalive, so there
 * is no state file here and nothing to resume — a reconnect's handshake IS the
 * recovery, which is why a watcher that was offline for an hour is correct one
 * round trip after it comes back.
 */

import { spawnSync } from 'node:child_process'

import { git, shortRef } from './git'
import { conflictPaths } from './remote'

/** Where a subscriber connects. Frozen by the ADR above; not derived from the server. */
const EVENTS_PATH = '/_walgit/events'

export interface WatchConfig {
  host: string
  token: string | null
  /** `repo` → the checkout to fetch into. */
  targets: Map<string, string>
  /** Empty watches every ref in each repository. */
  refs: string[]
  remoteName: string
  fetch: boolean
  once: boolean
  onChange: string | null
  json: boolean
}

/** Everything printed goes through here, so `--json` is a format and not a fork. */
type Emit = (event: string, fields: Record<string, unknown>, human: string) => void

function makeEmit(json: boolean): Emit {
  if (json) {
    return (event, fields) => {
      process.stdout.write(
        `${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`,
      )
    }
  }
  return (_event, _fields, human) => {
    process.stdout.write(`${new Date().toISOString()} ${human}\n`)
  }
}

/**
 * Which files the ref that just moved collides with, here, right now.
 *
 * This is the reason an event beats a timer: not that the fetch happens sooner,
 * but that the agent can be told *the branch you are working on just moved
 * underneath you, in these files* at the moment it becomes true.
 *
 * `git stash create` is what makes that answerable. `merge-tree` compares
 * COMMITS, so an agent mid-task — edits in the working tree, nothing committed
 * — is invisible to it, which is precisely the case worth warning about.
 * `stash create` writes a throwaway commit of the working tree and index
 * without touching the working tree, the refs or the stash list; the commit is
 * unreferenced and is collected on its own.
 *
 * Exit 1 is a conflict. Exit 0 is clean — including a clone that is merely
 * behind, where the merge is a fast-forward. Anything else means git could not
 * answer (unrelated histories, and similar), and is reported as nothing rather
 * than as a conflict: an agent sent to reconcile a collision that does not
 * exist has been given work, not information.
 */
function conflicts(dir: string, remoteRef: string): string[] {
  const wip = git(dir, ['stash', 'create']).stdout.trim()
  const merge = git(dir, ['merge-tree', '--write-tree', '--name-only', wip || 'HEAD', remoteRef])
  return merge.code === 1 ? conflictPaths(merge.stdout) : []
}

export function watch(config: WatchConfig): void {
  const emit = makeEmit(config.json)
  /** The collision each watched ref last reported, so repeats stay quiet. */
  const standing = new Map<string, string>()
  let attempt = 0
  let closing = false

  const handle = (repo: string, ref: string, sha: string | null, catchUp: boolean): boolean => {
    const dir = config.targets.get(repo)
    if (dir === undefined) return false
    const short = shortRef(ref)

    if (sha === null) {
      // Nothing new exists to download, and pruning somebody's ref out from
      // under a working clone is a decision for its owner, not for a watcher.
      emit('deleted', { repo, ref }, `${repo} ${ref}: deleted upstream; leaving ${dir} alone`)
      return true
    }

    if (!config.fetch) {
      emit('moved', { repo, ref, sha }, `${repo} ${short}: now ${sha.slice(0, 8)}`)
      return true
    }

    const fetched = git(dir, ['fetch', '--quiet', config.remoteName, short])
    if (fetched.code !== 0) {
      emit(
        'fetch-failed',
        { repo, ref, code: fetched.code, stderr: fetched.stderr.trim() },
        `${repo} ${short}: fetch failed (${fetched.code}) ${fetched.stderr.trim()}`,
      )
      return true
    }

    const remoteRef = `${config.remoteName}/${short}`
    const local = git(dir, ['rev-parse', remoteRef]).stdout.trim()
    emit(
      'fetched',
      { repo, ref, sha, local, current: local === sha },
      `${repo} ${short}: ${remoteRef} is ${local.slice(0, 8)}${local === sha ? '' : ' (behind)'}`,
    )

    // Reported when it CHANGES, not on every event. A collision that is still
    // there is still true, but an agent told the same thing on every unrelated
    // push learns to ignore the channel — and this is only worth having if it
    // is believed.
    const key = `${repo} ${short}`
    const clash = conflicts(dir, remoteRef).join(', ')
    const before = standing.get(key) ?? ''
    if (clash !== before) {
      standing.set(key, clash)
      if (clash)
        emit(
          'collides',
          { repo, ref, paths: clash.split(', ') },
          `${key}: COLLIDES with your work in ${clash}`,
        )
      else if (before) emit('clear', { repo, ref }, `${key}: no longer collides with your work`)
    }

    if (config.onChange && !catchUp) {
      const spawned = spawnCommand(config.onChange, dir, { repo, ref, sha })
      emit(
        'ran',
        { repo, ref, command: config.onChange, code: spawned },
        `${key}: ran --on (exit ${spawned})`,
      )
    }

    return true
  }

  const connect = (): void => {
    const url = `wss://${config.host}${EVENTS_PATH}`
    const socket = config.token
      ? new WebSocket(url, { headers: { authorization: `Bearer ${config.token}` } } as never)
      : new WebSocket(url)

    socket.onopen = () => {
      attempt = 0
      const entries = [...config.targets.keys()].map((repo) =>
        config.refs.length > 0 ? { repo, refs: config.refs } : { repo },
      )
      socket.send(JSON.stringify({ watch: entries }))
    }

    socket.onmessage = (event: MessageEvent) => {
      let message: {
        error?: string
        ok?: boolean
        refs?: { repo: string; ref: string; sha: string | null }[]
        repo?: string
        ref?: string
        sha?: string | null
      }
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }

      // A refusal names what it refused — an unknown repository, a watch list
      // over the cap — and is worth reading rather than retrying blindly.
      if (message.error) {
        emit('refused', { error: message.error }, `refused: ${message.error}`)
        closing = true
        socket.close()
        process.exitCode = 1
        return
      }

      if (message.ok) {
        // Current state for everything watched, before any event can fire.
        // Acting on it here is what makes a freshly started watcher correct
        // rather than merely subscribed.
        emit(
          'watching',
          { host: config.host, repos: [...config.targets.keys()], refs: config.refs },
          `${config.host}: watching ${[...config.targets.keys()].join(', ')}${config.refs.length ? ` for ${config.refs.join(', ')}` : ' (all refs)'}`,
        )
        for (const state of message.refs ?? []) handle(state.repo, state.ref, state.sha, true)
        return
      }

      if (typeof message.repo !== 'string' || typeof message.ref !== 'string') return
      const acted = handle(message.repo, message.ref, message.sha ?? null, false)
      if (acted && config.once) {
        closing = true
        socket.close()
      }
    }

    // Reconnect with a backoff, and nothing else: whatever moved while the
    // socket was down is in the next handshake, so there is nothing to replay.
    socket.onclose = (event: CloseEvent) => {
      if (closing) return
      const wait = Math.min(30_000, 500 * 2 ** attempt)
      attempt += 1
      emit(
        'disconnected',
        { code: event.code, retryMs: wait },
        `disconnected (${event.code}); reconnecting in ${wait}ms`,
      )
      setTimeout(connect, wait)
    }

    // Reported, not acted on: a close always follows, and reconnecting from
    // both would open two sockets.
    socket.onerror = () => emit('socket-error', {}, 'socket error')
  }

  connect()
}

/**
 * `--on`, run in the clone that just moved.
 *
 * A shell string rather than an argv, because the point is to paste whatever
 * the harness already uses. The three facts the command needs arrive as
 * environment variables so a one-liner does not have to parse anything.
 */
function spawnCommand(
  command: string,
  dir: string,
  env: { repo: string; ref: string; sha: string },
): number {
  const run = spawnSync(process.env.SHELL || '/bin/sh', ['-c', command], {
    cwd: dir,
    stdio: 'inherit',
    env: {
      ...process.env,
      AGENTGIT_REPO: env.repo,
      AGENTGIT_REF: env.ref,
      AGENTGIT_SHA: env.sha,
    },
  })
  return run.status ?? 1
}
