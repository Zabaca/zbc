# walgit

A git host where **object storage holds the write-ahead log and is the source of
truth, and the bare repo on local disk is a disposable cache** that can be
deleted at any time and rebuilt from the log. See
`docs/adr/0007-walgit-object-storage-holds-the-log.md` in the zbc repository.

## What works today

The **front door**, the **storage layer**, the **push path** that joins them, and
the **garbage collection** that keeps the log from growing without bound:

| | |
| --- | --- |
| `src/store.ts`, `src/wal-index.ts` | the object-store adapter and the `index.json` compare-and-swap |
| `src/repo.ts` | repo addressing — the one place a client-supplied name becomes a path |
| `src/ssh-shell.ts` | the SSH forced command: one git verb, one repository |
| `src/http.ts`, `src/git-backend.ts`, `src/server.ts` | smart-HTTP, with `git http-backend` as a CGI child |
| `src/push.ts`, `src/hooks.ts`, `src/hook-main.ts` | the push path: upload at `pre-receive`, publish under CAS at `reference-transaction` |
| `src/reconcile.ts`, `src/sync.ts` | force the local cache to match the log, on every access |
| `src/orphans.ts` | the packs a rejected push leaves behind, found by diffing the log |
| `src/materialize.ts` | rebuild a repo from the log alone, on a disk that holds nothing |
| `src/compact.ts` | collapse the log to one entry, under a per-repo lease |
| `src/gc.ts` | delete superseded and orphaned objects, a grace period later |

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
no write on the push path, and `collectGarbage` reclaims them once they are old
enough to be certainly dead.

**A push is refused outright when no object store is configured.** Accepting one
that cannot reach the log is the single failure this design exists to prevent.

## Cold materialize

Given a `repo_id` and an empty disk, the log is sufficient. `src/materialize.ts`
runs `git init --bare`, downloads every WAL entry above `compaction_frontier` in
seq order, drops each `.pack`/`.idx` pair straight into `objects/pack/`, and
writes `packed-refs` from `index.json.refs` in one shot.

**It is not disaster recovery — it is the normal path.** The machine runs
`min_machines_running = 0`, so an idle repo loses its disk routinely and the
next access rebuilds it. The restore path is therefore exercised continuously
rather than only in a crisis.

`src/sync.ts` decides which of the two repairs an access needs, and a warm disk
pays for neither:

- refs disagree but the objects are present → **reconcile**, one `packed-refs`
  write;
- an object is absent → **materialize**. `reconcile` reporting a ref it will not
  write is exactly the signal that the WAL has to be replayed. A cold disk is
  only the extreme of this case.

Three things are load-bearing. Entries at or below `compaction_frontier` are
never requested — they are superseded, and fetching them is latency spent on
bytes the repo already has. The `.idx` uploaded beside each pack is placed as
it is, never rebuilt, because `git index-pack` over every entry is the dominant
cost of a naive restore. And `git fsck` does not run on this path: the pack's
own sha256 is checked against the log instead, which catches a truncated
download at a cost proportional to bytes already transferred.

A materialize takes a `mkdir` lock, so two fetches arriving at a cold repo
rebuild it once rather than twice; and it leaves a `walgit-materializing`
marker for its duration, so an interrupted restore is detectable rather than
reading as a valid-but-truncated repo.

### What it costs

Measured with `bun run bench:materialize` (macOS arm64, `FileStore` on local
disk, 15 runs per size). Replay only — **machine wake is not in these numbers**.
Each size is measured twice: over the raw log, and over the same repository
after compaction.

| WAL entries | raw p50 | raw p99 | compacted p50 | entries replayed |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 36 ms | 41 ms | 36 ms | 1 |
| 10 | 40 ms | 43 ms | 35 ms | 1 |
| 50 | 57 ms | 65 ms | 36 ms | 1 |
| 200 | 125 ms | 134 ms | 36 ms | 1 |

The right-hand column is the point: raw restore is linear in push count, and a
compacted restore at 200 pushes is indistinguishable from one at 20, because it
replays one entry either way.

Deliberately **two numbers, not one**. The design's "cold materialize under two
seconds" was written for an always-on NVMe node; on Fly a client also pays
machine wake, measured at ~1.35 s in the milestone-0 spike. Gate them
separately or a regression cannot be attributed to either half.

The materialize number is a **control loop, not a pass/fail gate**: it is linear
in entry count, so exceeding the target means the WAL is replaying too many
entries and the knob is the compaction threshold — not this code. A real bucket
adds one round trip per entry on top, which moves the knob but not the shape.

## Compaction

Restore replays every entry above `compaction_frontier`, so without compaction
restore latency grows linearly with the number of pushes a repository has ever
taken — and a cache you cannot cheaply rebuild is a disk you cannot afford to
lose. `src/compact.ts` runs `git repack -adf`, uploads the single resulting pack
as one WAL entry with `kind: "compaction"` and `supersedes_through`, and CASes
the frontier forward.

It is a **repack, never a rewrite**. The pack contains exactly what is reachable
from the refs `index.json` already publishes, so `refs` is carried through
untouched and a restore from an index snapshotted before the compaction, and one
from the index after it, produce byte-identical history.

Three things make it safe:

- **A lease, not optimism.** `repos/{id}/compaction.lease` is taken under a
  compare-and-swap and expires, so a machine Fly stops mid-repack cannot wedge
  compaction for that repository forever. Two nodes repacking at once would both
  upload a full copy and the loser's CAS would tombstone entries the winner's
  pack does not contain.
- **The repo is materialized first.** `repack` packs what is on disk; repacking
  a partially restored cache would publish a pack missing objects the log says
  exist, and the frontier advance would make that loss permanent.
- **Superseded entries are tombstoned, never deleted.** See below.

Triggered from `post-receive` — after the refs have moved and the push is
durable, so it cannot cost correctness — and handed to a **detached process**,
so it cannot cost latency either. `WALGIT_COMPACTION_THRESHOLD` (default 50) is
how many un-superseded entries a repository may accumulate first.

## Collecting garbage

`src/gc.ts` is the only place walgit deletes anything, and both kinds of garbage
go through the same guard: **nothing is removed until it has been provably
unreferenced for longer than the slowest restore could take.**

A compaction's compare-and-swap is instantaneous; a restore that read
`index.json` a moment earlier is not, and is still downloading the entries that
CAS just superseded. So the CAS records a **tombstone** — the key, the entry
that superseded it, and a `collect_after` instant — and deletion happens later,
out of band. `WALGIT_GC_GRACE_MS` (default one hour) is that delay.

Orphans are dated from the **ULID in their own key**, which needs no store
metadata call and no per-object bookkeeping: an object uploaded seconds ago may
belong to a push whose `pre-receive` has run and whose CAS has not, and
collecting it would corrupt a push that is about to succeed. A key whose age
cannot be read is held forever rather than guessed at.

Tombstones are cleared from `index.json` **before** the objects are deleted, so
a crash between the two leaves an orphan — which the same function reclaims on
its next run. The reverse order would leave `index.json` naming an object that
is gone, which is a broken repository rather than a recoverable one.

The asymmetry throughout: over-retaining costs storage, under-retaining loses
data with no error anywhere.

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
with a stand-in for `ssh` itself — a cold-materialize suite that builds a repo
with 100 pushes across 5 branches and 3 tags, deletes its disk, and asserts the
rebuilt repo matches a reference clone on refs, reachable history and `git
fsck`, a compaction suite that repacks a 40-push log and asserts history is
identical restored from before, during and after — that the grace period, and
nothing else, is what lets a pre-compaction restore still succeed — and a
fault-injection suite that kills the
push path at each of its steps (`WALGIT_FAULT`, test-only) and asserts the
invariant every time: either the client saw a rejection, or the commit is
durably in the log. Never neither.

### The seven-scenario verification suite

```bash
bun run e2e
```

The unit and integration suites above check each guarantee where it is
implemented. `e2e/` checks all seven of the design's acceptance scenarios in one
place, against a walgit node running as a **separate process** — so `kill -9`
is a real `SIGKILL` to a real process group rather than an unawaited promise,
and "a fresh node" is a server with an empty disk rather than a cleared
variable. It runs against a local `FileStore` by default and against a real
bucket when `WALGIT_S3_*` is set, with no other change.

It runs per-PR in `.github/workflows/walgit-e2e.yml`, and nightly against a
bucket. Scenario 7 gates cold-restore latency against a committed baseline and
fails the build on a breach. See [`e2e/README.md`](./e2e/README.md).
