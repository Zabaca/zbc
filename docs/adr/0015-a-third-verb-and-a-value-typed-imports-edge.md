# A third verb for what an operator does once, and an imports edge that carries values

**Status:** accepted (2026-09-08). Extends the Import rule in [`CONTEXT.md`](../../CONTEXT.md)
and sits alongside [ADR-0013](./0013-readiness-is-a-precondition-of-the-imports-edge.md)
(readiness) and [ADR-0014](./0014-a-binding-is-filled-in-by-the-deploying-module.md)
(bindings). Nothing about the dependency sort, `ephemeral`, or `destroy` changes,
and no existing module has to change at all.

Two changes, both additive:

1. A module may declare **`actions`** — named, operator-invoked verbs — beside
   `apply` and `destroy`, run only by **`zbc run <env> <instance> <action>`**.
   An action marked `irreversible` refuses without `--yes`.
2. **`ctx.outputValue(ref, field)`** resolves an imported instance's output of
   any shape. `ctx.output` keeps its string contract and now says *why* when the
   output exists but is not a string.

## What was wrong

`types.ts` defined exactly two verbs. The consumer survey (`bun scripts/consumer-survey.ts`, #117)
found four workarounds tracing back to that; two of them are this ADR, and the
other two are settled elsewhere — see **What this does not decide**.

**There was no verb for a one-shot irreversible act.** varnick's `client-domain`
*detects* a domain registration and structurally cannot perform one: its `apply`
does one GET and hard-halts, printing a command for a human to run. The purchase
lives in a `purchase.ts` that `index.ts` imports from nowhere — a wall enforced
by a closure test asserting the import does not exist — because putting it in
`apply` would make `zbc apply preview` buy a domain, and there was no other
place to put it. Everything careful about that code is invisible to zbc: a
least-privilege ephemeral registrar token, a 15-minute `expires_on` dead-man
switch, a `finally` delete that shouts a curl command if the delete fails. It is
reachable only as an npm script, which is also outside the graph, outside the
decrypted secrets, and outside the imports edge the act needs.

`apply` was the wrong home for two independent reasons, and only the first is
about danger: an action is not idempotent and not convergent, so it does not
answer the question `apply` exists to answer ("is the world as declared?").

**Outputs were strings.** `resolveOutput` returned `string` and threw unless
`typeof value === 'string'`. varnick's `client-account` emits
`nameServers: string[]`, annotated "Ticket 05 consumes this" — a value that
could not cross an imports edge at all, so the consuming instance re-derived it
from the provider. Worse, the failure message was `which doesn't emit it`, which
sends the reader to the emitting module to add an output that is already there.

## The decision

### `actions`

```ts
defineModule({
  name: 'client-domain',
  …,
  actions: {
    purchase: {
      description: 'Register the domain with the registrar',
      irreversible: true,
      run: async (config, ctx) => { … },
    },
  },
})
```

Four rules, and they are the whole design:

- **An action is never run by `apply` or `destroy`.** `zbc apply` remains the
  only thing that converges the world, and it converges nothing new.
- **`zbc run` does not apply the instance.** The operator named one action; the
  instance's own `apply` is a different command.
- **An action returns nothing.** An instance's outputs are its `apply`'s. An
  action that wanted to change them would be converging.
- **`irreversible` refuses without `--yes`**, and refuses *before* the config is
  parsed and before any import is applied — so a refusal has provisioned
  nothing.

An action's imports resolve exactly as a full-environment `destroy`'s do: on
demand, applied when the body asks, never when it doesn't. That mechanism was
already in `destroy.ts` for #124; it now lives in `engine/on-demand.ts` and both
verbs share it, so they cannot drift about what "not applied yet" means. The one
difference is deliberate: what an action's on-demand apply creates is left
standing, because it is a thing the environment declares and `zbc apply <env>
<instance>` would have created it anyway — whereas a destroy's on-demand apply
is only ever torn down again in the same pass.

`zbc run <env> <instance>` with no action lists what the instance declares, and
`zbc list` reports actions per instance, so the verb is discoverable without
reading a module's source.

### `ctx.outputValue`

`ctx.output` stays `string`, because every existing consumer of an output — a
worker secret, a `--var`, a wrangler binding field — is a string, and widening
the return type would push a type check into every module that has one today.
`outputValue` is the same edge without the string rule:

- Absence is unchanged: `undefined` and `null` are the same `doesn't emit it`
  failure, with the same three messages telling the same three fixes apart.
- There is no `allowBlank`, because there is nothing for it to mean: `0`,
  `false` and `''` are values the module asked for. The blank rule belongs to
  `output`, where an empty string really is ambiguous.
- It returns `unknown`, not a caller-supplied generic. The engine validated the
  emitting module's `outputsSchema` before the value crossed, but nothing at the
  reading end knows *which* module the ref names, so a type parameter would be
  an unchecked assertion wearing a check's clothes.

And `ctx.output` on a present non-string now reads
`… which emits an array, not a string — read it with ctx.outputValue instead`.

## What this does not decide

**`destroy` still means "tear down this instance", not "prune the set".**
varnick's `client-preview` converges an unbounded set from one instance — N
Workers named by content digest, routes repointed, anything the declaration no
longer wants removed — so pruning had to go inside `apply` and the module
defines no `destroy` at all. A pruning verb is a different shape from all three
verbs here: it needs the engine to know which provider objects an instance
*owns*, which is ownership metadata no module reports today, and getting it
wrong deletes a client's production Worker. varnick made deletion safe by hand
with branded `asOwnedScript`/`asOwnedRoute` types precisely because nothing
generic could. That is worth doing and is worth its own investigation; adding a
fourth verb here without the ownership half would ship the danger and none of
the safety.

**Teardown seeing a different world is already fixed.** The engine no longer
passes `imports: {}` to `destroy` — that was #124, and this ADR only moves the
mechanism into a file two verbs can share.

## Consequences

- A module that declares no `actions` is untouched: no new call, no new failure
  mode, one optional key.
- `zbc run` is a new surface an operator can invoke against production. It is
  gated by nothing but `--yes` on irreversible actions, deliberately: the
  operator typed an instance name and an action name, which is more intent than
  `zbc apply production` requires.
- `ListedInstance` (the `zbc list --json` document) gains an `actions` array.
  Consumers parsing that JSON see a new key; nothing existing changed shape.
