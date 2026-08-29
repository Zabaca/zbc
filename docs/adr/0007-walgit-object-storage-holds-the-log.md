# walgit: object storage holds the write-ahead log, and the git repo on disk is a cache

**Status:** accepted (2026-08-20) — design settled, implementation through Milestone 4 (compaction and orphan collection)

`walgit` is an app template: a git host where **object storage holds the
write-ahead log and is the source of truth, and the bare repo on local disk is a
disposable cache that can be deleted at any time and rebuilt from the log.**
Every other decision here is a consequence of that sentence; where one conflicts
with it, the sentence wins.

It is a clean-room build from the design Cursor describes publicly in
["Git at any scale"](https://cursor.com/blog/git-at-any-scale) — there is no repo
to vendor from. Copied: WAL-in-object-store as source of truth, disk-as-cache,
CAS-serialized index, primary-only compaction, vanilla git on local disk.
Deliberately skipped for v0: rendezvous hashing, gossip replication,
multi-replica reads, protobuf WAL index.

## Why it earns a template

Per [`CONTEXT.md`](../../CONTEXT.md)'s app-template bar: AI software companies
run many parallel agent sessions, each with a working repo, and today that repo
is pinned to whichever node holds the disk — so a node dying loses session state,
idling still pays for a warm disk, and resuming elsewhere means moving the
working directory. That is a general problem for the category, not a Zabaca one.

## Shape

```
repos/{repo_id}/
  index.json                      # source of truth: seq, entries, refs, compaction_frontier
  wal/{seq:012d}-{ulid}.pack      # one push (or one compaction)
  wal/{seq:012d}-{ulid}.idx
```

Refs live in `index.json`, not in a database. That is the point — there is no
relational store to operate.

A push is two-phase: `pre-receive` uploads the packfile (uploading does not
publish it), then `reference-transaction` at the `prepared` phase writes the new
`index.json` under a conditional PUT. CAS wins → exit 0 → git commits the ref
locally → the push is acknowledged. CAS loses → exit non-zero → git aborts the
ref transaction → the push is rejected. **A push is never acknowledged before it
is persisted**, which is the entire value proposition.

## Decisions, and what settled them

Measurements: [`docs/research/walgit-m0-spike/`](../research/walgit-m0-spike/).

- **Conditional-PUT CAS on object storage, not a Durable Object.** The original
  design offered both, and a DO looked better — single-writer by construction,
  no retries. SSH removes the option: it forces compute off Cloudflare
  ([ADR-0006](./0006-fly-returns-as-a-deploy-module.md)), and there are no DOs
  elsewhere. CAS was then verified on R2: 16 concurrent writers against one
  ETag produced exactly one 200 and fifteen clean 412s, with no torn writes.
- **R2 stays the store even though compute is on Fly.** Zero egress makes the
  cross-provider hop free, and one authoritative location per bucket means there
  is no cross-region consistency question to get wrong. All access goes through
  one adapter interface, so S3/MinIO/Tigris remain swappable — with the caveat
  that Tigris only evaluates conditional writes safely on Multi-region or
  Single-region buckets.
- **The `.idx` is uploaded alongside the `.pack`.** `receive-pack` already
  builds it, so this trades bandwidth for CPU on the restoring node, which is
  the cost-sensitive one.
- **Orphan WAL entries are a first-class category.** Rejecting at
  `reference-transaction` does *not* roll back git's object migration — the
  quarantine is merged as soon as `pre-receive` passes, and only the ref aborts.
  So a pack uploaded for a push that then loses CAS stays in object storage,
  correctly unpublished but real. It needs a GC path alongside compaction's,
  and it shares that path's one safety mechanism: an object is deleted only
  after it has been provably unreferenced for longer than the slowest restore
  could take. The source design does not mention this.
- **Restore latency is two numbers, not one.** "Cold materialize under 2 s" was
  written for an always-on NVMe node. With `min_machines_running = 0`, machine
  wake spends ~1.35 s before materialize starts. Gate wake and materialize
  separately or a regression cannot be attributed. The target is also a control
  loop rather than a pass/fail: exceeding it means the WAL is replaying too many
  entries, and the knob is the compaction threshold.

## Consequences

- **SSH is the human transport, smart-HTTP the machine one.** ~~Both hang off
  the same hooks, so serving both costs nothing structurally.~~ **Reversed by
  [ADR-0008](./0008-walgit-runs-on-a-cloudflare-container-without-ssh.md)**:
  smart-HTTP is the only transport, and walgit runs on a Cloudflare Container
  with no dedicated IPv4 and no SSH. The CAS decision above is unaffected — it
  was verified on R2 and does not depend on where compute runs.
- **A CAS loss is not a clean rejection.** The client sees exit 128 with
  `fatal: ref updates aborted by hook` followed by an abrupt disconnect,
  indistinguishable from a network failure. Retry-on-contention must therefore
  live server-side; it cannot key off a client-visible status.
- **Idle GC is nearly free** — `min_machines_running = 0` is the mechanism, so
  the milestone that was going to build it mostly disappears. The corollary is
  that materialize is the *normal* path rather than disaster recovery, and gets
  exercised continuously instead of only in a crisis.
- **One class-A operation per push.** Cheap on R2, but batching several pushes
  into one index write is the known optimisation, deliberately deferred. The
  adapter keeps the seam for it.
