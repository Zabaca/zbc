# walgit gets a `shared/` kernel, and `worker/` means the Workers runtime again

**Status:** accepted (2026-08-29). Refines the code organization implied by [ADR-0008](./0008-walgit-runs-on-a-cloudflare-container-without-ssh.md); nothing about the deployment topology or [ADR-0007](./0007-walgit-object-storage-holds-the-log.md)'s core sentence changes.

walgit gains a third directory, **`shared/`**, whose rule is one sentence: **`shared/` imports no runtime, and both halves may import it.** It is included by `tsconfig.json` *and* `tsconfig.worker.json`, so a module there is typechecked once under `@types/bun` and once under `@cloudflare/workers-types` — which makes "this is runtime-neutral" something the build fails on rather than a comment. `worker/` is then exactly the two modules that need the Workers runtime, and the object-store key namespace gets an owner in `src/keys.ts`.

This is a move-and-deduplicate pass. No behaviour changes.

## What was wrong

**`worker/` was named for a deployment target, and five of its seven modules did not belong to one.** Only `worker/index.ts` and `worker/events-do.ts` import the Workers runtime. `events.ts`, `telemetry.ts`, `outbox.ts`, `landing.ts` and `container-env.ts` imported nothing from any runtime, each said so in its own docstring, and every one of them was already reached from the other half — `src/announce.ts`, `src/instructions.ts`, three unit tests and `e2e/harness.ts` all imported across into a directory named for the process they do not run in. A directory name is load-bearing documentation, and that one was wrong in both directions: a reader who took it at face value concluded those modules ran at the edge, and a reader who did not was left with no rule about what may live there.

**Nine facts had more than one definition, and two had already drifted.** The header names, the internal path strings, the smart-HTTP route grammar, the reject-kind vocabulary, the repo-id grammar, the all-zeroes oid, the two credential-parsing helpers, the comma-separated token list, `positiveNumber` and `describeBytes` were each written out two or three times. `RejectKind` was two different unions (seven members in the Worker, five in the container). `positiveNumber` was three functions with two different return types (`number | null` twice, `number | undefined` once), agreeing on behaviour by hand.

Each duplication was annotated as deliberate, and all of them rested on one stated premise — from `worker/landing.ts`: *"the two halves compile against conflicting ambient types … so they share a vocabulary without sharing a bundle."* The premise had been overtaken by the tree. What is actually true is narrower: `src/` and `worker/` cannot import **each other**, because `@types/bun` and `@cloudflare/workers-types` are contradictory ambient declarations. A module that imports neither is valid under both, and the app had five such modules in production use. The fix follows directly: give that category a home.

**The object-store key namespace had no owner.** `repos/<repo_id>/…` is the one thing every module agrees on and the one thing a bucket cannot be migrated away from, and it was authored in six places and read back by hand in two more. Two consequences: `listRepoIds` lived in `src/usage.ts` — the read-only reporting command — so `src/expire.ts`, whose job is *deleting* repositories, imported the usage reporter to enumerate them; and `src/gc.ts` reconstructed a ULID out of a WAL key with a `split`, a `pop`, a `replace`, an `indexOf` and a `slice`, reversing a format `walKey` produced six modules away without saying so.

## Considered options

- **Leave it; the copies are documented.** Rejected on evidence: two of eleven had drifted while carrying comments asserting they were kept in step, and nothing tested the ones that had not.
- **Agreement tests instead of a shared module** (the pattern already present: `telemetry.test.ts` asserted `http.SERVED_HEADER === telemetry.SERVED_HEADER`). These catch a divergence only for facts someone remembered to pair up, they cost a test per fact forever, and they cannot express a *relationship* — `RejectKind`'s two unions are legitimately different sizes, which no equality assertion can say.
- **One tsconfig with both type packages.** Not available: the ambient declarations conflict, which is the real constraint and the one thing the old comments got right.
- **Put the shared modules in `src/` and have `worker/` import upward.** Rejected: `src/` is the container process — it touches the disk and runs git — so this would make the Worker's typecheck depend on a directory most of which it can never compile.

## Consequences

- **A new directory with one rule, enforced by the build.** `shared/protocol.ts` (the wire contract), `shared/credentials.ts`, `shared/policy.ts`, plus the five moved modules. A module there that reached for `Bun` or for a Durable Object fails one of the two typechecks.
- **The reject vocabulary states its own relationship.** `RejectKind` is one union in `shared/protocol.ts`; the container's narrower set is `ContainerRejectKind = Exclude<RejectKind, 'edge' | 'other'>`, and `src/http.ts` refuses through a helper typed by it. `edge` being unavailable to the container is now a property the compiler holds, not a comment.
- **Two agreement tests were deleted, because they became assertions that a value equals itself.** The repo-id agreement test in `src/events.test.ts` stays: both call sites go through the same regex but not the same function, since `normalizeRepoId` strips the address forms a URL carries first.
- **`src/keys.ts` owns the layout.** Every prefix, every key builder, the `.pack` → `.idx` sibling rule, the parse back out of a WAL key, and `listRepoIds`. `src/expire.ts` no longer imports `src/usage.ts`; `src/gc.ts` asks for a key's upload time instead of dismantling the string.
- **The app template stays dependency-free.** walgit is scaffolded verbatim into consumer repos ([ADR-0005](./0005-subtree-distribution-zbc-core.md)), so `shared/` adds no package and no build step — it is three tsconfig `include` entries and a directory.
- **A consumer with a vendored copy of walgit has moved files.** `zbc add walgit` copies the package, so an existing consumer that edited `worker/landing.ts` in place will not see it move. The template is the source of truth and the paths in `registry.json`, `wrangler.jsonc` and the README were updated with it.

## Deliberately out of scope

Named so they are not mistaken for things this pass missed, and each a clean follow-up:

- **`src/usage.ts` mixes collection with presentation** — it folds indexes into a report *and* renders that report as terminal text. The seam is obvious, but splitting it is a different kind of change and would be buried in a diff of moved text.
- **`src/cli.ts` is argument parsing, dispatch and eight command bodies in one file.** Each command is already a small function, so this is a file-size observation more than a coupling one.
- **`worker/index.ts` is long.** With the pure logic in `shared/`, what remains is genuinely the composition root, and composition roots are allowed to be long.
