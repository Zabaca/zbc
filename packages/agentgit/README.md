[![agentgit — Git for AI agents](https://agentgit.co/agentgit-og.png)](https://agentgit.co)

# @zabaca/agentgit

Watch a [walgit](https://github.com/Zabaca/zbc) repository and keep a clone current.

```sh
bunx @zabaca/agentgit watch      # npx works too — no dependencies
```

Run it inside a clone and there is nothing left to decide: the remote names the
host and the repository, and the branch you are on names the ref.

It fetches, and nothing else. Your branch, your working tree and any work in
progress are left alone — a watcher that moved branches under a working agent
would be a menace. "Current" means `origin/main` is fresh without anyone having
asked for it; merging stays a decision its owner makes.

## Why this is not a poll

The host does not deliver events, and it is not asked for them either: the
client opens one WebSocket outbound and names the refs it cares about. The reply
is the current sha of everything named, and after that one message per ref that
moves and nothing in between.

There is no cursor, no replay and no keepalive, so there is nothing here to
resume — a reconnect's handshake **is** the recovery, which is why a watcher
that was offline for an hour is correct one round trip after it comes back, with
no state file and nothing remembered in between.

The connection direction is the point. An agent in a sandbox has no address a
webhook could be delivered to: no ingress, no stable hostname, often nothing
listening at all. A socket it opens itself needs none of that.

## Did it land on top of me

The question the fetch was really being run to answer. After every fetch the
client asks whether what arrived collides with the work in progress _here_ —
including uncommitted work, which is the normal state of an agent mid-task and
the case a plain merge check cannot see.

```
{"event":"collides","ref":"refs/heads/main","paths":["src/index.ts"]}
```

Reported when it **changes**, not on every event: a collision that is still
there is still true, but a channel that repeats itself is a channel that stops
being read.

## Take it, but only when there is nothing to lose

`--ff-on-clean` is the exception to everything above, and it is off unless you
ask for it.

```sh
bunx @zabaca/agentgit watch --ff-on-clean
```

The problem it solves is not speed. A branch with a commit of its own **cannot**
be fast-forwarded onto the ref that moved — `git merge --ff-only origin/main`
fails by definition the moment you have diverged, which is every branch anybody
is working on. So the merge is made first, in the object database: `merge-tree`
writes the merged tree and `commit-tree` wraps it with your HEAD and the remote
ref as its parents. Your HEAD is then an ancestor of that commit, which makes
taking it a fast-forward — a ref update and a checkout, with no merge algorithm
running over your files and no conflict possible half way through. It is the
same technique `agentgit accept` uses on the Signer List, for the same reason.

A clone that is merely behind does not get one of those: git fast-forwards that
by itself, and making a merge commit for it would leave you permanently ahead of
origin by a commit nobody else holds, once per push. The commit is built only
when your branch has actually diverged, and the event says which happened.

Four things stop it, and it says which:

| | |
| --------------- | ------------------------------------------------------------------------------------- |
| already merged  | nothing is done, so an unrelated push does not leave an empty merge commit behind.      |
| **another branch** | held. This moves HEAD, so a checkout on `feature` is never moved on `main`'s behalf. |
| **uncommitted work** | held. A fast-forward still checks files out, and work in progress is yours to keep. |
| conflicts       | held. Whose change survives is a decision about intent, and `collides` already said so. |
| git refused     | held, with git's reason — an untracked file the merge would have overwritten, usually.  |

Untracked files do not count as uncommitted work. An agent's scratch output
would otherwise hold this off for a whole session, and the risk is already
covered: git refuses a checkout that would overwrite an untracked file, so that
case arrives as `held` rather than as lost work.

```
{"event":"fast-forwarded","ref":"refs/heads/main","commit":"a1b2c3d4…","synthesized":false}
{"event":"held","ref":"refs/heads/main","reason":"dirty","paths":["src/index.ts"]}
{"event":"held","ref":"refs/heads/main","reason":"elsewhere","head":"refs/heads/feature"}
```

`synthesized` says whether a merge commit had to be made: `false` is an ordinary
fast-forward onto the ref itself, `true` means your branch had diverged.

The merge commit it makes is yours, authored with the identity git already has
for you. On a machine that was never `git config`ured — a container an agent
runs in, typically — git would refuse to write a commit at all, so that one
falls back to `agentgit <agentgit@localhost>` rather than declining to take the
work.

## Options

| flag                |                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `--once`            | exit 0 after the first ref moves. The handoff primitive: block until the other agent pushes.                |
| `--on '<cmd>'`      | run a shell command in the clone after a fetch. `$AGENTGIT_REPO`, `$AGENTGIT_REF`, `$AGENTGIT_SHA` are set. |
| `--json`            | one JSON object per line. Parse this, not the prose.                                                        |
| `--ref <ref>`       | a full ref name, repeatable. Default: the branch you are on.                                                |
| `--all-refs`        | every ref in the repository.                                                                                |
| `--no-fetch`        | report what moved; do not fetch.                                                                            |
| `--ff-on-clean`     | take the new commits when the tree is clean. The one mode that moves your branch; off by default.           |
| `<repo>=<dir>`      | several checkouts on one socket.                                                                            |
| `--host`, `--token` | a deployment the remote does not name, or one that needs a credential.                                      |

`$AGENTGIT_HOST` and `$AGENTGIT_TOKEN` are read where the flags are absent. An
exported-but-empty variable is read as unset — `AGENTGIT_TOKEN=` is not a
credential, and `env -u AGENTGIT_TOKEN agentgit watch` is how you present no
header — and an empty flag value (`--host ''`) is refused rather than
carried along as a host nobody can reach.

## Examples

```sh
agentgit watch                        # in a clone: everything is inferred
agentgit watch --once                 # block until the other agent pushes
agentgit watch --on 'bun test'        # and run the suite when it lands
agentgit watch a=../a b=../b          # one socket, several checkouts
agentgit watch --json | jq -r .event  # for something that is not a person
agentgit accept fix-auth              # merge a Proposal and push the branch
agentgit watch --proposals            # …and hear about Proposals as they arrive
```

## Accepting a Proposal

An agent that may *read* a repository but is not on its **Signer List** hands
work over by pushing a **Proposal** — a ref naming the commit it wants in a
branch:

```sh
git push --signed=if-asked origin HEAD:refs/walgit/proposals/main/fix-auth
```

A Signer accepts it from a clean tree, standing on the branch it targets:

```sh
agentgit accept fix-auth
```

That is a fetch, a merge and a signed push of the branch, and nothing else. The
host never accepts: there is no merge endpoint, because a ref the host moved
would be a write with no push certificate behind it. A Proposal is *merged* when
its commit is an ancestor of the branch — so this never squashes and never
rebases, since neither would satisfy that definition.

It refuses rather than guesses:

- a dirty working tree, **before** it asks the host anything;
- an id the repository does not hold — the error names it, and lists what is
  there;
- a Proposal targeting a branch you are not on, naming both;
- a conflict, leaving the tree exactly as git left it, for you to resolve and
  push yourself.

Accepting one that is already merged does nothing and exits 0.

### Watching for them

`--proposals` adds the Proposals aimed at the branch you are watching to the
same socket. It is **opt-in**, and stays that way: the default watch exists to
keep a branch current, and a stranger's commit must never reach a working
agent's clone.

```sh
agentgit watch --proposals --json     # report them as they arrive
agentgit watch --proposals --once     # block until the other agent proposes
```

Two lines beyond the ordinary ones:

- `proposal` — a Proposal appeared or moved: `id`, `target`, `sha`, and
  `pusher` (its fingerprint, read from `GET /<name>.git/proposals`, `null`
  where that read cannot be made).
- `merged` — the branch's own ref event named it: `id`, `target`, `sha`.

Neither ever fetches: a Proposal reaches your tree through `agentgit accept`
and no other way. `--proposals` cannot be combined with `--all-refs`, which has
no branch for a Proposal to target.

## Private repositories

A walgit repository carrying a **Reader List** refuses every read — clone,
fetch, provenance, watch — until a listed key, or one of the repository's
Signers, signs the host's challenge. There is no account and no token; the
proof is a signature by the key git already signs pushes with.

It refuses *your own* pushes too. A push starts by asking for
`info/refs?service=git-receive-pack`, which hands over every ref and oid, so it
is a read like any other — and git does not relay the refusal, it asks for a
username: `fatal: could not read Username for 'https://agentgit.co'`.
Set the helper up **before** you write a `readers` file, not after.

Turn it on once, in a clone or by naming the host:

```sh
agentgit setup                        # takes the host from the clone's remote
agentgit setup agentgit.co    # or name it; --local writes it in the clone
```

That writes one line of git config:

```
git config --global credential.https://agentgit.co.helper '!agentgit credential'
```

After it, `git clone`, `git fetch`, `git push` and `agentgit watch` need nothing
typed. What happens on each read is:

1. git asks this client for a credential for the host;
2. the client fetches the host's nonce from `GET /_walgit/challenge` — never
   from the `WWW-Authenticate` header, because only git ≥ 2.42 forwards that to
   a helper;
3. it signs the nonce with `ssh-keygen -Y sign -n walgit-read` using
   `user.signingkey`, and answers with the key's `SHA256:` fingerprint as the
   username and the signature as the password.

The key is the one git signs pushes with, so a repository you can push to is one
you can read:

```sh
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519
```

`agentgit credential get|store|erase` is git's own protocol and is not meant to
be typed. `store` and `erase` do nothing: a signature is proof of a key, not a
secret to keep, so there is nothing on disk to leak or to revoke. A challenge
stands for five minutes and the previous one is still accepted, so a signature
that went stale mid-operation costs one extra 401 and a re-sign. Removing the
`readers` file makes the repository world-readable again; nothing is
retroactive in either direction.

## Use from an agent

An agent finds a tool through the registry its harness already reads, not by
being told a one-liner. That registry entry is now a **URL on the host**, so
there is nothing to install and nothing to spawn:

```sh
claude mcp add --transport http agentgit https://agentgit.co/_walgit/mcp
```

```sh
claude plugin marketplace add Zabaca/zbc && claude plugin install agentgit@zbc
```

It used to be a stdio server this package started (`npx -y @zabaca/agentgit
mcp`), and both ways it failed to connect were spawn problems rather than
protocol ones: a cold npx cache racing the client's startup timeout, and a
workspace checkout resolving the unlinked package. A URL has neither.

The first registers the endpoint alone. The second adds it *and* the `agentgit`
skill — push-to-create, claiming a name with a Signer List, Reader Lists,
Proposals, accepting one, watching, and the credential helper, each with the
command the host's own manual states (a test asserts they cannot drift apart).

The endpoint offers `agentgit_status` (does a name exist, is it claimed, is it
private, what are its refs), `agentgit_watch` (the handoff: block until a ref
moves, answer `{ ref, sha }` or `{ timedOut: true }`, capped at five minutes per
call) and `agentgit_provenance` (which key signed the push that moved a ref),
and serves the host's `llms.txt` as the `agentgit://manual` resource.

**It carries only what the host can answer without your disk.** Accepting a
Proposal, configuring the credential helper and fetching into a clone stay
commands in this CLI and in the skill, because they act on a tree the host
cannot see — a tool that pretended otherwise could only fail.

## There is still no SDK

The service's strongest line is that it has no client library, and that stays
true: the protocol is one socket and one JSON message, and everything here is a
convenience over it. The four lines this replaces are printed at
`https://<host>/llms.txt`, along with the `git merge-tree` and `git stash
create` invocations the collision check runs, so nothing here is a black box and
nothing about the host depends on it.

## Requirements

Node 22+ or Bun, and `git` on `PATH`. No dependencies.

MIT.
