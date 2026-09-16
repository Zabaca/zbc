# agentgit production under load — 2026-09-16

One measured run against `https://agentgit.zabaca.com`, before the Show HN post.
It answers three questions and raises one: how many at once, what gives way
first, what the per-source rate limits should therefore be — and why a 10 MiB
push fails against a host that advertises a 99 MiB cap.

Everything below was measured, not modelled. The tool is
`packages/walgit/e2e/load.ts`, committed with this document; every number has
the command that produced it beside it, and the raw per-attempt samples are in
the JSON each run writes.

## What was measured, and against what

| | |
| --- | --- |
| Date | 2026-09-16, 21:45–22:15 UTC |
| Origin | `https://agentgit.zabaca.com` (Cloudflare Worker + one Container, `max_instances: 1`) |
| Deployment identity | `/llms.txt` fingerprint `99ea2c190ca9d3ae`, 22 600 bytes |
| Deployed code | A build of `main` from **before** `867d928` (#154). The document advertises Proposals, Private and the 24 h window and advertises **no per-source limits**, which is how #154's deployment state is read: production ships only through `/release`, and #154 merged the same afternoon. The measurements are therefore of the service **with no rate limiter in front of it** — which is the right condition for measuring it |
| Client | one Linux VM (`lima-personal-vm`), one egress address, `git` over HTTPS and a real WebSocket |
| Edge | `cf-ray … -SJC` |

Client-side network is part of every number here. These are what a visitor from
one machine on one connection experiences, not what the service can do for a
globally distributed crowd — a distinction that matters for the tails and not
for the shape.

## The numbers

Concurrency ladder, each phase a burst of N at once (`e2e/load.ts`, runs
`jl0pwc`, `kqntpe`, `uzvk70`). Milliseconds, nearest-rank percentiles, over
successful attempts only.

| Workload | at 1 | at 8 | at 32 |
| --- | --- | --- | --- |
| **clone** (p50) | 2 070 | 3 684 | 12 029 |
| clone p99 | — | 3 775 | 12 212 |
| clone errors | 0/1 | 0/8 | 0/32 |
| **push** (p50) | 4 392 (sequential seed) | 20 395 | not run — budget |
| push p99 | — | 22 870 | |
| push errors | 0 | 0/9 | |
| **subscribe** handshake p50 | 942 | 3 082 | 3 407 |
| subscribe p99 | — | 3 259 | 10 672 |
| **event fan-out** p50 | — | 4 599 | 5 112 |
| fan-out spread, first to last | — | 4 ms across 8 | **2 ms across 32** |
| fan-out errors | — | 0/8 | 0/32 |

Derived throughput, which is what the rate limits are set from:

| | at 1 | at 8 | at 32 |
| --- | --- | --- | --- |
| clones/s | 0.48 | 2.17 | **2.66** |
| pushes/s | 0.23 | **0.35** | — |

Byte throughput, measured separately with incompressible 5–20 MiB packs:
**≈1.1 MiB/s** (10 MiB in 9.7 s; 20 MiB in 15.6 s) — call it **3.9 GiB/hour**
for the whole host.

The 8×8×8 run was made twice, half an hour apart (`jl0pwc`, `2j2zuu`), and
reproduced: push p50 20 395 ms then 24 407 ms, clone p50 3 684 then 3 909,
subscribe p50 3 082 then 3 083, fan-out p50 4 599 then 4 460, zero errors both
times.

A note on the tool's own one-line verdict: with every workload healthy it ranks
by p99 ÷ p50 — tail SHAPE — so it named `push` in one of those runs and
`subscribe` in the other, at 1.1× each. That is the two tails being equally
flat, not a disagreement about the bottleneck. The bottleneck below is named
from throughput and from the single-stream comparison, which is the evidence
that actually separates them.

The uncontended in-process reference, for contrast: scenario 7 of the
verification suite (`bun run e2e -- --only 7`, local `FileStore`) replays the
WAL in **8–14 ms p50** at 1, 10 and 50 entries. The log is not where the
seconds are.

## What gives way first: the push path

**Push is the bottleneck, and it is serialization rather than capacity.** One
push costs 4.4 s uncontended. Eight at once, to eight *different* repositories,
cost 20.4 s each — 4.6× the single-stream number for 8× the work, with nothing
failing. The host is not refusing under the load; it is queueing, and every
client sits in the queue.

The evidence that this is the container and not the log:

- WAL replay is 8–14 ms (scenario 7). Three orders of magnitude below the 4.4 s
  a push costs. Whatever the seconds are, they are not the write-ahead log.
- Clones of the same host at the same concurrency cost 3.7 s and scale to
  **2.7/s** — the read path saturates at roughly 8× the write path's rate
  through the same single container.
- Nothing was rate-limited (the limiter is not deployed) and nothing errored, so
  the latency is not retries.

That is the expected shape: `max_instances: 1`, one container serving every
repository, and a push is the expensive operation in it — receive-pack, the
hooks, the compare-and-swap against `index.json`, the R2 round trips.

**Second to degrade: the subscribe handshake.** 32 subscribers all connected
and all received their events, but the handshake's p99 was 10.7 s against a
3.4 s p50 — 3.1× its own median, the signature of a queue. The handshake reads
the Index once per repository named (`shared/events.ts`), so it goes through
the same busy container.

**Fan-out is not a bottleneck and is not close to being one.** One push woke 32
subscribers, and the **first and last of them received the event 2 ms apart**
(5 112 → 5 114 ms from the start of the push). The Durable Object's fan-out cost
is invisible next to the push that triggers it. If anything about the event
stream is worth watching before a launch it is the handshake, not the delivery.

**R2 was never the constraint** at these sizes and is not implicated by
anything measured.

## The finding that is not about load: a 10 MiB push mostly fails

Found while measuring byte throughput, on an otherwise idle host, and
reproducible:

| Pack size | Succeeded |
| --- | --- |
| 2 MiB | 3 of 4 |
| 5 MiB | 1 of 1 |
| 10 MiB | 2 of 4 |
| 20 MiB | **1 of 6** |

The failures are early — 1.4–6.4 s in, long before the upload could have
finished — and the client reads them as a transport fault, not as a walgit
refusal:

```
error: unable to rewind rpc post data - try increasing http.postBuffer
error: RPC failed; curl 55 GnuTLS recv error (-12): A TLS fatal alert has been received.
send-pack: unexpected disconnect while reading sideband packet
```

Raising `http.postBuffer` to 32 MiB (so git sends one `Content-Length` POST
instead of a chunked one) does not help — that was tried and failed the same way
at the same time.

This matters for the post because **`/llms.txt` promises a 99 MiB per-push cap**
and walgit's whole product claim is that it refuses things in its own words
rather than dropping connections. A visitor pushing a real repository — a node
project with a lockfile and some images is 10–20 MiB — has a better-than-even
chance of a `remote end hung up unexpectedly` with no explanation.

It is **not** diagnosed here and is not this ticket's to fix: it needs the
Worker's own logs to say which side closed. It needs a follow-up ticket of its
own, and that ticket is the one thing here that should be opened before the
post rather than after it. What is knowable from the outside is that it is not the advertised size cap (which
answers in `pre-receive`, with words) and not this client's buffer.

## The rate limits, and where each number comes from

`packages/infra/environments/production/walgit-public.ts`. The values shipped
with #154 were reasoned from what agent traffic looks like; these are the same
intent held against the measured host capacity above. The principle is
unchanged — invisible to the traffic the service is *for*, biting only on
traffic nobody would defend — with one addition the measurement forces: **no
single source should be able to take a large fraction of the whole host's
hourly capacity**, because one container serves everyone and a filled queue is
everyone else's latency.

| Limit | Was | Now | Why |
| --- | --- | --- | --- |
| `WALGIT_MAX_NEW_REPOS_PER_SOURCE` | 20 | **20** (unchanged) | A new name costs exactly one push (4.3–5.2 s uncontended, measured across 14 seeded repositories) — creation is not special. 20 names is ~1.6% of the host's measured hourly push capacity. The measurement supports the number that was there. |
| `WALGIT_MAX_PUSHES_PER_SOURCE` | 300 | **120** | Measured host capacity is 0.35 pushes/s ≈ 1 260/hour. 300 would let one address take **24%** of it; 120 is ~10%. An agent working in a repository for an hour makes tens of pushes, so 120 is still 4–12× real use. |
| `WALGIT_MAX_PUSH_BYTES_PER_SOURCE` | 2 GiB | **256 MiB** | Measured host byte capacity is ~1.1 MiB/s ≈ 3.9 GiB/hour. 2 GiB let one address take **half the host's hourly bytes**; 256 MiB is ~6%. It is still two full-size pushes, and ~25× the largest pack that was observed to complete reliably. |

The window stays the default hour, and the source stays the client IP — which
is all the Worker can see, so a NAT shares a bucket. That is the reason these
are generous rather than tight, and it is why the ceiling worth defending is
the *fraction of host capacity*, not a guess at one user's needs.

## Honest limits of this run

- **One client machine, one connection, one region** (SJC edge). Client network
  is inside every number. A crowd arriving from everywhere is a different
  arrival pattern and would likely look *better* per-client at the edge and
  identical at the container.
- **The limiter was not deployed**, so nothing here measures `src/rate-limit.ts`
  in production. The values chosen above take effect on the next production
  apply, and the first run after it should confirm a refusal is spoken as a
  `remote:` line rather than a hang.
- **Push concurrency was measured at 8, not 32.** Eight concurrent pushes
  already cost 20 s each with no failures; 32 would have spent most of the
  hourly budget to confirm a slope that is already visible. `e2e/load.ts`
  refuses to plan a run past half the per-source budget for that reason.
- **The 20 MiB failures pollute nothing above** — they were measured after the
  concurrency runs, on an otherwise idle host, and no concurrency run contained
  a pack larger than a few KiB.

## Reproducing it

```sh
cd packages/walgit
bun run e2e/load.ts --origin https://agentgit.zabaca.com \
  --repos 8 --clones 8 --pushes 8 --watchers 8 --json run.json
bun run e2e/load.ts --origin https://agentgit.zabaca.com \
  --repos 1 --clones 32 --pushes 0 --watchers 0 --json clones.json
bun run e2e/load.ts --origin https://agentgit.zabaca.com \
  --repos 1 --clones 0 --pushes 0 --watchers 32 --json watchers.json
```

Each run leaves `load-<run id>-*` repositories on the origin, which agentgit's
24-hour retention window collects on its own — the run names them on the way
out. Nothing else is left behind, and nothing was deleted or reconfigured to
take these measurements.
