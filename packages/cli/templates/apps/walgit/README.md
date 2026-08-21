# walgit

A git host where **object storage holds the write-ahead log and is the source of
truth, and the bare repo on local disk is a disposable cache** that can be
deleted at any time and rebuilt from the log. See
`docs/adr/0007-walgit-object-storage-holds-the-log.md` in the zbc repository.

## What works today

The **front door**, the **storage layer**, and the **push path** that joins them:

| | |
| --- | --- |
| `src/store.ts`, `src/wal-index.ts` | the object-store adapter and the `index.json` compare-and-swap |
| `src/repo.ts` | repo addressing — the one place a client-supplied name becomes a path |
| `src/ssh-shell.ts` | the SSH forced command: one git verb, one repository |
| `src/http.ts`, `src/git-backend.ts`, `src/server.ts` | smart-HTTP, with `git http-backend` as a CGI child |
| `src/push.ts`, `src/hooks.ts`, `src/hook-main.ts` | the push path: upload at `pre-receive`, publish under CAS at `reference-transaction` |
| `src/reconcile.ts`, `src/sync.ts` | force the local cache to match the log, on every access |
| `src/orphans.ts` | the packs a rejected push leaves behind, found by diffing the log |

Restoring a repo whose disk is gone is the next milestone: today a node serves
what it has, reconciled against the log, and reports a ref whose objects it
lacks rather than pretending to hold it.

## The push path

A push is persisted before it is acknowledged, and never the other way round:

1. **`pre-receive`** — the pushed objects are in `$GIT_QUARANTINE_PATH`, visible
   to nobody. The packfile (and its `.idx`; never the `.keep`) is uploaded to
   `repos/{id}/wal/{seq:012d}-{ulid}.pack`. This does **not** publish it —
   `index.json` is untouched, so a crash here leaves an unreferenced object and
   a client that saw a failure.
2. **`reference-transaction prepared`** — git has the ref update staged but not
   committed. `index.json` is rewritten under compare-and-swap, with the
   uploaded entry appended and the ref changes applied. Winning is what makes
   the push real. Losing exits non-zero, git aborts the transaction, and the
   client is rejected.

Retry lives in the hook, not in `commitIndex`, and every attempt re-checks that
each ref this push updates still holds the old oid git computed against. A CAS
loss is server-invisible to the client — it arrives as `fatal: ref updates
aborted by hook` followed by a disconnect, indistinguishable from a network
failure — which is why retry cannot be left to the client.

Every rejected push leaves an uploaded pack behind. That is the correct trade
(the alternative is publishing before persisting) and it is not lost:
`findOrphans` recovers them by diffing the WAL prefix against `index.json`, with
no write on the push path. Reclaiming them is the compaction milestone's job.

**A push is refused outright when no object store is configured.** Accepting one
that cannot reach the log is the single failure this design exists to prevent.

## How a client reaches it

```bash
# SSH — the repository is named in the command, because SSH has no SNI
git clone git@<ip>:myrepo.git

# smart-HTTP — the token is sent as the Basic-auth password
git clone https://walgit:$WALGIT_TOKEN@<app>.fly.dev/myrepo.git
```

A repository is created on first contact: pushing to a name nobody has used
creates it, with `receive.unpackLimit=0` so even a tiny push is retained as a
packfile (what the WAL will upload).

## Deployment

Through the `fly` module, never by hand — `zbc apply <env>`. The instance must
set `ipv4: "dedicated"`: shared IPv4 covers ports 80/443 only, so SSH on :22
would be unreachable and `fly deploy` would still report success.

Secrets the app needs (in the environment's `secrets.yaml`):

- `WALGIT_SSH_HOST_KEY` — an ed25519 **private** key
  (`ssh-keygen -t ed25519 -f walgit_host -N ''`). It is a secret rather than a
  generated-at-boot file because the container filesystem does not survive a
  machine stop, and this machine stops whenever it is idle — a regenerated host
  key would trip every client's man-in-the-middle warning.
- `WALGIT_SSH_AUTHORIZED_KEYS` — newline-separated **public** keys. Each is
  written into `authorized_keys` pinned to the forced command.
- `WALGIT_HTTP_TOKENS` — comma-separated bearer tokens (comma-separated so a
  credential can be rotated without a window where neither works).
- `WALGIT_S3_ENDPOINT`, `WALGIT_S3_BUCKET`, `WALGIT_S3_ACCESS_KEY_ID`,
  `WALGIT_S3_SECRET_ACCESS_KEY` — the write-ahead log's home (the `r2` module
  instance and its S3-API credentials). Without them the host serves reads from
  its local cache and **refuses every push**. `WALGIT_STORE_DIR` substitutes a
  local directory for the bucket, which is for development and tests only.

The machine runs `min_machines_running = 0` and stops when idle; the next
connection autostarts it, measured at ~1.35 s in the milestone-0 spike
(`docs/research/walgit-m0-spike/`). There is **no Fly Volume** on purpose.

## Authorization, today

One trust boundary: any authorized SSH key or HTTP token can read and write any
repository. Per-repo authorization and an SSH CA are deferred until the repo
namespace exists in the WAL — the forced command and the `tokens` list are the
seams they plug into.

## Tests

```bash
bun test src
```

Includes end-to-end clone/push/fetch over both transports against a real `git`
client — smart-HTTP through a real server, SSH through the real forced command
with a stand-in for `ssh` itself — and a fault-injection suite that kills the
push path at each of its steps (`WALGIT_FAULT`, test-only) and asserts the
invariant every time: either the client saw a rejection, or the commit is
durably in the log. Never neither.
