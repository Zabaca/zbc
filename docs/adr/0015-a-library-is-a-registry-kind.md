# A library is a registry kind, and a manifest names the siblings it imports

**Status:** accepted (2026-09-08). Extends the registry manifest described in [`CLAUDE.md`](../../CLAUDE.md) and adds a **Shared Library** entry to [`CONTEXT.md`](../../CONTEXT.md). No engine change: `defineModule`, the dependency sort, `ctx.output` and [ADR-0013](./0013-readiness-is-a-precondition-of-the-imports-edge.md)'s readiness gate are untouched.

`registry.json` gains a third `kind` — **`library`** — and a `modules` key usable by any kind: the sibling directories whose code this one imports as `../<name>`. `zbc add` installs that graph first, transitively and cycle-guarded, and tells the caller what a library is for (import it) rather than offering it an instance file it cannot have.

## What was wrong

zbc's unit of distribution is a module directory, so code shared *between* modules had to be shaped like a module and parked beside the real ones. Four bundled directories already were exactly that — `cloudflare-api`, `host-exec`, `incus-core`, `provision-core` — and the only place that fact was recorded was the `instructions` string, which opens with a sentence written for a human reading post-install output:

> Not a module: it exports no defineModule and declares no instance.

Two consumers reached the same shape independently and unprompted. varnick's `client-core` holds the Cloudflare fetch envelope and a credential resolver, imported by all three of its real modules; its header records that three copies of the resolver existed first. foundry's `tailscale-core` holds an OAuth exchange and a zod schema fragment spread into two modules' config schemas, and its header names our own `provision-core` as the precedent it copied. The pattern was already upstream. It just was not a *thing*.

The second half was worse because it was mechanical. `host-exec`'s manifest ended:

> In COPY mode `zbc add host-dir` copies only host-dir — run `zbc add host-exec` as well, or the relative import dangles; the registry manifest has no field for one module depending on another.

Six manifests carried some version of that sentence. It is a build-order instruction addressed to whoever reads post-install text carefully, and its failure mode is a relative import that resolves to nothing — in the consumer's repo, after the copy, at the moment they first run apply.

## What is true now

- **`kind: "library"`** is declared, not narrated. A library is a directory with the module shape that defines no module: `zbc add` installs it the same way, prints `installed (library)`, and ends with "import it from a module beside it as `../<name>`" instead of the instance-file line.
- **`modules: [...]`** names code dependencies for every kind. `zbc add vm-provision` in copy mode now lands `host-exec`, `incus-core` and `provision-core` too — `incus-core` pulling `host-exec` through its own manifest, which is why the walk carries a seen-set rather than one level of recursion. Vendor mode already had every file present; it installs only the dependencies each manifest declares.
- **`validateRegistry`** runs before anything is copied. A kind that is not one of the three is refused by name, and a non-app declaring `targetDir`/`instanceFile` is refused too — a typo'd kind falling through to the `module` default would install a library and then tell the caller to write an instance file importing it.
- **The claim is checked.** `registry-shape.test.ts` reads every bundled directory's `index.ts` and asserts the declared kind agrees with whether it calls `defineModule`, and that every `../<name>` the source imports is declared in `modules` — and resolves. The instructions field goes back to being prose for a human.

## Why not the alternatives

**A separate `libraries/` directory.** It splits the resolution path (`zbc add`, vendor mode, the census sentence, `secret.ts`'s scan all walk `modules/`) to encode something one field says, and it would break every consumer's existing `../cloudflare-api` import.

**Infer it — no `kind`, just look for `defineModule`.** That is what the shape test does, and it is fine for *checking* a claim the author made. Making it the mechanism means the CLI decides what a directory is by parsing its source, and a library that grows an unrelated mention of `defineModule` changes kind by accident.

**Publish libraries to npm.** A shared library here is edited alongside the modules that import it, in the same subtree pull, at the same version. A package boundary buys nothing and adds a release step to a one-line fix — and [ADR-0005](./0005-subtree-distribution-zbc-core.md) already chose the subtree over the registry for exactly this code.
