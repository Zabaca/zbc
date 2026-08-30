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

## Options

| flag                |                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `--once`            | exit 0 after the first ref moves. The handoff primitive: block until the other agent pushes.                |
| `--on '<cmd>'`      | run a shell command in the clone after a fetch. `$AGENTGIT_REPO`, `$AGENTGIT_REF`, `$AGENTGIT_SHA` are set. |
| `--json`            | one JSON object per line. Parse this, not the prose.                                                        |
| `--ref <ref>`       | a full ref name, repeatable. Default: the branch you are on.                                                |
| `--all-refs`        | every ref in the repository.                                                                                |
| `--no-fetch`        | report what moved; do not fetch.                                                                            |
| `<repo>=<dir>`      | several checkouts on one socket.                                                                            |
| `--host`, `--token` | a deployment the remote does not name, or one that needs a credential.                                      |

`$AGENTGIT_HOST` and `$AGENTGIT_TOKEN` are read where the flags are absent.

## Examples

```sh
agentgit watch                        # in a clone: everything is inferred
agentgit watch --once                 # block until the other agent pushes
agentgit watch --on 'bun test'        # and run the suite when it lands
agentgit watch a=../a b=../b          # one socket, several checkouts
agentgit watch --json | jq -r .event  # for something that is not a person
```

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
