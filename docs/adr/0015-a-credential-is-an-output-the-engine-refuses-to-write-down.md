# A credential is an output the engine refuses to write down

**Status:** accepted (2026-09-08). Extends the Import rule in [`CONTEXT.md`](../../CONTEXT.md) — `ctx.output` is still the only way a module learns another module's result, still synchronous, and hands the importer the credential verbatim. Nothing about the dependency sort, `destroy`, or [ADR-0013](./0013-readiness-is-a-precondition-of-the-imports-edge.md)'s readiness gate changes.

A module may declare which of its outputs are credentials:

```ts
secretOutputs: {
  tokenValue: { rotates: 'each-apply' },
  s3SecretAccessKey: { rotates: 'each-apply' },
}
```

The engine then does three things, and only three:

1. **Redacts.** Every declared value recorded in a run is scrubbed out of the text the engine prints or throws — an apply's error, a readiness probe's last failure — as `[redacted: <instance>.<output>]`.
2. **Does not persist.** `zbc apply --json` writes `[redacted]` in place of the value. The in-memory `outputs` map, which is what `ctx.output` reads, is untouched.
3. **Refuses an unsafe rotation.** An `ephemeral: true` instance of a module that emits a `rotates: 'never'` credential is a hard error before anything is applied.

A module that declares nothing pays nothing: no new call, no new failure mode, not one changed byte of its output.

## What was wrong

The consumer survey (`bun scripts/consumer-survey.ts`, #117) found this as its largest convergent case, and it is not a module: four consumers, four providers, three independent lineages, all deployed. ceo and foothill's `gcp` mints a service-account key on every apply; foundry's `tailscale-authkey` mints a 15-minute single-use key; leeandco's `cloudflare-token` rolls a scoped token from a mint-only root. Upstream modelled none of it — `cloudflare-token` is our only precedent, and it carries the whole discipline in a doc comment ("minted values live only in memory during the apply, are persisted nowhere") that nothing enforces.

Two counterpoints in the same survey are what make this three rules rather than one:

- foundry's `incus-trust` **refuses to return** its credential at all — it converges a state report instead — because mint-and-return "put a live bearer token into an agent's persisted transcript twice in one morning". A module should not have to give up its output to stay out of a transcript. That is rule 1, and it is why the scrub covers thrown errors and not just logs: the leak was a provider echoing the `Authorization` header back inside the message the engine printed.
- leeandco's `cloudflare-access-service-token` **refuses to rotate**: creates once, prints once, keeps the value out of `outputs`, defines no `destroy`. `cloudflare-token`'s discipline is exactly wrong there, because that credential's consumer is a third party on its own cadence — an agent holding it — and rolling it silently breaks every holder.

So the axis is not ephemeral vs long-lived. It is **who consumes the credential**: the apply itself, or someone outside it. `rotates` is that axis and nothing else, which is why it has two values and no default — a module author declaring a credential has to answer the question.

## Why the engine, and why here

Rule 3 can only be enforced where the two halves meet. `ephemeral` is a property of the *instance* (ADR-0014's sibling rule, `packages/infra/environments/<env>/…`); `rotates: 'never'` is a property of the *module*. Neither file can see the other, and the failure they compose is silent: the apply succeeds, and the breakage surfaces wherever the holder is. So it is checked alongside `assertEphemeralDestroyable`, before anything is applied.

Rule 1 is the engine's because the leak is the engine's output. It is deliberately literal-substring: the shape of the leak is a longer message containing the value, not a field named `token`.

## What this does not do

- It does not reach a **module's own** `console.log`, or the inherited stdio of a child process a module spawns (`wrangler`, a build command). Those bytes never pass through the engine. A module that prints its own credential is still the module's bug.
- It does not decide **retention or mint-avoidance**. `gcp` pruning to `maxKeys` so in-flight preview Workers keep working, and `tailscale-authkey` skipping the mint when the node is already online, are policies about a provider's own resource lifecycle; they are module config, and this ADR is what lets them be written without also hand-rolling redaction.
- It does not redact **ids**. `tokenId` and `s3AccessKeyId` name the credential rather than being it, and hiding them costs the operator the one field that finds the token in a dashboard.

## Alternatives considered

**Never return the credential — converge a state report, as `incus-trust` does.** Correct for `incus-trust`, whose caller wants to know whether a node is enrolled; useless for `cloudflare-token`, whose entire purpose is handing a dependent a value to deploy with. Modelling only the first is the half-feature the ticket warned about.

**Redact by key name (anything called `*token*`, `*secret*`).** Guesses, and guesses in both directions: it hides `tokenId`, which the operator needs, and misses `s3SecretAccessKey`'s hash-derived sibling in a module that spells it differently. The module knows; ask it.

**Encrypt outputs written by `--json` instead of redacting them.** Moves the credential to disk under a key that also has to live somewhere, on the one path — a CI job reading a deploy URL with `jq` — that never wanted the credential in the first place.
