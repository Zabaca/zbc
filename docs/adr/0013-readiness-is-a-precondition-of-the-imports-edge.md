# Readiness is a precondition of the imports edge, and the module owns the proof

**Status:** accepted (2026-09-07). Extends the Import rule in [`CONTEXT.md`](../../CONTEXT.md) — `ctx.output` is still the only way a module learns another module's result, and it is still synchronous. Nothing about the dependency sort, `ephemeral`, or `destroy` changes.

A module may declare `ready: { proves, probe, timeoutMs?, intervalMs? }` beside its `apply`. The engine then **holds that instance's outputs at every `imports` edge until the probe succeeds**, retrying while the probe throws or returns `false`, and failing the whole apply when the budget is spent. A module that declares nothing is untouched: no extra call, no extra latency, no new failure mode.

## What was wrong

Every provider in the consumer survey (`bun scripts/consumer-survey.ts`, #117) returns success from a create call before the created thing works. Four consumers hit it across three providers, and all four hand-rolled a retry loop inside a module:

- **ceo + foothill, `gcp`** — a just-created service account 404s its own keys endpoint; a just-minted key is briefly rejected by the token grant.
- **leeandco, `cloudflare-token`** — a fresh token carrying `D1 Read`/`D1 Write` was refused by D1 with error `10000`, and accepted about five seconds later (2026-08-14).
- **foundry, `tailscale-authkey`** — device state lags, and reading a field that did not exist yet made every device look offline, minting a key on every apply.

They each wrote a loop because there was nowhere reusable to put one. But a retry helper is not the missing piece — everyone could write that, and did. What was missing is a place for the engine to know that an output is not yet worth handing to anybody.

## Why the module owns the probe

The obvious shape is a generic liveness check the engine performs. leeandco's measurement rules it out. Across three trials on 2026-08-15, `/tokens/verify` returned 200 at 112/111/202 ms while the scope-gated call was still being refused at 1621/610/808 ms. A token that authenticates perfectly and cannot act is the exact failure being fixed, so a probe that only proves authentication proves the wrong thing.

Readiness has to be probed against **the capability the caller will actually use**, and only the module knows what that is. So `proves` is a sentence the module writes, `probe` is a call the module makes, and the engine owns only the two things that are genuinely the same everywhere: when the proof is demanded, and what happens while it is refused.

## Why the edge, and not the end of `apply`

Gating inside `apply` would have been fewer lines. It is the wrong place for two reasons.

The cheap one: a probe is provider traffic, and charging every apply for a wait nobody is waiting on is how a contract gets worked around. An instance nothing imports is never probed.

The load-bearing one: the edge is the only place the engine knows a reader exists. "Usable" is not a property of a resource in isolation — it is a claim about someone about to use it, which is the same reason the probe is the module's. A probe with no reader proves nothing about a reader.

The same rule holds on the destroy path, where `ctx.output` applies an imported instance on demand: that handover is the same edge, minting the same credential into the same window.

## What is deliberately dumb

**Any throw, or `false`, means "not ready yet."** Nothing here can tell a transient refusal from a permanent one, and neither could the four loops this replaces. The budget expiring is what turns one into the other — after which the apply fails with the instance, the module, what was being proven, the elapsed time, the attempt count, and the last failure the provider reported.

**Only an explicit `false` is a refusal.** A probe whose body is a provider call returns that call's result; demanding `true` back would make every such probe a silent forever-loop.

**The knobs live on the module, not the instance.** How long a provider takes to make a thing usable is a fact about the provider, not a per-environment preference. Defaults are 60s at 1s intervals; `cloudflare-token` declares 30s at 2s.

**The proof is memoised per run, not per edge.** Two importers of one instance wait on one probe — the promise is memoised, so they do not race two.

## The first module to declare one

`cloudflare-token` probes the **minted** token — not the root, whose own permissions say nothing about whether the new one works — against a small table mapping granted **read** permission-group names to a `GET` that exercises them (`D1 Read` → `/accounts/{id}/d1/database`, and five more). Read groups only: write does not imply read on Cloudflare, so probing a write-only grant would fail forever on a token that is working perfectly.

A token granted no probeable read group falls back to the account-owned token verify (`/accounts/{id}/tokens/verify`, not the user-scoped one — this module mints account-owned tokens) — the weaker claim, kept because it still catches a token id the API does not yet acknowledge, and labelled as weaker rather than presented as the same thing. Zone-scoped probes are absent: they need a zone id the outputs do not carry. The table is allowed to be incomplete and is never wrong — a permission with no entry simply contributes no probe.
