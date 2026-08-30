# The verification suite

One command runs every guarantee walgit claims:

```bash
bun run e2e            # every scenario
bun run e2e -- --quick # smaller fixtures — disclosed in the output
bun run e2e -- --only 2,7
```

Against a real bucket rather than local disk, export the store's four variables
and change nothing else:

```bash
WALGIT_S3_ENDPOINT=… WALGIT_S3_BUCKET=… \
WALGIT_S3_ACCESS_KEY_ID=… WALGIT_S3_SECRET_ACCESS_KEY=… bun run e2e
```

## What is real

The scenarios exist to check what happens when a process dies mid-push, and a
double is precisely the thing that cannot die mid-push. So:

- **The node is a child process** (`src/server.ts`), in its own process group.
  `kill -9` is `SIGKILL` to that group, which reaches `git-http-backend` and the
  hook processes too.
- **The client is `git`**, over HTTP, with the ambient `~/.gitconfig` stripped.
- **The store is real** — `FileStore` on disk by default (a real compare-and-swap
  under a real lock), `S3Store` against a real bucket when `WALGIT_S3_*` is set.
- **A "fresh node" is a node with an empty repos directory**, which is the
  production case rather than a disaster: `min_machines_running = 0` means the
  disk is gone after every idle period.

## Isolation and cleanup

Every key walgit writes lives under `repos/<repoId>/`, so a run-unique repo-id
prefix is a run-unique key prefix. Concurrent runs cannot collide and a failed
run cannot corrupt the next. `Run.cleanup()` deletes every prefix and scratch
directory it created, and is wired to the normal exit, to a throw, and to
`SIGINT`/`SIGTERM` — because a leaked prefix costs storage forever.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | Everything passed |
| 1 | At least one scenario failed |
| 2 | Nothing failed, but the suite ran less than the full set (`--only`) |

Code 2 exists so a narrowed sweep cannot be mistaken for a clean one by a
script. For the same reason `--quick`, an unbaselined latency size, and a run
that is not against a real bucket are all printed rather than assumed.

## Scenario 7 and the latency baseline

The ceilings live in `latency-baseline.ts` and gate the **compacted** restore —
the number that must stay flat, because a compacted repository replays exactly
one WAL entry however many pushes it has taken. The raw number is reported but
not gated: it grows with push count by design.

A breach fails the build, and the failure says what to do about it. The knob is
`WALGIT_COMPACTION_THRESHOLD`, not this code. Point
`WALGIT_E2E_LATENCY_BASELINE` at a JSON file of the same shape to gate a
different machine — a bucket run should have its own, since a network round trip
per entry is not a regression.

Cold start is deliberately excluded: a client pays it (median 1.77 s, from
the Containers spike) **plus** replay, and blending the two makes a regression
unattributable. The suite reports `fetch` and `init+refs` separately for the
same reason.

## Kill points

Scenario 2 enumerates its kill points in `KILL_POINTS` — `after-upload`,
`before-cas`, `after-cas` (named exits in `src/hook-main.ts`) and `group-kill`
(a `SIGKILL` at an arbitrary moment, which is the check on the enumeration being
incomplete). The list is enumerated rather than exhaustive, and the suite says
so in its output. **Adding a step to the push path means adding it here.**

## Scenario 8 and the events endpoint

Scenario 8 is the only one with a stand-in, and it is a narrow one. In
production the sockets live in a Durable Object behind the Worker; here they
live in a Bun server inside the suite (`EventsEndpoint` in `harness.ts`), because
the alternative is a Workers runtime in the test path.

What is **not** stood in for is everything that decides anything: the announce
credential is checked by `authorizeAnnounce`, the `watch` message is parsed by
`parseWatch`, the fan-out is `watchCovers`, the handshake is `handshake`, the
backpressure policy is the real `Outbox` — the same modules the Worker calls.
The handshake's refs are read from the node's `/_walgit/refs`, over the same
internal endpoint the Durable Object uses, so they come from the Index rather
than from the suite's own memory.

The push side is entirely real, which is the point of the scenario: the hook
fires, `post-receive` announces over a real socket to a real port, and the
subscriber is a real WebSocket client. It covers three things a unit test
cannot see — a push arriving, a **ref-only** push (no pack uploaded at all)
arriving, and a push that lost the compare-and-swap announcing nothing.

## Scenario 9 and the signing key

Scenario 9 is the only end-to-end check on push provenance (`docs/adr/0011`),
and it is the only place in the suite where a **key** exists. It generates an
ed25519 keypair with `ssh-keygen`, configures the clone to sign with it, pushes
`--signed=yes`, and compares the Signer read back from `/_walgit/provenance`
against `ssh-keygen -lf` on the public half — the one fingerprint in the run
walgit had no hand in producing.

Nothing here is stood in for, deliberately: git's own verdict on an SSH push
certificate is `GIT_PUSH_CERT_STATUS=N` with no signer at all, so a stubbed
verifier would have reported success against exactly the mistake this scenario
exists to catch.

The key is generated by the scenario, removed by it, and asserted gone. No
credential is needed to run it: the nonce seed is a local string, and
`WALGIT_PUSH_CERT_SEED` on the node is the whole of what turns the capability
on — with it unset, the client's own git refuses `--signed=yes` before a byte
reaches the network.

One asymmetry worth knowing, because it makes a "no new objects" check by WAL
entry count wrong: a **signed** ref-only push sends an empty pack (a 32-byte
header and trailer) where an unsigned one sends none at all. The scenario reads
the object count out of the pack header instead.
