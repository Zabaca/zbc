# Zone settings and Access do not belong in the deploying module

**Status:** accepted (2026-09-08). Numbered 0016; [ADR-0015](./0015-a-library-is-a-registry-kind.md) landed on main while this was being written. Answers the question posed by the `cloudflare` consumer case: whether one consumer inlined zone settings, Zero Trust organisation identity, Access applications and pre-deploy R2 by preference, or because our split could not express the ordering they needed.

**They inlined by preference.** Composition expresses every one of those four orderings today, through the `imports` edge and the two rules already hung on it — [ADR-0013](./0013-readiness-is-a-precondition-of-the-imports-edge.md)'s readiness gate and [ADR-0014](./0014-a-binding-is-filled-in-by-the-deploying-module.md)'s `bindings`. So `cloudflare` stops growing: it gains nothing from this decision and remains the repo's only Deploy Module, orchestrating build and deploy against topology the consuming package owns.

The one thing composition could not express was not an ordering at all. It was a **resource nobody owned**: no module converged zone-level settings, so `always_use_https` was a dashboard toggle. That lands in `cloudflare-zone`, which already owns the zone.

## What was wrong

One consumer's `cloudflare` had grown to 545 lines against the 242 it was forked from, and everything added was state _around_ the Worker rather than the Worker: zone settings, Zero Trust organisation identity, Access applications and policies, and R2 bucket creation performed before the deploy.

Two outages drove it, and both are real:

- `always_use_https` was off on a zone, so `http://` was served as-is. A non-secure context has no Geolocation API, and **8 of 8 insecure drives produced zero chapters.** Nothing in the repo said the setting should be on, because nothing in the repo could say it.
- A hostname was **public for twenty minutes** because putting Access in front of it was a manual dashboard step that came after the deploy.

Read carelessly, those two facts argue for the inlining: both failures are "the Worker shipped before the state around it was right", and one module doing both cannot get the order wrong. That is the argument this decision rejects.

## Why composition is enough

`imports` is an ordering edge before it is an output edge. The engine applies an imported instance first, and nothing requires the importer to _read_ an output for the edge to hold. So each of the four cases has an existing shape:

| What was inlined                            | How it composes                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2 bucket created before the deploy         | An `r2` instance, imported, its bucket name reaching `wrangler.jsonc` through `r2Bindings` — the ADR-0014 code path. The bucket exists before the deploy because the deploy imports it.                                                                                 |
| Access application in front of the hostname | A `cloudflare-access` instance imported by the deploying instance. The application and its policies exist before the Worker is reachable, for the same reason.                                                                                                          |
| Zero Trust organisation identity            | Already `cloudflare-access`, and deliberately so: `teamDomain`, `orgName` and `identityProviders` are properties of the whole organisation rather than of one application, and folding them into a per-Worker module makes every Worker an owner of account-wide state. |
| Zone settings                               | Nothing owned it. See below.                                                                                                                                                                                                                                            |

The ordering constraint the ticket asked about — a `wrangler.jsonc` binding to a resource that does not exist yet fails the deploy — is exactly the constraint ADR-0014 was written for, and it is closed. A fresh Cloudflare token being refused by the very scope it was granted is ADR-0013's, and that is closed too. Neither is a reason to inline.

The reason not to inline is the cost of doing so, and it is paid by the consumer rather than by us. A `cloudflare` that owns the zone owns it _per Worker_: two Workers on one zone are two instances converging one set of settings, and the last apply wins. A `cloudflare` that owns the Zero Trust organisation makes every deploying instance a writer of state every other application in the account shares. The split is not tidiness; it is the only shape in which "who owns this" has an answer.

## What changes

`cloudflare-zone` gains a **`settings`** key: a closed set of zone-level settings (`always_use_https`, `automatic_https_rewrites`, `ssl`, `min_tls_version`) it converges, with the plan computed before anything is written.

Its rule is deliberately **not** the record rule, and the asymmetry is the interesting part. `cloudflare-zone` is authoritative over records and reports undeclared ones as drift, because an undeclared record is a real thing somebody added by hand. A zone carries _every_ setting at all times, so "present in Cloudflare and declared nowhere" cannot be said about one. Therefore settings are **forward-only**: what is declared is converged; what is not declared is not read, not reported, and not touched. There is nothing to delete, so there is no `allowDelete` half to this key, and the module still has no `destroy`.

Two states refuse rather than write, both in the plan and both ahead of the first record mutation:

- a setting that must **move** and which the zone reports with `editable: false` — on Cloudflare that means the setting is gated on the account's plan. The value is compared before `editable` is consulted, deliberately: Cloudflare reports the effective value of a gated setting alongside the flag, so a zone that already holds the declared value converges. Refusing there would make the whole instance — records included — permanently un-appliable over a no-op.
- a setting absent from the zone's own settings list — an id Cloudflare does not offer here, which would 404 halfway through a converge.

Refusing before the record writes is the point. A settings failure discovered after half the records had been created leaves the zone in a state neither the instance file nor the previous apply describes.

## The adjacent lineage, and what it turned out to cost

The consumer case also flagged `cloudflare-access` as a _parallel lineage rather than a fork_ — theirs predates ours — and named three facts to reconcile. All three are already in our module, which is the useful outcome of reading it as convergence:

- a `service_token` include requires `decision: 'non_identity'`; on an `allow` policy it admits nobody while looking configured. Ours compares the decision per policy and `planPolicies` is the seam that keeps people and machine policies from sharing one loosened check.
- `PUT /access/organizations` rejects `{name}` alone and needs `auth_domain`. Ours refuses `orgName` without `teamDomain` for exactly that reason, and only ever echoes the live `auth_domain` back rather than choosing it.
- an organisation offering only the `cloudflare` identity provider makes a correct-looking policy admit nobody. Ours reports what a person may actually sign in with, counting undeclared providers, and names the fix.

So the Access half of this case is closed by verification, not by code.

## Consequences

- `cloudflare` is unchanged, and "does this belong in the deploying module?" now has a written answer to point at.
- A consumer securing a zone writes `settings: { always_use_https: 'on' }` on their `cloudflare-zone` instance. The recorded outage becomes a line in a file and a failing converge instead of a toggle nobody set.
- Widening the setting list is a schema edit. It stays a closed list so that a typo in an id or a value is refused at the boundary rather than at the PATCH.
- Ordering across all of this remains the `imports` edge. If a future case genuinely cannot be expressed there, that is a finding about the edge — and the fix belongs to the engine, not to a module that grew a second job.
