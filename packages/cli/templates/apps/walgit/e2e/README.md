# The seven-scenario verification suite

One command runs every guarantee walgit claims:

```bash
bun run e2e            # all seven
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
| 0 | All seven passed |
| 1 | At least one scenario failed |
| 2 | Nothing failed, but the suite ran less than the full seven (`--only`) |

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

Machine wake is deliberately excluded: on Fly a client pays wake (~1.35 s, from
the milestone-0 spike) **plus** replay, and blending the two makes a regression
unattributable. The suite reports `fetch` and `init+refs` separately for the
same reason.

## Kill points

Scenario 2 enumerates its kill points in `KILL_POINTS` — `after-upload`,
`before-cas`, `after-cas` (named exits in `src/hook-main.ts`) and `group-kill`
(a `SIGKILL` at an arbitrary moment, which is the check on the enumeration being
incomplete). The list is enumerated rather than exhaustive, and the suite says
so in its output. **Adding a step to the push path means adding it here.**
