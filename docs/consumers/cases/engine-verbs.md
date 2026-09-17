# engine: two verbs, and three things that do not fit in them — upgrade

**Consumers:** varnick (3 findings), leeandco (1)
**Deployed in production by:** none — varnick has never run. Design opinion,
but each claim below is verified against current upstream, not against their
vendored copy.

`packages/cli/templates/infra/src/types.ts:75-89` defines exactly two verbs:
`apply`, and an optional `destroy`. Three separate consumer workarounds trace
back to that, plus one to the output type.

## 1. No verb for an operator-invoked one-shot irreversible action

varnick's `client-domain` **detects** a domain registration and structurally
cannot perform one. Its `apply` does a single GET and hard-halts, printing a
command to run (`index.ts:211-275`). The actual purchase lives in
`purchase.ts`, which `index.ts` imports from nowhere — a wall enforced by a
closure test that asserts the import does not exist (`index.test.ts:222-227`).

The purchase path is careful work that zbc cannot see: it mints a
least-privilege ephemeral registrar token, spends against a live quote, and
revokes on every exit path — a 15-minute `expires_on` dead-man switch (`:289`)
plus a `finally` delete with a curl shout if the delete fails (`:307-319`).
It is reachable only as an npm script (`package.json:14`).

Half a module lives outside the engine because "buy a domain" is neither
`apply` nor `destroy`.

## 2. `destroy` means "tear down the instance", not "prune the set"

varnick's `client-preview` converges an **unbounded set** from one instance —
N Workers uploaded from source strings in config, each named by content digest,
routes created and repointed, and anything in its namespace the declaration no
longer wants removed (`index.ts:204-281`, `:740-792`).

That pruning had to go inside `apply`, and the module **defines no `destroy` at
all**, because `destroy` tears the whole instance down rather than removing the
set members that left the window. They then had to make deletion safe by hand:
branded types (`asOwnedScript` / `asOwnedRoute`, `:287-314`) gate the delete
calls so they cannot name the client's production Worker (`:574-593`).

Set convergence is a real shape — one instance, N resources, membership
changing per apply — and the two verbs cannot express its middle.

## 3. Outputs are strings, so structured values cannot cross an imports edge

`resolveOutput` (`context.ts:71-85`) returns `string` and throws unless
`typeof value === 'string'`. varnick's `client-account` emits
`nameServers: string[]` annotated *"Ticket 05 consumes this"* (`:343-345`) —
and it cannot travel by reference even on current zbc.

This is small to fix and blocks an obvious case: a module that provisions a set
of things (nameservers, bucket names, worker URLs) can produce them but cannot
hand them to a dependent.

## 4. Teardown sees a different world than apply

leeandco hit the same two-verb boundary from the other side. The engine passes
`imports: {}` to `destroy`, so a config value that resolves from an imported
instance at apply time has nothing behind it at destroy time. Their
`cloudflare-email` handles the asymmetry deliberately: a referenced `zoneId`
**refuses outright** rather than guessing, while `apiToken` falls back to the
secret — which for a client-account instance finds nothing rather than deleting
the wrong thing (`modules/cloudflare-email/index.ts:290-308`, `:645`).

Choosing "refuse" over "guess" per field is exactly the judgment the engine
should make once instead of leaving to every module.

## What it takes upstream

The first three are separable and worth separate decisions:

1. a third verb — or an explicit escape hatch — for operator-invoked one-shot
   actions the engine can at least *see*
2. set-convergence semantics, so pruning is not something each module
   reimplements inside `apply` with hand-rolled type guards
3. non-string outputs across imports (smallest, unblocks a real case)
4. and a stated rule for what `destroy` may assume about imports, rather than
   `imports: {}` and per-module improvisation

## Evidence

- upstream: `packages/cli/templates/infra/src/types.ts:75-89`; `src/context.ts:71-85`
- varnick `client-domain`: `index.ts:211-275`; `purchase.ts:127-228,252-322`; `index.test.ts:222-227`; `package.json:14`
- varnick `client-preview`: `index.ts:167-176,204-281,287-314,574-593,740-792`
- varnick `client-account`: `index.ts:343-345`
- leeandco `cloudflare-email`: `modules/cloudflare-email/index.ts:290-308,404,414,645`
