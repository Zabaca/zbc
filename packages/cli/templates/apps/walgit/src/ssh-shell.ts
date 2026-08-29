#!/usr/bin/env bun
/**
 * The SSH forced command.
 *
 * Every authorized key is pinned to this script (`command="..."` in
 * authorized_keys), so an SSH session can do exactly one thing: run one git
 * transport verb against one repository. The client's own command line arrives
 * in SSH_ORIGINAL_COMMAND and is parsed, never executed.
 *
 * git's transport is stdio: upload-pack/receive-pack speak the pack protocol
 * over the same stdin/stdout the SSH channel provides, which is why this
 * process replaces itself with git rather than proxying bytes.
 */

import { spawnSync } from 'node:child_process'
import { ensureBareRepo } from './cache'
import { parseSshCommand, resolveRepo } from './repo'
import { storeFromEnv } from './store-env'
import { syncRepo } from './sync'

const reposDir = process.env.WALGIT_REPOS_DIR ?? '/srv/walgit/repos'

try {
  const { service, requested } = parseSshCommand(process.env.SSH_ORIGINAL_COMMAND)
  const repo = ensureBareRepo(resolveRepo(reposDir, requested))
  // Before a byte of the pack protocol is exchanged: an upload-pack that
  // advertises stale refs sends the client a repository that no longer exists,
  // and a receive-pack negotiating against them computes its ref updates from
  // a state the log has already moved past.
  await syncRepo(storeFromEnv(), repo)
  const res = spawnSync(service, [repo.dir], { stdio: 'inherit' })
  process.exit(res.status ?? 1)
} catch (err) {
  // Goes back over the SSH channel to the client, which prints it verbatim.
  process.stderr.write(`walgit: ${(err as Error).message}\n`)
  process.exit(1)
}
