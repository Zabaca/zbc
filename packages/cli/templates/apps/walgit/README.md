# walgit

A git host where **object storage holds the write-ahead log and is the source of
truth, and the bare repo on local disk is a disposable cache** that can be
deleted at any time and rebuilt from the log. See
`docs/adr/0007-walgit-object-storage-holds-the-log.md` in the zbc repository.

## What works today

The **front door**, the **storage layer**, the **push path** that joins them, and
the **garbage collection** that keeps the log from growing without bound.

walgit is one service in **three directories**, and the split is by runtime, not
by layer:

- **`src/`** — the container process. Runs under bun, touches the disk, runs git.
- **`worker/`** — the Cloudflare Worker. The two modules that genuinely need the
  Workers runtime, and nothing else.
- **`shared/`** — the runtime-neutral kernel. **`shared/` imports no runtime, and
  both halves may import it.** It is the only directory in both TypeScript
  programs (`tsconfig.json` and `tsconfig.worker.json`), which is what makes that
  rule something the build fails on rather than a comment. See
  `docs/adr/0010-walgit-shared-kernel.md` in the zbc repository.

|                                                      |                                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shared/protocol.ts`                                 | the wire contract: header names, internal paths, the smart-HTTP grammar, the repo-id and ref-name grammars, the zero oid, the refusal vocabulary |
| `shared/credentials.ts`                              | reading a credential off the wire: the two auth forms, the token list, the constant-time compare                                                 |
| `shared/policy.ts`                                   | reading a limit from the environment, and saying what it is — so the cap stated and the cap enforced are one number                              |
| `shared/events.ts`, `shared/outbox.ts`               | the ref-event protocol and the per-ref coalesce window that bounds a subscriber's message rate — every decision, pure                            |
| `shared/telemetry.ts`                                | classifying a request and a refusal into the datapoint the Worker writes                                                                         |
| `shared/landing.ts`                                  | the HTML page a browser gets at `/`, rendered from the limits actually configured                                                                |
| `shared/container-env.ts`                            | which of the Worker's variables the container is told about, and a fingerprint of them                                                           |
| `worker/index.ts`, `wrangler.jsonc`                  | the Cloudflare Worker that proxies to the container, and forwards its environment                                                                |
| `shared/ref-cache.ts`                                | the fan-out's derived, in-memory copy of ref state — bounded, never authoritative                                                                |
| `worker/events-do.ts`                                | the Durable Object that holds the ref-event sockets — a shell over `shared/events.ts`                                                            |
| `src/store.ts`, `src/wal-index.ts`                   | the object-store adapter and the `index.json` compare-and-swap                                                                                   |
| `src/keys.ts`                                        | the object-store key namespace: every prefix, every key builder, and the parse back out of one                                                   |
| `src/repo.ts`                                        | repo addressing — the one place a client-supplied name becomes a path. Pure: string in, path out                                                 |
| `src/cache.ts`                                       | provisioning the bare repo that path names: `git init`, the config walgit needs, the hooks                                                       |
| `src/http.ts`, `src/git-backend.ts`, `src/server.ts` | smart-HTTP, with `git http-backend` as a CGI child                                                                                               |
| `src/push.ts`, `src/hooks.ts`, `src/hook-main.ts`    | the push path: upload at `pre-receive`, publish under CAS at `reference-transaction`                                                             |
| `src/announce.ts`                                    | telling subscribers a push landed, from `post-receive` — after it is durable, and never able to fail it                                          |
| `src/pending.ts`                                     | the hand-off between the two hook processes of one push, keyed by `git-receive-pack` pid                                                         |
| `src/reconcile.ts`, `src/sync.ts`                    | force the local cache to match the log, on every access                                                                                          |
| `src/orphans.ts`                                     | the packs a rejected push leaves behind, found by diffing the log                                                                                |
| `src/materialize.ts`                                 | rebuild a repo from the log alone, on a disk that holds nothing                                                                                  |
| `src/compact.ts`                                     | collapse the log to one entry, under a per-repo lease                                                                                            |
| `src/gc.ts`                                          | delete superseded and orphaned objects, a grace period later                                                                                     |
| `src/delete-repo.ts`                                 | remove a whole repository: tombstone, wait, then index-first deletion                                                                            |
| `src/expire.ts`                                      | decide WHICH repositories go: idle since their last push, past the window                                                                        |
| `src/limits.ts`                                      | the push-size and repository-total caps, refused in `pre-receive` before anything is uploaded                                                    |
| `src/signers.ts`                                     | the Signer List a repository holds, resolved in `pre-receive` beside the size caps and re-asked at the publish                                   |
| `src/usage.ts`                                       | what the log says this service holds, folded out of the indexes                                                                                  |
| `src/instructions.ts`                                | the plain-text `GET /` — the whole API surface, rendered from the limits actually enforced                                                       |
| `src/verify.ts`, `src/cli.ts`                        | the operator CLI: inspect, rebuild, verify, reclaim                                                                                              |
| `src/git.ts`, `src/mkdir-lock.ts`                    | the two shared primitives: running a git plumbing command, and locking with `mkdir`                                                              |

## The operator CLI

```bash
walgit serve                          # run the git front end (smart-HTTP)
walgit materialize <repo_id> [path]   # rebuild a repo from the write-ahead log
walgit verify <repo_id> [path]        # check local state against index.json
walgit gc <repo_id...>                # reclaim superseded and orphaned objects (dry run)
walgit compact <repo_id> [path]       # repack the log into one entry, now
walgit delete <repo_id...>            # remove repositories entirely (dry run)
walgit usage [--since 24h] [--top 10] # what the log says this service holds
walgit expire [repo_id...]            # collect repos idle past the window (dry run)
```

`usage` is the one command that needs nothing but bucket credentials — no repos
directory, no local cache, no running node — because the log is already a usage
ledger: every entry carries a `size` and a `ts`, so repository count, bytes
stored, the largest repositories and push volume over time are all derivable
with no instrumentation and nothing to keep in sync. It is strictly read-only,
which matters because it is run at exactly the moment a command that also
repairs things would be dangerous. It reports **pushes and storage only** — a
clone leaves no trace in the log at all, and an approximation invented here
would read as a measurement.

### The other half: what the log cannot see

`usage` answers everything the log records. The gap is structural — a clone
writes nothing to it — so the Worker in front of the container counts the rest
and writes one Analytics Engine datapoint per request to the `walgit_requests`
dataset (`shared/telemetry.ts`, bound as `WALGIT_METRICS` in `wrangler.jsonc`).
Nothing is duplicated across the two: storage, repository count and push volume
come from the log only, because two records of one fact disagree the first time
a write fails between them.

Each datapoint carries, as blobs: `kind` (`clone-advertise`, `clone`,
`push-advertise`, `push`, `instructions`, `health`, `other`), `outcome`
(`ok`/`reject`), `reject`, `repo`, `temperature` (`cold`/`warm`), `answered`
(`container`/`edge`); and as doubles: `status`, `ttfb_ms`, `total_ms`,
`bytes_served`, `bytes_received`, `cold`. The index is `kind`, so refusals — the
rare thing an operator is hunting — are sampled independently of clones, the
loud thing.

Refusals are counted **by kind**, never as an error rate, because the kinds mean
different things: `size-cap` (abuse or a misconfigured client), `collision` (a
product signal about naming), `unauthorized`, `not-found`, `unavailable`, and
`edge`. `edge` is a **bug signal**: walgit refusing things itself, with an
explanation an agent can act on, is the product, so a refusal made in front of
it should be zero. It is detectable because the container stamps every response
it produces (`x-walgit-served`) and names its own refusals (`x-walgit-reject`);
both headers are stripped before the response reaches the client.

What is deliberately **not** recorded: no IP, no user agent, no credential, no
request or repository content. Repository names are recorded — every repository
on a public walgit is world-readable by construction, and without the name a
traffic spike cannot be told apart from a hundred quiet repositories.

The measurement is off the serving path: bytes and total time are counted in a
pass-through transform that forwards each chunk as it measures it, and the
datapoint is written under `waitUntil` after the client already has its
response. A deployment without the binding records nothing and serves exactly
as before.

Query it with the [Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/):

```sql
SELECT blob1 AS kind, blob3 AS reject, count() AS n, sum(double4) AS bytes_served
FROM walgit_requests WHERE timestamp > now() - INTERVAL '24' HOUR GROUP BY kind, reject
```

It runs where the app's environment is — inside the container, or anywhere the
same `WALGIT_*` variables are set:

```bash
bun src/cli.ts verify myrepo
```

**Credentials come from `src/store-env.ts`**, the same reader the server and both
hook processes use. There is deliberately no `~/.walgit/config`: a second configuration path is a second thing to be wrong
about, and it would drift from the one the app actually reads.

**Every command is a thin front over the functions the server calls** —
`materialize`, `reconcile`, `findOrphans`, `collectUsage`. That is what makes `verify`
trustworthy: a command-line reimplementation of "is this disk current?" would
answer for itself rather than for the server.

Exit codes are meant to be branched on: `0` success, `1` a divergence the
command was asked to detect, `2` misuse (unknown command, bad argument, missing
configuration).

`verify` is read-only, which is the whole point — `sync.ts` answers the same
question on every access and immediately repairs what it finds, so by the time
an operator asks, the evidence is gone. It reports four independent
disagreements, because they have different repairs: diverged refs (reconcile),
refs whose object this repo does not have (replay the WAL), WAL entries above
the frontier whose pack is absent, and a `walgit-materializing` marker — a
restore that died partway can leave refs that look perfect on a truncated repo.

`gc` reclaims both kinds of garbage — entries a compaction superseded, and the
packs rejected pushes leave behind. It **only reports unless given `--yes`**,
and it never collects an object younger than `--min-age` (default 60 minutes,
`WALGIT_GC_GRACE_MS`): the push path uploads a pack _before_ it publishes it, so
inside that window a perfectly good pack is indistinguishable from a rejected
one, and deleting it would fail a push that was about to succeed. The age comes
from the ULID in the key, so it costs no extra round trip — and an object whose
age cannot be read is left alone. There is no collect-everything mode: a `LIST`
of the whole bucket would name repos this node never served, and the blast
radius of a wrong guess is objects deleted from the source of truth.

`delete` removes repositories on purpose, which is why it is the most cautious
command here: it **only reports unless given `--yes`**, and even then the first
run does not delete — it writes a `deletion` marker into `index.json` and the
objects survive until `--grace` minutes have passed (default 60,
`WALGIT_DELETE_GRACE_MS`). A second run after that deadline collects. Asking
twice inside the window does not restart the clock, and deleting a repository
that is not there is a no-op rather than an error.

`compact` forces a compaction rather than waiting for
`WALGIT_COMPACTION_THRESHOLD` pushes to trigger one — for the repo whose restore
is already slow because its log is already long. It takes the same per-repo
lease the automatic path does, so forcing one while a node is mid-compaction
reports the holder instead of racing it. `--force=false` inverts it into a
question: it respects the threshold and says how far off the repo is, without
causing anything.

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

**It is not disaster recovery — it is the normal path.** The container sleeps
when idle and its disk is wiped completely on every restart, so an idle repo
loses its cache routinely and the next access rebuilds it. The restore path is
therefore exercised continuously rather than only in a crisis.

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
disk, 15 runs per size). Replay only — **cold start is not in these numbers**.
Each size is measured twice: over the raw log, and over the same repository
after compaction.

| WAL entries | raw p50 | raw p99 | compacted p50 | entries replayed |
| ----------: | ------: | ------: | ------------: | ---------------: |
|           1 |   36 ms |   41 ms |         36 ms |                1 |
|          10 |   40 ms |   43 ms |         35 ms |                1 |
|          50 |   57 ms |   65 ms |         36 ms |                1 |
|         200 |  125 ms |  134 ms |         36 ms |                1 |

The right-hand column is the point: raw restore is linear in push count, and a
compacted restore at 200 pushes is indistinguishable from one at 20, because it
replays one entry either way.

Deliberately **two numbers, not one**. The design's "cold materialize under two
seconds" was written for an always-on NVMe node; here a client also pays
container cold start, measured at a median of 1.77 s (spread 0.93–6.45 s) in the
Containers spike. Gate them separately or a regression cannot be attributed to either half.

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
  compare-and-swap and expires, so a container stopped mid-repack cannot wedge
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

## Deleting a repository

`src/delete-repo.ts` is the one thing that destroys data on purpose, and it
inherits the collector's discipline rather than inventing a faster one.

It is **deferred**: the first request tombstones the repository by writing a
`deletion` marker into `index.json`, and only a later call — past
`WALGIT_DELETE_GRACE_MS` — removes anything. A clone that read the index a
moment before the request is still downloading the packs it names, and the
grace period is what stops it being cut off mid-transfer. The knob is its own
rather than the collector's, because expiry and compaction have unrelated
timescales.

Collection then deletes **`index.json` first** and the objects it names second.
A crash between the two leaves objects that nothing references — exactly what
`findOrphans` discovers and `gc` reclaims — instead of an index naming an
object that is gone. The cached bare repo on disk goes last, because a cache
left behind is reclaimable and a half-deleted log is not.

Deciding _which_ repositories go — expiry — is not this file's business. It
takes a repo id.

## Expiring idle repositories

`src/expire.ts` is that decision, and on a free, world-writable instance it is
the **only** removal path — the reason refs can be append-only without storage
growing without bound. Nothing inside the window can be destroyed; everything
leaves at the end of it.

Idle means the time of the **last push**, never the last access:

- It is free. The newest WAL entry's `ts` is already in `index.json`, so the
  signal costs no write and no instrumentation.
- It cannot be gamed. A last-access would mean a write on every clone, through
  an endpoint deliberately left unauthenticated — a daily `git clone` from a
  cron job could pin any repository alive forever.

The window is `WALGIT_RETENTION_HOURS`, **the same variable `GET /` renders its
retention promise from**, so the page cannot claim a window the sweeper does not
enforce. Unset means expiry is off entirely, and `walgit expire` then says so and
does nothing — not even a `LIST`.

`decideExpiry` is pure and every branch it cannot prove resolves toward RETAIN:
an index with no entries is not "infinitely old", a timestamp that will not parse
is not "long ago", and one in the future is clock skew rather than staleness.
Over-retaining costs storage; under-retaining deletes somebody's work with no
error anywhere.

Collection is delegated to `delete-repo.ts`, so an expired repository is
tombstoned and collected a grace period later exactly like one deleted by hand.
Dry run is the default; `--yes` acts.

What runs it on a timer is the **deployment's** business. On Cloudflare that is
a Cron Trigger (`wrangler.jsonc` → `triggers.crons`, hourly) firing the Worker's
`scheduled` handler, which POSTs `/_walgit/expire` to the container and logs the
report. The timer lives out there rather than as an interval inside the
container because the container SLEEPS when idle — an internal timer would stop
firing at exactly the moment nothing is keeping it awake, which is precisely the
state a repository has to be in to be collectable.

That endpoint deletes repositories and the container is world-reachable, so it
is reachable only by the Worker: the request must carry `x-walgit-internal: 1`,
and the Worker STRIPS that header from every request it proxies from a client
before forwarding it. "The Worker asked" is therefore unforgeable from outside,
with no second credential invented for a service whose whole point is not having
one. Anything else gets the same 404 as any other unroutable path. An instance
with no `WALGIT_RETENTION_HOURS` exposes no sweep endpoint at all, so the cron
logs a 404 and collects nothing — correct for an instance that never promised a
retention window.

## How a client reaches it

```bash
# smart-HTTP is the only transport; the token is sent as the Basic-auth password
git clone https://walgit:$WALGIT_TOKEN@<worker-host>/myrepo.git
```

There is no SSH. It was removed when walgit moved onto a Cloudflare Container:
SSH needs raw inbound TCP, which is what put the app on a Fly machine with a
dedicated IPv4 in the first place ([ADR-0006](../../../../../docs/adr/0006-fly-returns-as-a-deploy-module.md)),
and no Cloudflare product delivers it. Every client that could hold a key can
hold a token.

A repository is created on first contact: pushing to a name nobody has used
creates it, with `receive.unpackLimit=0` so even a tiny push is retained as a
packfile (what the WAL will upload).

## Deployment

Through the `cloudflare` module, never by hand — `zbc apply <env>`. The Worker
(`worker/index.ts`) is a thin proxy in front of a Durable-Object-bound Container
running this package's Dockerfile; `wrangler deploy` builds the image, so Docker
must be running at apply time and the account must be on a Workers Paid plan
with Containers enabled. Set `immediateContainerRollout: true` on the instance —
wrangler's gradual default never drains a single always-warm container, so a
redeployed image silently never takes effect until it idle-sleeps.

The container reads its configuration from environment variables the **Worker**
forwards (`CONTAINER_ENV` in `shared/container-env.ts`): `wrangler secret put`
reaches the Worker and stops there, so a secret that is not in that list never
arrives.

It reads them **once, at container start** — a running process's environment
cannot be changed, so re-reading `process.env` per request would return the same
value. `immediateContainerRollout` does not help either: a deploy that changes
only vars produces no new container image for it to roll. So the Durable Object
fingerprints the environment it would boot with, keeps that fingerprint in its
own storage, and destroys the running container the first time the two differ
(`reconcileEnv`). Changing a forwarded variable therefore costs one container
restart on the first request after the deploy, and takes effect immediately —
where previously the Worker picked it up and the container kept the old value
for as long as traffic kept it awake.

Secrets the app needs (in the environment's `secrets.yaml`, wired as the
cloudflare instance's `workerSecrets`):

- `WALGIT_HTTP_TOKENS` — comma-separated bearer tokens (comma-separated so a
  credential can be rotated without a window where neither works).
- `WALGIT_S3_ENDPOINT`, `WALGIT_S3_BUCKET`, `WALGIT_S3_ACCESS_KEY_ID`,
  `WALGIT_S3_SECRET_ACCESS_KEY` — the write-ahead log's home (the `r2` module
  instance and its S3-API credentials). Without them the host serves reads from
  its local cache and **refuses every push**. `WALGIT_STORE_DIR` substitutes a
  local directory for the bucket, which is for development and tests only.

Optional instance configuration (plain env, not secrets): `WALGIT_APPEND_ONLY`,
`WALGIT_MAX_PUSH_BYTES`, `WALGIT_MAX_REPO_BYTES`, `WALGIT_RETENTION_HOURS`,
`WALGIT_PUBLIC`, `WALGIT_SIGNER_LISTS` — each unset means the behaviour is off
and `GET /` does not claim it. `WALGIT_EVENTS_URL` and `WALGIT_EVENTS_TOKEN` (a
secret) turn on the ref-event stream below, and `WALGIT_PUSH_CERT_SEED` (a
secret) turns on signed pushes.

Every flag above is read exactly once, by `capabilitiesFrom`
(`shared/capabilities.ts`), and **on means `1` or `true` — nothing else**. An
unrecognised value (`yes`, `on`, `TRUE`) reads as off, which for `WALGIT_PUBLIC`
means a token-gated host. Both halves take their answer from that one
derivation, so the documents cannot advertise a rule the push path does not
enforce, or the reverse.

`WALGIT_SIGNER_LISTS=1` lets a repository name the keys allowed to push to it
(docs/adr/0012 in the zbc repository): a commit on `refs/walgit/signers` whose
tree holds a `signers` file, one `SHA256:…` fingerprint per line. While a
repository has one, a push not signed by a listed key is **refused** — and the
list that judges a push is the one that stood before it, so a push moving the
list and a branch together installs a list that applies from the next push. A
repository with no list refuses nothing, which is every repository until someone
writes one; reads are never gated, and pushing a list that is empty or that
walgit cannot read is refused on any repository, claimed or not.

**Turn it on beside `WALGIT_PUSH_CERT_SEED`, never without it.** The seed is
what makes `git-receive-pack` advertise certificates at all, so with no seed
every push to a repository holding a list is refused as unsigned and no client
can sign its way out — that repository is unpushable until the seed is set.
Turn the flag on *before* anyone writes a list, too: the copy of the list the
refusal reads out of `index.json` is maintained only while the flag is on, so a
list pushed while it was off is not enforced until its ref is pushed again.

There is no recovery path for a lost key, and none is planned. List two keys.

The container sleeps when idle and the next request wakes it — one regime,
median 1.77 s, spread 0.93–6.45 s, and a ten-minute idle measures the same. Its
10.67 GiB disk is **wiped completely on every restart**, which is exactly the
assumption the cache-and-log design was written against, so there is no volume
and nothing to mount.

Trap worth knowing when tearing one down: `wrangler delete` on the Worker does
**not** delete its container application. That needs a separate
`wrangler containers delete`, or the instances stay live.

## Append-only refs

`WALGIT_APPEND_ONLY=1` makes every repository on the instance append-only: a
push may create a ref or fast-forward one, and may never delete or rewrite one.
It is **off by default** — a private instance may want force-push — and it is
instance configuration, so turning it on covers repositories that already exist.

It is enforced twice. `receive.denyNonFastForwards` and `receive.denyDeletes`
are set on the bare repo as a backstop that no bug in this code can bypass. The
refusal a client actually reads comes earlier, from `pre-receive`
(`src/append-only.ts`), and that earliness buys the two things git's own message
cannot: the wording — `denying non-fast-forward refs/heads/main` tells an agent
neither what walgit is nor what to do instead — and the object-store write, since
git refuses only _after_ `pre-receive`, by which point the pack for a doomed push
has already been uploaded and left for `findOrphans` to reclaim.

The check is git's own fast-forward test (`merge-base --is-ancestor`) over the
objects sitting in the quarantine. Unrelated history fails it, which is the
intended answer: pushing a fresh repo over an existing name would drop every
commit the branch holds today. The message names the repository, states the
rule, and offers a free name (`<repo>-<8 hex>`) to push to instead — a wave of
agents on near-identical prompts all reach for `test`, and this message is the
first thing walgit ever says to most of them.

## Size limits

`WALGIT_MAX_PUSH_BYTES` caps a single push; `WALGIT_MAX_REPO_BYTES` caps what
one repository holds in total. Both are **unset by default** — an instance opts
in, and an instance that does not set them enforces nothing and claims nothing.
`GET /` states each cap it enforces, rendered from the same `Capabilities`
(`shared/capabilities.ts`) the hook takes its limits from, so the page cannot
promise a limit the push path does not hold.

The refusal happens in `pre-receive` (`src/limits.ts`), where the pack is
sitting in the quarantine at a known size and nothing has been written to the
object store. That earliness is the whole feature. `http.postBuffer` defaults to
1 MiB, so every real push is chunked, and a chunked body is uploaded IN FULL
before a proxy can answer: measured against Fly, 99 MiB passes and 100 MiB is
refused only after all 104,879,625 bytes have gone up — 37 s of upload to be
told `RPC failed; HTTP 413` and `unexpected disconnect`, which reads like a
dropped network and gets retried. A documented cap must therefore sit under the
**chunked** cutoff, not the `Content-Length` one (which 413s at 101 MiB after
~2 MB): ~99 MiB is the safe ceiling for the public instance, with a repository
total of ~250 MB.

The repository total needs no new state. Every WAL entry carries its `size`, so
the total is a sum over the entries above the compaction frontier — the live
ones. Superseded entries are excluded on purpose: `gc.ts` deletes them, and
counting them would charge a repository twice for history it holds once, so a
repository that compacted itself would appear to have grown.

The two refusals say different things, because they are different problems. Too
big a push is one client sending too much at once and can be split; a full
repository is many small pushes that were each fine, and splitting will not help
— that one names a fresh repository instead. Both state the cap and the actual
size in bytes as well as units, and both say the push was not a network failure,
because the message they replace is one an agent retries.

`receive.maxInputSize` is set as a backstop, at **twice** the cap rather than at
it. git hands that value to `index-pack`, which fails while the pack is still
being read — before `pre-receive` runs — so a backstop set to the cap would win
every race and every client would read `fatal: pack exceeds maximum allowed
size` instead of walgit's message. At twice the cap the hook owns every refusal
a real client can provoke, and git still bounds a pack far enough past the cap
that a bug in the hook is the likelier explanation.

## Signed pushes

`WALGIT_PUSH_CERT_SEED` makes the host willing to receive `git push
--signed=yes`. A push certificate is a claim about _who moved this ref_, signed
by the pusher and carrying a nonce this server issued — and it is a
`receive-pack` capability, not a transport feature, so it works over smart-HTTP
with no SSH anywhere ([ADR-0011](../../../../../docs/adr/0011-walgit-records-who-pushed-and-refuses-nothing.md)).

git advertises the capability if and only if the receiving repository has
`receive.certNonceSeed` set, which `ensureBareRepo` writes from that variable on
every access — so a repository rebuilt from the log inherits it. With no seed
configured a client asking for `--signed=yes` is refused by its **own** git
(`fatal: the receiving end does not support --signed push`) before a byte
reaches the network, which is the right answer for a deployment that has not
turned this on.

The seed is configuration and is never generated: the nonce is derived from it,
a client holds one across the round trip, and the container's disk is wiped on
every restart — a seed minted at boot would reject every certificate in flight.

`receive.certNonceSlop` is written beside the seed, at **300 seconds**, and it
is not optional. git derives the nonce from the seed and _the unix second it was
minted in_, and a push over smart-HTTP is two requests: the advertisement mints
a nonce, and the push is a second process that minted its own. The two match as
strings only when both landed inside the same second, so git falls back to
asking how stale the client's nonce is — against a window that defaults to zero.
Unset, every round trip that crosses a second boundary reports
`GIT_PUSH_CERT_NONCE_STATUS=SLOP`, walgit establishes no Signer, and a
repository held by a Signer List refuses its own owner. The window is also the
replay window for a captured certificate, which is why it is five minutes and
not five hours.

An unsigned push is unaffected either way — `--signed=if-asked` is therefore safe
to pass unconditionally, to this host or any other. What walgit does with a
certificate it can verify is
[ADR-0011](../../../../../docs/adr/0011-walgit-records-who-pushed-and-refuses-nothing.md)
(record the Signer, refuse nothing) and
[ADR-0012](../../../../../docs/adr/0012-a-name-can-refuse-a-stranger.md) (a
repository holding a Signer List refuses a push it cannot attribute to a listed
key).

## Ref events

An agent working in a sandbox cannot be told anything: it has no ingress, no
stable address and often no listening port, so a webhook has nowhere to go.
Every agent therefore pays a background tax — _is my local main still current?_
— one fetch and one slice of context at a time, and almost every answer is
"nothing changed". The stream inverts the direction: the client dials out once
and is told.

Set both `WALGIT_EVENTS_URL` (this deployment's own public origin) and
`WALGIT_EVENTS_TOKEN` (a shared secret, in `workerSecrets`) to turn it on. With
either unset there is no endpoint at all — a subscriber gets the same 404 as for
any other path that does not exist.

```
# one outbound WebSocket, the same credential a clone needs
→ {"watch":[{"repo":"my-thing","refs":["refs/heads/main"]}]}
← {"ok":true,"refs":[{"repo":"my-thing","ref":"refs/heads/main","sha":"9f2c…"}]}
← {"repo":"my-thing","ref":"refs/heads/main","sha":"0ab7…"}
← {"repo":"my-thing","ref":"refs/heads/main","sha":null}
```

Omit `refs` to watch every ref in a repository; `sha: null` is a deletion. The
handshake answers with current state read from `index.json`, so connect and
catch-up are one operation and there is no window between them in which a push
is missed by both.

Events are **latest state, not a log**: no cursor, no `since`, no sequence
number anywhere on the wire. A reconnecting subscriber gets current state, which
is the only answer a client asking "is my main current?" can act on — replay
would be a second source of truth beside the Index.

The push path announces from `post-receive` (`src/announce.ts`), which git runs
only once the ref transaction committed — that is, only once the
compare-and-swap on `index.json` won. A push that lost it is rejected and never
reaches that hook, so nobody is ever told about a push that then lost. The
announcement is authenticated with `WALGIT_EVENTS_TOKEN`, bounded to two
seconds, and every failure is logged and swallowed: a notification outage must
never be the reason a push fails.

Subscribing takes exactly the credential a read takes — an event is a strict
subset of what a clone hands over — so a public deployment has a public stream.
Sockets are held by a Durable Object using the hibernation API, so watching a
quiet repository costs storage rather than duration.

A socket gets **at most one message per repository-and-ref per 250 ms**. The
first move of a ref goes out the moment it lands; a second inside that window
replaces the one already queued rather than joining it, so a branch pushed to
five times in a second is five pushes and one or two messages, each carrying the
sha at the time it was sent. Nothing here observes the reader — the Workers
runtime gives a Worker no way to see a socket's backlog — so the bound is the
rate, which is sound only because events are latest state: the sha you receive
when the window elapses is the one you would have converged to anyway. The cost
is that a push can reach a subscriber up to half a second late when its ref is
already moving.

## Authorization, today

One trust boundary: any HTTP token can read and write any repository. Per-repo
authorization is deferred until the repo namespace exists in the WAL — the
`tokens` list is the seam it plugs into.

`WALGIT_PUBLIC` removes that boundary entirely: reads, writes and ref-event
subscriptions all serve anyone, with no credential. It is an **explicit opt-in
and not the absence of tokens** — with neither configured the container refuses
to boot, so a deployment that loses its secrets fails closed instead of opening
to the world.

Three places decide whether a credential is needed — the container's git auth
(`src/http.ts`), the edge's socket auth (`worker/index.ts`) and the boot refusal
— and all three read `caps.publicAccess`. They used to read the variable
themselves, two of them accepting only `1` while `/llms.txt` accepted `true` as
well, so a host spelling it `true` told an agent no credential was needed and
then answered 401 to every clone.

## Tests

```bash
bun test src
```

Includes end-to-end clone/push/fetch through a real server against a real `git`
client, a cold-materialize suite that builds a repo
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
