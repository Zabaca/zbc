# A cloud session is a container that sleeps, and a snapshot taken on the way down

ADR 0003 chose to rent a container **per turn** and carry work between turns as a
git bundle. That was wrong in a way the measurements at the time could not show,
because the fixture had no dependencies and nothing uncommitted.

Two things broke it. Per-turn setup on a real repository is `bun install` — 8.7 s
cold, and growing with every dependency added, paid on every follow-up. And a
bundle carries **commits only**, so anything the agent left uncommitted between
turns is lost. In an interactive loop that is the normal case: the agent produces
a draft, a human reads it, and asks for a change. Forcing a commit per turn to
avoid it fills the history of every conversation with work-in-progress.

A container that stays warm across turns and snapshots itself on the way to sleep
solves both, and it is now measured end to end.

## The shape

The Durable Object is the session. The container is compute the session keeps
until it goes idle.

```
turn 1  ──────────────────────────────────────▶  work, committed and not
                        ▲   ▲                     (no transfer, warm)
turn 2  ────────────────┘   │
                            │
   idle  ──▶  onActivityExpired  ──▶  createBackup({ localBucket: true })
                                       pointer swapped in ctx.storage
                                       container sleeps

   wake  ──▶  restoreBackup(handle)  ──▶  turn 3, resumed
```

Cost is paid per **session boundary**, not per turn. Inside a session there is no
transfer at all.

## What was measured

A full loop against a deployed Worker, then destroyed:

|                                 |                     |
| ------------------------------- | ------------------- |
| turn 1, cold                    | 28.0 s              |
| snapshot at `onActivityExpired` | **1.3 s**           |
| restore on wake                 | **3.1 s**           |
| turn 2, after restore, resumed  | 12.1 s, **2 turns** |

Turn 2 was asked, without reading any file, which word it had written the turn
before. It answered `kestrel` — the transcript lives under
`/workspace/home/claude`, inside the snapshot. It was then asked to commit the
pending `README.md` change, and there was one to commit. **Both the conversation
and the uncommitted working tree survived the container's death**, which is the
whole reason for preferring this over a bundle.

Supporting measurements, from ADR 0003 and after:

```
bun install (cold)      8,653 ms      node_modules 1.6 G
mksquashfs /workspace   8,146 ms      archive 405 M
unsquashfs              1,334 ms
git bundle --all          219 ms      892 K   (commits only)
```

## Considered options

- **A container per turn, bundle in and out** (ADR 0003). Superseded. It pays
  `bun install` on every turn and cannot carry uncommitted work. Both were
  invisible in the original spike because the fixture was a two-file repository.
- **Keeping the container warm indefinitely** (`keepAlive: true`). Rejected, and
  the reason is unchanged: it bills provisioned memory and disk per second, never
  auto-times-out, and must be explicitly ended — and it does not remove the need
  for a snapshot, since `onStop` is skipped on the eviction path. It is an
  optimisation to switch on for an active session, not an architecture.
- **A bundle per turn as insurance alongside the snapshot.** 219 ms and ~1 MB,
  and it would bound eviction loss to a single turn. Deliberately deferred to
  keep one mechanism; recorded here because it is the obvious first thing to add
  when eviction stops being hypothetical.
- **Baking dependencies into the image.** Not rejected — orthogonal, and probably
  right eventually. It moves install cost from per-turn to per-deploy, which is
  where it belongs. `cedarpad`'s Dockerfile does exactly this: _"the package with
  `node_modules` baked in, so a cold boot is just 'start the dev stack', not
  'install'."_ It becomes necessary if sessions get short enough that the first
  turn's install dominates.

## Consequences

- **`localBucket: true` is used in production, off-label.** Its docstring says it
  is _"required for local development"_, which states when it is mandatory, not
  when it is permitted — and nothing in the SDK gates it. Verified working
  against a real R2 binding on a deployed Worker. It is also the only path that
  works here: the default flow restores by mounting a FUSE overlay, and
  `sandbox.ts:7051` says _"the mount is lost and the directory becomes empty…
  This is an ephemeral restore, not a persistent extraction."_ `localBucket`
  extracts with `unsquashfs` instead. If Cloudflare ever adds the gate the
  docstring implies, this breaks.
- **Never snapshot a container that did not restore.** The most expensive thing
  learned here, and it was learned by doing it. Sequence, observed:

  ```
  turn 1   work created
  idle     snapshot A — correct
  boot     restore skipped (a bug: the guard was in durable DO storage,
           so it read `true` from the previous boot)
  idle     snapshot B of an EMPTY workspace — succeeds
           pointer → B.  A orphaned.  Work gone.
  ```

  Writing a new object and swapping the pointer only on success — proposed as
  _the_ safety — did nothing, because the empty snapshot succeeded. It guards a
  partial write, not a complete write of garbage. The guard that works is nine
  lines: if a backup exists and this boot never restored, refuse to snapshot.

- **A restore guard must not live in Durable Object storage.** It has to die with
  the thing it guards. `ctx.storage` outlives the container, so a flag kept there
  reports "already restored" to a container that has never restored anything. An
  in-memory field on the class, or a comparison against the current backup id.
- **The transcript comes along for free**, because it is under `/workspace`. That
  is worth stating because it is the only reason session resume works here, and
  moving `CLAUDE_CONFIG_DIR` outside the snapshotted directory would silently
  break it while everything else kept working.
- **Unverified: scale.** The measured workspace was ~40 KB of squashfs. A real
  one is 405 MB, which is 8 s to archive plus transfer both ways. The 1.3 s
  snapshot and 3.1 s restore above will not hold, and `onActivityExpired` has no
  documented time budget to spend.
- **Unverified: eviction.** Only idle sleep was exercised. `onActivityExpired`
  does not fire on eviction, OOM, or a rollout, and `onStop` is skipped there too
  (`cloudflare/containers` `container.ts:1896-1902`). An evicted session loses
  everything since its last snapshot.
- **Unverified: a genuine restore failure.** None was ever produced — the one
  observed was a skipped call, not a failed one. TTL expiry is the realistic
  trigger: the default is 3 days and the docs say it is checked _only at restore_.
  What the code should do when a restore legitimately fails is undecided; halting
  is the obvious answer and is untested.
- **Unverified: concurrency.** Two requests arriving while a restore is in flight.
