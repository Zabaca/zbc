/**
 * Clear what a previous process left on the disk that only a process can own.
 *
 * The Cache is reconciled against the Index on every access, so whatever the
 * disk believes about refs and objects is corrected before it is served
 * (src/sync.ts). Two things on it are NOT about the repository at all, and
 * reconcile never looks at them:
 *
 *   - a push's hand-off record (src/pending.ts), keyed by the pid of the
 *     `git-receive-pack` that wrote it. The sweep that removes dead ones asks
 *     whether that pid is alive — and a pid from before a restart can be alive
 *     again as somebody else, in a container whose pids start from 1 every
 *     time. Within the record's hour a push whose receive-pack drew that pid
 *     would read a stranger's hand-off.
 *   - a materialize lock (src/materialize.ts). Broken after six seconds by
 *     design, so it costs a wait rather than a wedge — but a wait on the first
 *     clone after a wake, which is the request this path exists to make fast.
 *
 * Neither could survive a restart while the disk was wiped on every one. With
 * filesystem snapshots (shared/container-snapshot.ts) the disk outlives the
 * process, so the process clears them itself, once, before it serves anything.
 * At that moment the answer is exact rather than a heuristic: nothing that
 * could hold either exists yet, so every one found is residue.
 *
 * The materialize MARKER is deliberately left alone. It is not process state —
 * it is the evidence that a restore died partway, and `syncRepo` trusts it over
 * the refs, which is exactly what a disk restored mid-restore needs.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { lockPath } from './materialize'
import { pendingDir } from './pending'

/** Remove every hand-off record and materialize lock under `reposDir`. */
export function clearBootResidue(reposDir: string): { repos: number; cleared: string[] } {
  let names: string[]
  try {
    names = fs.readdirSync(reposDir)
  } catch {
    // No repos directory yet is the ordinary first boot of an empty disk.
    return { repos: 0, cleared: [] }
  }
  const cleared: string[] = []
  let repos = 0
  for (const name of names) {
    if (!name.endsWith('.git')) continue
    repos += 1
    const gitDir = path.join(reposDir, name)
    for (const residue of [pendingDir(gitDir), lockPath(gitDir)]) {
      if (!fs.existsSync(residue)) continue
      fs.rmSync(residue, { recursive: true, force: true })
      cleared.push(residue)
    }
  }
  return { repos, cleared }
}
