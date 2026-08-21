# walgit Milestone 0 — spike results

Measured 2026-08-20 against real services, not documentation: Fly org `personal`,
Cloudflare R2 account `99a19e58…`, git 2.52.0, bun 1.3.14, flyctl on macOS.
Every number below came from a run in this directory; the scripts are here so
they can be re-run.

**walgit** is a proposed app template: a WAL-backed git host where object storage
holds the write-ahead log and is the source of truth, and the bare repo on local
disk is a disposable cache rebuildable from the log. Milestone 0 exists to answer
the questions that would force a redesign, before Milestone 2 writes the push
path.

## Verdict

**Option A — conditional-PUT CAS on object storage — is confirmed viable and is
now the only option.** SSH is required (it is core to git's identity for our
users), and no Cloudflare product delivers raw TCP into a Worker or Container
outside a private beta, so compute cannot live on Cloudflare. That removes
Durable Objects, and with them Option B (a DO as index authority). R2 remains the
WAL store regardless of where compute runs — its zero egress makes the
cross-provider hop free.

## 1. Fly Proxy autostarts a stopped machine on a raw TCP connection

The documented unknown: Fly's autostop/autostart reference describes HTTP
`soft_limit` throughout and never mentions TCP. Undocumented is not unsupported,
but this decides the idle cost model — walgit's whole premise is many mostly-idle
repos.

**Answer: yes.** Config is `flyapp/fly.toml` — a service with `protocol = "tcp"`,
**no `handlers`** (that is what makes it raw pass-through),
`auto_start_machines = true`, `min_machines_running = 0`.

| | latency to first byte |
| --- | --- |
| warm (machine `started`) | 67, 74, 76, 85 ms |
| **cold (`stopped` → autostart)** | **1302, 1360, 1400, 1416 ms** |

Machine state was verified `stopped` before each cold sample and `started`
after. Cold wake is ~1.35 s and unusually consistent.

Ingress notes:

- **A dedicated IPv4 is required for any port that is not 80/443** ($2/mo).
  Shared IPv4 is 80/443 only.
- Dedicated IPv6 is free but was **unreachable from the operator's network** —
  `No route to host` at 20 ms, i.e. local routing, not Fly, and general IPv6
  egress worked fine. Do not design for v6-only ingress.
- **One IP serves every repo.** SSH has no SNI, so the repository is named in the
  command (`git@host:repo_id.git`), not the address. The $2 is a total, not a
  per-repo cost.

## 2. R2 conditional PUT (compare-and-swap) via the S3 API

Load-bearing: with no Durable Object, this is the only serialization mechanism
for `index.json`. Client is `aws4fetch` against
`https://<account>.r2.cloudflarestorage.com`. Script: `test2-r2-cas.ts`.

| case | result |
| --- | --- |
| `If-None-Match: *` on absent key | 200 — creates |
| `If-None-Match: *` on existing key | 412 |
| `If-Match: <current etag>` | 200, ETag changes |
| `If-Match: <stale etag>` | 412, **stored value unchanged** |
| conditional GET with `If-None-Match: <current>` | **304** |
| **16 concurrent writers, same ETag** | **1 × 200, 15 × 412, 0 other** |

Exactly one winner, every loser a clean 412, no torn writes, no surprise status
codes. The 304 is the read path: a replica checks whether it is current for the
cost of a metadata round trip. Milestone 1's fuzz criterion passed at n=16 on the
first attempt; run it at n=100 there.

Note for a future Tigris comparison: Tigris supports the same headers, but
conditional operations evaluate within the bucket's location type. Only
**Multi-region** and **Single-region** buckets are safe for cross-region CAS;
**Global** and **Dual-region** are strong same-region and eventual cross-region,
and a sub-second replication window is exactly wide enough to lose a push race
and never reproduce it. R2 has one authoritative location per bucket, so the
question does not arise there.

## 3. `receive.unpackLimit=0`, quarantine layout, and hook ordering

Script: `test3-git-quarantine.sh` (pure local git, no cloud).

A bare repo with `receive.unpackLimit=0` retained a 3-object push as a packfile —
`loose=0 packs=1`. Confirmed.

Hook order, observed:

```
pre-receive
reference-transaction  prepared
reference-transaction  committed        (or: aborted)
```

`reference-transaction` receives `<old-oid> SP <new-oid> SP <refname>` on stdin.
**Exiting non-zero at `prepared` aborts the ref update** — the server ref stayed
at its previous value. This is the mechanism the two-phase commit depends on, and
it works.

### Corrections to the design

1. **The quarantine directory is `objects/tmp_objdir-incoming-XXXXXX`**, not
   `objects/incoming-XXXX`. Both `GIT_QUARANTINE_PATH` and
   `GIT_OBJECT_DIRECTORY` point at it.

2. **It contains `.pack`, `.idx`, `.rev` and `.keep`.** receive-pack builds the
   index itself, which confirms that uploading the `.idx` alongside the `.pack`
   costs no extra CPU on the pushing node — the reason for preferring bandwidth
   over `git index-pack` on restore. Consider uploading `.rev` on the same
   argument. **Never upload `.keep`** — it is local bookkeeping that tells git
   not to repack the pack.

### A behaviour the design does not account for

**Rejecting at `reference-transaction` does not roll back the object migration.**
The quarantine is migrated into the main object store as soon as `pre-receive`
passes; only the ref update aborts. Measured: one successful push plus two
rejected pushes left **3 packs and 12 objects, of which 3 were reachable**.

Two consequences:

- A WAL entry uploaded during `pre-receive` for a push that later loses CAS
  becomes an **orphan object in object storage**. It is correctly *unpublished* —
  nothing in `index.json` references it — but it needs a GC path, and the design
  as written never mentions orphan WAL entries.
- The local repo gains one pack per rejected push. Unreferenced and gc-able, but
  a hot contended repo grows.

### The rejection the client sees is not clean

The design predicts "a normal non-fast-forward-style rejection". What the client
actually gets is exit code **128** and:

```
fatal: ref updates aborted by hook
send-pack: unexpected disconnect while reading sideband packet
fatal: the remote end hung up unexpectedly
```

That is an abrupt disconnect, hard for a client to tell apart from a network
failure. If pushes are meant to retry on CAS loss, the retry cannot key off a
clean status — either it lives server-side, or the client needs a wrapper.

## 4. Cold path budget — partial

The machine-start half is measured: **~1.35 s**. The materialize half needs a
real WAL in object storage and is Milestone 3 work.

The "cold materialize in under 2 seconds" target was written for an always-on
NVMe node. On Fly with `min_machines_running = 0`, autostart alone spends ~1.35 s
of it, leaving ~650 ms to download and place packs and write `packed-refs`.
**Restate the target as two numbers** — machine wake and materialize — and gate
each separately, rather than one figure that hides which half regressed.

## Reproducing

```bash
# 3 — git only, no credentials
bash test3-git-quarantine.sh

# 2 — needs R2 S3 credentials
export R2_KEY=… R2_SECRET=…
bun add aws4fetch && bun run test2-r2-cas.ts

# 1 — needs a Fly token
export FLY_API_TOKEN=…
cd flyapp
fly apps create walgit-spike --org personal
fly ips allocate-v4 -a walgit-spike --yes      # $2/mo; v6 is free but see §1
fly deploy --local-only --ha=false -a walgit-spike
fly machines stop <id> -a walgit-spike
# then connect to <ip>:2222 and time the first byte
```

## Standing costs

`walgit-spike` is left deployed as the base for Milestones 2–3. It carries a
**dedicated IPv4 at $2/month**; machine seconds are negligible at
`shared-cpu-1x`/256 MB with `min_machines_running = 0`. The R2 test objects under
`zbc-warehouse/_walgit-spike/` were deleted. Tear down with
`fly apps destroy walgit-spike`.
