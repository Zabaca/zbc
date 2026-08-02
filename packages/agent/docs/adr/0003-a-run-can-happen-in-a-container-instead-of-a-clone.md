# A run can happen in a container instead of a clone

> **The tier decision here is superseded by
> [ADR 0004](./0004-a-cloud-session-is-a-container-that-sleeps.md).** A container
> per turn with a git bundle between them cannot carry uncommitted work and pays
> `bun install` on every turn — neither was visible in these spikes, because the
> fixture was a two-file repository with no dependencies. The measurements below
> stand; the conclusion drawn from them does not.

ADR 0002 put the agent inside `sandbox-runtime` on the operator's laptop. That
containment exists because the agent shares a machine with a SOPS age key, SSH
credentials and thirty other repositories. In a Cloudflare container none of that
is present — the filesystem is whatever the image put there — so the containment
has nothing to protect and the container _is_ the boundary.

This records what four spikes and a review of a production system established
about running that second tier. **Nothing here is built.** It is written now
because the findings cost real money and hours to obtain and would otherwise
evaporate; two of them are the kind that are only learned by losing something.

Measured against `@anthropic-ai/claude-agent-sdk` 0.3.220,
`@cloudflare/sandbox` 0.12.1, on account `99a19e58…` — the same account
`cedarpad` runs on.

## The shape

A **run** happens on one of two tiers. A Profile, its Traits, and the option
composition in `sandboxedOptions` are identical on both; only where the process
runs and what confines it differ.

```
local        srt around the CLI    clone in /tmp      collect: git fetch <path>
cloudflare   the container         clone in the image collect: git fetch <bundle>
```

On the Cloudflare tier a container is rented **per turn**, not held. The Durable
Object is the session; the container is compute it rents:

```
send ──▶ boot 2.7s ──▶ restore 0.3s ──▶ ███ streaming ███ ──▶ checkpoint ──▶ sleep
```

## What was measured

|                                              |                                               | how                              |
| -------------------------------------------- | --------------------------------------------- | -------------------------------- |
| `claude-agent-sdk-linux-x64` @ 0.3.220       | exists, 275 MB                                | npm                              |
| CLI runs under linux/amd64                   | `2.1.220 (Claude Code)`                       | docker build                     |
| SDK spawns the CLI in the sandbox base image | 3 turns, tools, commit, 7 s                   | `docker run`                     |
| image size                                   | 1.17 GB (base 593 MB; cedarpad ships 2.83 GB) | `docker image ls`                |
| **cold boot to runner start**                | **2,691 ms**                                  | deployed, then destroyed         |
| bundle of this repo                          | 885 KB                                        | `git bundle create --all`        |
| bundle of one turn's commits                 | **488 bytes**                                 | `git bundle create base..branch` |
| R2 PUT, once per session                     | 363 ms                                        | laptop → R2, so an over-estimate |
| R2 GET + clone, per turn                     | 193 + 116 ms                                  | same                             |
| **overhead before the first token**          | **3.0 s**                                     | sum of the above                 |

Three seconds against a 45-second turn is why the container is not held warm.
`keepAlive: true` bills provisioned memory and disk per second, never
auto-times-out, and must be explicitly ended — and it would not remove the need
for checkpointing anyway (see below). It has no remaining argument.

## Considered options

- **Keep the container warm between turns** (`keepAlive: true`). Rejected. Its
  only benefit was hiding boot latency, and boot is 2.7 s. It does not provide
  durability: `onStop` is skipped entirely on the eviction path
  (`cloudflare/containers` `container.ts:1896-1902`), so work can vanish with
  `keepAlive` on exactly as without it. It would mean building the checkpoint
  machinery _and_ paying continuously _and_ exercising the recovery path so
  rarely it is never known to work.
- **`createBackup()` / `restoreBackup()` as the persistence mechanism.**
  Cloudflare ships it, GA'd 2026-02-23, squashfs to R2 restored through
  fuse-overlayfs. Rejected on two counts. The first is mechanical and decisive
  for a sleep/wake loop: its production restore is a **mount, not an extraction**
  — `sandbox.ts:7051` — _"the FUSE overlay mount persists only while the container
  is running. When the sandbox sleeps or the container restarts, the mount is lost
  and the directory becomes empty… This is an ephemeral restore, not a persistent
  extraction."_ A per-turn design would work exactly once. (`localBucket: true`
  takes a different path — the container runs `unsquashfs`, a real extraction with
  no FUSE — and nothing in the code gates it to local development; the docstring
  states when it is _required_, not when it is _permitted_. So the mount is
  avoidable. What is not avoidable is the second count.) The second: `cedarpad`
  did exactly this and lost data
  on 2026-07-29. Their ADR-0022 states the principle — _"The tar is not the bug.
  The bug is the **inversion**: the container filesystem was the authoritative
  copy and R2 a periodic snapshot of it, which means **a failed read can become a
  destructive write**."_ Their boot path now carries
  `IT RESTORES NOTHING`, with a test keeping it deleted.
- **`mountBucket()` for a live working tree.** Rejected twice over. It is
  s3fs-fuse, whose own limitations page lists no atomic rename, no hard links and
  no cross-client locking — and git's entire safety model is
  write-temp-then-atomically-rename, so the failure mode is a corrupt repository
  rather than a slow one. Independently, _"the FUSE mount is lost when the sandbox
  sleeps or the container restarts"_ and `activeMounts` is an in-memory `Map` on
  the DO that is never persisted, so it would have to be re-mounted every start
  regardless.
- **Durable Object storage for the workspace.** Rejected on size: 128 KiB per KV
  value, 2 MB per SQLite row. Correct for a session pointer and a bundle key;
  useless for the bundle.
- **The container pushing to GitHub**, as `cedarpad` does. Not rejected on merit —
  they mint a ~1 h GitHub App installation token per request at the edge and strip
  any client-sent copy, which is a materially safer bargain than ADR 0001
  rejected. Rejected here because it changes what "the repository" _means_: a
  container cannot reach a laptop, so it would clone from `origin` and the cloud
  tier could only ever operate on already-pushed refs. The bundle keeps both tiers
  operating on the same thing — your checkout.
- **A thin runner in the image, with the Worker composing `Options`.** Rejected.
  It would let Traits change without an image rebuild, but the Worker would be
  constructing `cwd`, `env` and paths for a filesystem it cannot see, and
  `onMessage` is a function that cannot cross the boundary. `cedarpad` bakes the
  whole application into the image; so should this.

## Consequences

- **The workspace path must be pinned.** The SDK encodes `cwd` into the
  transcript's directory name — a run at `/private/tmp/zbc-spike-a/repo` writes to
  `projects/-private-tmp-zbc-spike-a-repo/<sessionId>.jsonl`. `createWorkspace`
  uses `mkdtemp`, so today's paths are random. A restored transcript at a
  different path is invisible to the SDK and the agent silently starts the
  conversation over. The cloud tier needs a constant, the way `cedarpad` pins
  `CANVAS_CONTAINER_CWD`.
- **A session is one relocatable file.** Verified: run a turn, destroy the entire
  workspace, rebuild at the same path, restore only the `.jsonl`, resume — same
  session id, and the agent recalled a word from before the destruction. This is
  what makes container-per-turn possible at all.
- **Restoring a transcript must not clobber a newer one.** `cedarpad`'s rule, and
  the reason is in their source: _"overwriting it would rewind the conversation…
  writing a second copy would double it."_ Prefer the local copy when present.
- **`IS_SANDBOX=1` is required.** The container runs as root and the CLI refuses
  `--dangerously-skip-permissions` with root privileges. Without it a run dies at
  startup with a message that says nothing about containers. Cloudflare's own
  `claude-code` example sets it.
- **An open stream keeps the container awake.** This is the inversion `cedarpad`
  hit: they could not get containers to sleep because an SSE forward pinned them.
  A stream that does not close at end of turn is `keepAlive` by accident, paid for
  by accident. They solve it with a client idle-gate and a bridge that exits
  itself after 90 s without a heartbeat.
- **Activity is measured at the Durable Object, not in the container.** A long run
  is a busy container and a silent DO, which is precisely the shape that trips
  `isActivityExpired()`. Renewal during a run is a separate concern from keeping a
  container warm between them.
- **Containment must be a property of the tier, not an option.** Spike C ran the
  profile with the shim removed and confirmed the composition is unaffected — and
  the same process read `$HOME/.zshrc`. Correct in a container, catastrophic
  anywhere else. No caller may pass "containment off".
- **The agent tier and `cedarpad` share an account.** Container instance limits
  are per class, but account ceilings (6 TiB memory, 1,500 vCPU, 30 TB disk) are
  shared. Nowhere near binding at this scale, but they are one pool.
- **Credentials would improve, not worsen.** The local tier puts a real token in
  the environment where the agent can read it (ADR 0002). Cloudflare's
  `outboundByHost` runs egress proxies in the Worker, outside the container, so
  the container holds a placeholder and the real value is substituted on the wire.
  That is the answer to both ADR 0002's open item and to not wanting live keys in
  CI. Untested here.
- **An agent with no system prompt does not know where it is.** The deployed
  spike burned five turns without producing its file, and the cause was neither
  the platform nor instance size — it was a runner that passed no `systemPrompt`.
  Given only the SDK's 62-character identity line, the agent wrote to
  `/root/owls.txt`, then `cd /root && git add -A` returned
  `fatal: not a git repository`, and it spent the remaining turns digging out.
  `preset: 'claude_code'` carries the working directory in its dynamic sections,
  which is why the real profile never hits this — and why a minimal container
  runner must not be more minimal than the profile it stands in for.
  Reproduced and then fixed under local throttling:

  |                         | turns |   wall | wrote                |
  | ----------------------- | ----: | -----: | -------------------- |
  | no preset, `--cpus=1`   |     4 | 19.2 s | `/root/owls.txt` ✗   |
  | no preset, `--cpus=0.5` |     6 | 19.7 s | correct, after `pwd` |
  | preset, `--cpus=1`      |     3 |  9.2 s | correct              |
  | preset, `--cpus=0.5`    |     3 | 18.5 s | correct              |

- **Instance size is a latency knob, not a correctness one.** Halving CPU doubled
  wall time and left turn count and behaviour identical. Nothing in the agent's
  conduct depends on how fast the container is.
