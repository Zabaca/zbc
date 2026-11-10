# A retained instance is never destroyed, and the instance carries no destroy to call

**Status:** accepted. Extends the **Ephemeral** rule in [`CONTEXT.md`](../../CONTEXT.md): whether an instance's resource may be torn down is a property of the instance. Nothing about the dependency sort, the imports edge, [ADR-0013](./0013-readiness-is-a-precondition-of-the-imports-edge.md)'s readiness gate or [ADR-0016](./0016-a-credential-is-an-output-the-engine-refuses-to-write-down.md)'s secret outputs changes.

An instance may say `retain: true`, beside `name` and `ephemeral`. Then:

- **`zbc destroy <env>`** tears down every other instance as before and leaves this one standing, printing that it did.
- **`zbc destroy <env> <this instance>`** is refused with an error naming the instance, and nothing is destroyed.
- **`retain` with `ephemeral`** is refused when the instance is declared, before anything is applied.
- **`zbc list`** reports `retain`, and reports the instance as not destroyable.

## What was wrong

A module's `destroy` answers "how is this resource torn down", and for a database or a bucket the honest answer is "delete it". `d1`'s destroy deletes the database; `r2`'s deletes the bucket when it is empty. That is right for a preview's scratch database, and it is the wrong answer for a production database of records: `zbc destroy <env>` runs every module's destroy in reverse order, unconfirmed, and the same module backs both.

Consumers worked around it in four ways, each recorded in the d1 case of the consumer survey: a module with no `destroy` at all, a deploying module that creates a database and never deletes one, a destroy that reads a credential the environment does not hold so finds nothing to delete, and keeping the deleting destroy because leaving rows behind seemed worse. The first two give up teardown for every instance of the module, including the scratch ones; the third works by accident.

## The decision

**The instance opts out, not the module.** The question is the environment's, exactly as for `ephemeral`: one `d1` module backs a preview database that should be thrown away and a production one nobody may delete. A module-level key would have to be added to every module that deletes something, each with its own spelling, and the bar for "deletes something that matters" is not one a module author can judge for every caller.

**The instance carries no destroy, rather than a flag the engine must remember to read.** `defineModule`'s `instance()` returns a retained instance whose `_definition.destroy` is removed. The engine reads `retain` only to say why it skipped the instance and to refuse a targeted destroy. The reason is version skew: the engine ships in the CLI, `define-module.ts` ships in the vendored `src`, and the two move independently. An engine older than this decision has never heard of `retain`, and would call a destroy it was handed; handed none, it skips the instance as it skips any module without one.

**A targeted destroy is refused, not skipped.** Skipping is right for a whole environment: the operator asked to tear down everything that may be torn down. Naming one instance is a request about that instance, and a skip line in the output reads like success.

**A destroy that reads a retained instance's output applies it on demand.** A full-environment destroy starts with no outputs, so when an instance's `destroy` reads an import (`ctx.output`), the engine applies that import first. For a retained import it does the same, and the import's `apply` is the ordinary idempotent one: it adopts the live resource, or creates it if it is absent. The run then leaves it standing, and says that instead of the usual "the run tears it down below". Refusing was the alternative. It would make the importer's destroy impossible, because there is no other way to read the output in that run.

## What was rejected

**A module config key (`destroyable: false`, `keepOnDestroy`).** It works only in modules that remember to read it, and every deleting module would grow its own. The instance option covers every module, including a consumer's own.

**A `destroy` that refuses whenever the resource holds data.** That cannot be decided generally: a bucket's emptiness is cheap to check and a database's is not, and a resource that is empty today is still the one nobody may delete.

**Deleting the module's `destroy`.** That gives up the preview case to protect the production one.

## Consequences

- **It needs the vendored `src` that carries it.** The protection lives in `define-module.ts`. A project whose `src` predates `retain` still passes the key through the instance file at runtime (Bun does not typecheck) and silently ignores it; its typecheck fails on the unknown key. Take `zbc update` (or, in copy mode, the refreshed `packages/infra/src/`) before relying on it. An older CLI over a newer `src` is safe: it skips the instance, though as "no destroy" rather than "retained", and a targeted destroy is skipped rather than refused.
- **Deleting a retained resource is a reviewed change or a hand act.** Remove `retain` in a commit, then destroy; or delete it in the provider's own console. Neither can happen as a side effect of `zbc destroy`.
- **On-demand apply can create a retained resource during a destroy**, when it was absent and another instance's destroy reads it. It is then left standing like any retained resource. The apply log says so.
- **`retain` says nothing about the provider.** It is what zbc will do, not a lock on the resource: anyone with the credential and the console can still delete it.
