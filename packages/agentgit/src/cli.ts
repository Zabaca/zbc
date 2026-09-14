/**
 * `agentgit watch` — the client the service used to print as a snippet.
 *
 * It is here rather than in the walgit package because it is agentgit's, not
 * the mechanism's: walgit ships a protocol and a four-line example that still
 * works with nothing installed, and this is the convenience on top. The claim
 * on the homepage — no SDK, no library, no install — stays true precisely
 * because this remains optional.
 *
 * What it adds over the snippet is the part that is tedious rather than hard:
 * discovery. In a clone there is nothing left to decide — the remote names the
 * host and the repository, `HEAD` names the ref — so the useful invocation is
 * `agentgit watch` with no arguments at all.
 *
 * Node and Bun both, deliberately: `npx` and `bunx` are how an agent runs
 * something once, and a client only one of them can run is a client half the
 * agents cannot use. No dependencies, for the same reason.
 */

import { parseArgs, type WatchOptions } from './args'
import { readAuthorization, realCredentialDeps, runCredential } from './credential'
import { remoteList, symbolicHead, toplevel } from './git'
import { originOf, parseHead, parseRemoteList, pickRemote } from './remote'
import { realSetupDeps, runSetup } from './setup'
import { watch } from './watch'

const VERSION = '0.1.0'

const HELP = `agentgit — watch a walgit repository and keep a clone current

USAGE
  agentgit watch [<repo>[=<dir>] …] [options]
  agentgit setup [<host>] [--local]
  agentgit credential get|store|erase

  Run it inside a clone with no arguments and it reads the host, the
  repository and the ref from the remote and the branch you are on.

OPTIONS
  --ref <ref>       full ref name to watch; repeatable (default: the branch HEAD is on)
  --all-refs        watch every ref in the repository
  --host <host>     walgit host (default: from the remote, then $AGENTGIT_HOST)
  --token <token>   bearer token, where the deployment requires one ($AGENTGIT_TOKEN)
  --once            exit 0 after the first ref moves — wait for a handoff
  --no-fetch        report what moved; do not fetch
  --on <command>    shell command to run after a fetch, in the clone
                    ($AGENTGIT_REPO, $AGENTGIT_REF, $AGENTGIT_SHA are set)
  --json            one JSON object per line, instead of prose
  -h, --help        this
  -v, --version     version

PRIVATE REPOSITORIES
  A walgit repository carrying a Reader List refuses every read until a listed
  key signs the host's challenge. agentgit setup writes the one config line
  that makes git ask this client for that signature:

    git config --global credential.https://<host>.helper '!agentgit credential'

  After it, clone, fetch, push and watch need nothing typed. The key is the one
  git already signs pushes with (user.signingkey); nothing is stored.

EXAMPLES
  agentgit watch                        # in a clone: everything is inferred
  agentgit setup                        # in a clone: turn the helper on for its host
  agentgit watch --once                 # block until the other agent pushes
  agentgit watch --on 'bun test'        # and run the suite when it lands
  agentgit watch a=../a b=../b          # one socket, several checkouts
  agentgit watch --json | jq -r .event  # for something that is not a person

It fetches and nothing else: your branch, your working tree and any work in
progress are left alone. When what arrives collides with what you are in the
middle of, it says so, and says which files.
`

function fail(message: string): never {
  process.stderr.write(`agentgit: ${message}\n`)
  process.exit(2)
}

/**
 * Fill in whatever was not said, from the checkout the command was run in.
 *
 * Discovery only ever ADDS: a flag or an argument that was given is never
 * overridden by what git happens to say, so an explicit invocation behaves the
 * same in a clone and out of one.
 */
function resolve(options: WatchOptions): Parameters<typeof watch>[0] {
  const envHost = process.env.AGENTGIT_HOST ?? process.env.WALGIT_HOST ?? null
  const envToken = process.env.AGENTGIT_TOKEN ?? process.env.WALGIT_TOKEN ?? null

  let host = options.host ?? envHost
  let remoteName = 'origin'
  /** The remote's scheme and host, for the credential the event socket needs. */
  let origin: string | null = null
  const targets = new Map(options.targets)
  const refs = [...options.refs]

  const needsDiscovery =
    targets.size === 0 ||
    host === null ||
    (refs.length === 0 && !options.allRefs) ||
    [...targets.values()].some((dir) => dir === '')

  if (needsDiscovery) {
    const root = toplevel(process.cwd())
    if (!root) {
      if (targets.size === 0)
        fail('not inside a git repository — name a repository, or run this in a clone')
      if (host === null)
        fail('no --host and no $AGENTGIT_HOST, and not inside a clone to read one from')
    } else {
      const remotes = parseRemoteList(remoteList(root))
      const found = pickRemote(remotes)
      if (found) {
        remoteName = found.name
        host ??= found.host
        origin = originOf(remotes.find((remote) => remote.name === found.name)?.url ?? '')
        if (targets.size === 0) targets.set(found.repo, root)
      } else if (targets.size === 0) {
        fail('no https remote here that looks like a walgit repository — pass <repo> and --host')
      }
      for (const [repo, dir] of targets) if (dir === '') targets.set(repo, root)
      if (refs.length === 0 && !options.allRefs) {
        const head = parseHead(symbolicHead(root))
        if (head) refs.push(head)
        // A detached HEAD is not an error — an agent mid-review is a normal
        // state — but it is no basis for a subscription, so the whole
        // repository is watched rather than a branch nobody is on.
      }
    }
  }

  if (host === null) fail('no host: pass --host or set $AGENTGIT_HOST')
  for (const [repo, dir] of targets) {
    if (dir === '') fail(`no directory for ${repo}: pass ${repo}=<dir>`)
  }

  return {
    host,
    token: options.token ?? envToken,
    // Only where no token was given: a deployment token and a Read Challenge
    // signature arrive in the same header, and presenting both is not a thing
    // one request can do. Re-derived on every connect rather than cached — a
    // nonce stands for five minutes, and a stale one is a socket that is
    // refused rather than one that reconnects.
    credential:
      (options.token ?? envToken) !== null
        ? null
        : () => readAuthorization(origin ?? `https://${host}`, realCredentialDeps()),
    targets,
    refs: options.allRefs ? [] : refs,
    remoteName,
    fetch: options.fetch,
    once: options.once,
    onChange: options.onChange,
    json: options.json,
  }
}

const parsed = parseArgs(process.argv.slice(2))

switch (parsed.kind) {
  case 'help':
    process.stdout.write(HELP)
    break
  case 'version':
    process.stdout.write(`${VERSION}\n`)
    break
  case 'error':
    process.stderr.write(`agentgit: ${parsed.message}\n\n${HELP}`)
    process.exit(2)
    break
  case 'watch':
    watch(resolve(parsed.options))
    break
  case 'credential': {
    // git writes the request and closes the pipe; reading it to the end before
    // answering is what keeps `get` from racing its own stdout. Iterated
    // rather than piped through a `Response`, because `process.stdin` is a
    // node stream under node and a web stream is what that constructor takes.
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    const stdin = Buffer.concat(chunks).toString('utf8')
    const answered = await runCredential(parsed.operation, stdin, realCredentialDeps())
    if (answered.stdout) process.stdout.write(answered.stdout)
    if (answered.stderr) process.stderr.write(answered.stderr)
    process.exitCode = answered.code
    break
  }
  case 'setup': {
    const done = await runSetup({ host: parsed.host, global: parsed.global }, realSetupDeps())
    if (done.stdout) process.stdout.write(done.stdout)
    if (done.stderr) process.stderr.write(done.stderr)
    process.exitCode = done.code
    break
  }
}
