/**
 * Where the watcher gets its host, its repository and its ref when nobody says.
 *
 * The whole reason this package exists rather than a pasted snippet is that in
 * a clone there is nothing left to decide: the remote already names the host
 * and the repository, and `HEAD` already names the ref. Every function here is
 * the pure half of that — string in, decision out — so the discovery rules are
 * testable without a git repository, a network or a subprocess.
 *
 * Nothing in this file imports from walgit. The wire it speaks is frozen
 * (docs/adr/0009 in Zabaca/zbc), and a client that depended on the server's
 * source would be a client nobody outside this repository could build.
 */

/** A remote URL, reduced to the two facts a subscription needs. */
export interface RemoteTarget {
  host: string
  repo: string
}

/**
 * Read `https://host/name.git` — and only that shape.
 *
 * walgit serves smart-HTTP and nothing else, so an `ssh://` or `git@` remote is
 * not a walgit remote and guessing a hostname out of one would produce a socket
 * that answers 404 with no explanation. A remote this does not recognise is
 * reported as unrecognised.
 */
export function parseRemote(url: string): RemoteTarget | null {
  const trimmed = url.trim()
  const match = /^https?:\/\/(?:[^@/]*@)?([^/:]+(?::\d+)?)\/([^/]+?)(?:\.git)?\/?$/.exec(trimmed)
  if (!match) return null
  const [, host, repo] = match
  if (!host || !repo) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo)) return null
  return { host, repo }
}

/** One remote, as `git remote -v` prints it. */
export interface Remote {
  name: string
  url: string
}

/**
 * `git remote -v` is two lines per remote and a tab nobody should have to see.
 */
export function parseRemoteList(stdout: string): Remote[] {
  const seen = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim())
    if (!match) continue
    const [, name, url] = match
    if (name && url && !seen.has(name)) seen.set(name, url)
  }
  return [...seen].map(([name, url]) => ({ name, url }))
}

/**
 * Which remote is the one being watched.
 *
 * `origin` wins when it parses, because that is the remote the clone came from
 * and the one whose refs `git fetch` advances by default. Otherwise the first
 * remote that looks like a walgit URL at all — a clone with `origin` on GitHub
 * and a second remote on agentgit is the handoff case, and it should not need a
 * flag.
 */
export function pickRemote(remotes: readonly Remote[]): (RemoteTarget & { name: string }) | null {
  const origin = remotes.find((remote) => remote.name === 'origin')
  if (origin) {
    const target = parseRemote(origin.url)
    if (target) return { ...target, name: origin.name }
  }
  for (const remote of remotes) {
    const target = parseRemote(remote.url)
    if (target) return { ...target, name: remote.name }
  }
  return null
}

/**
 * The ref a checkout is on, or `null` on a detached HEAD.
 *
 * Detached is not an error — it is an agent mid-bisect or mid-review — but it
 * is no basis for a subscription, so the caller asks for a ref instead of
 * inventing `refs/heads/main` and watching something nobody is on.
 */
export function parseHead(symbolicRef: string): string | null {
  const ref = symbolicRef.trim()
  return /^refs\/heads\/.+$/.test(ref) ? ref : null
}

/**
 * The paths a `git merge-tree --write-tree --name-only` conflict names.
 *
 * Line one is the tree the merge produced; the paths follow, then a blank line
 * and git's own prose, which is written for people rather than for this.
 * Verified against git 2.50.1.
 */
export function conflictPaths(stdout: string): string[] {
  const [, ...rest] = stdout.split('\n')
  const paths: string[] = []
  for (const line of rest) {
    if (line.trim() === '') break
    paths.push(line.trim())
  }
  return paths
}
