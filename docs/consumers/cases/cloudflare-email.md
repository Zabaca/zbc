# cloudflare-email — upgrade

**Consumers:** leeandco, qom, railmid  ·  **Deployed in production by:** leeandco, qom, railmid
**Independent lineages:** 2. qom's module is leeandco's file with the punctuation changed, copied for `apiToken`.

## What they needed

**A credential other than `CLOUDFLARE_API_TOKEN`.** Email Sending is
account-scoped, and a `send_email` binding reads as bound either way: leeandco's
lead notifications were refused for a day after its Worker moved into the
client's account on 2026-08-14 without the sending domain. leeandco's and qom's
client accounts hold one credential at rest, a root whose only write is
minting; the rest are minted per apply by `cloudflare-token` and arrive through
`imports`. Their `CLOUDFLARE_API_TOKEN`, the only token main's module reads, is
Zabaca's. railmid, on one account, widened its deploy token by hand, against
its own rule for zone-scoped modules: "never the deploy token".

**A zone given by something other than its id.** Every call but two is under
`/zones/<id>/`, and nothing an instance file carries yields the id. railmid's
placeholder stopped its 0.5.0 release. leeandco and qom reference their
`cloudflare-zone` instance's `zoneId`, which also orders the applies; cedarpad,
ceo, foothill-metabolic, web and zbc's own `email.ts` paste the id into the
unmodified module.

## The interface, from 2 implementations

leeandco's edit (2026-08-15) and railmid's (2026-09-06) share no code.

| | leeandco, qom | railmid | main |
|---|---|---|---|
| zone | `zoneId`, a literal or `{ from, output }` | exactly one of `zone` (a name) and the same `zoneId` | `zoneId`, a literal |
| token | `apiToken?: { from, output }`, else `CLOUDFLARE_API_TOKEN` | `CLOUDFLARE_API_TOKEN` | `CLOUDFLARE_API_TOKEN` |
| destroy | refuses a referenced `zoneId`; the token falls back to the secret | resolves the zone as apply does | the literal and the secret |

**They agree** on `zoneId` as a literal or a reference to `cloudflare-zone`'s
output, and on resolving zone and token once, up front.

**Only railmid takes a name**, and not as a quirk: neither it nor any repo that
pastes an id converges its zone, so there is nothing to reference. Main's
`cloudflare-zone` and `cloudflare-tunnel` already take a name.

**Only leeandco and qom take `apiToken`**, in the shape `cloudflare` and `d1`
take on main. Each mints narrow tokens: leeandco one per half, qom one for
sending.

**The destroy row is not interface.** leeandco's refusal assumes teardown gets
`imports: {}`, untrue since zbc-cli-v0.16.0 applies imports on demand.

## What it takes upstream

A change inside `packages/cli/templates/infra/modules/cloudflare-email/` and its
docs: the engine already has `ctx.output`, the readiness gate and
`tokenValue`'s redaction, and `cloudflare-api` the `{code, error}` parsing
leeandco's fork also carries.

1. **`apiToken: z.object({ from, output }).optional()`**, resolved like d1's
   `apiTokenFor` in apply and destroy, as `cloudflare-api` documents for every
   Cloudflare module. The 10000 hint, registry, plugin catalog row and
   `README.md` stop saying it always reuses `CLOUDFLARE_API_TOKEN`; the hint
   names the reference when one is set (d1's has the same flaw; see
   [d1](./d1.md)), and only the failing half's scopes, not the five that
   sending-only railmid added and cedarpad's instance lists. The test pinning
   five changes with it.
2. **`zoneId` as a literal or a `{ from, output }` reference**, read with
   `ctx.output`, the union the module already has for worker names. Both forks
   read `ctx.imports`, railmid's in destroy too, where it holds only what is
   already applied.
3. **Optionally `zone`, a name**, exactly one of the two, resolved once with
   `cloudflare-zone`'s exact-name match and account check (railmid's `zones[0]`
   has neither), since this module's failure is onboarding into the wrong
   account. It needs Zone Read, as routing does; the inbox app's printed
   instance stops asking for a pasted `zoneId`.

**Until then, main drops `apiToken` silently.** Its plain `z.object` strips
unknown keys and `zbc apply` runs no typecheck, so `apiToken` beside a literal
`zoneId` parses and runs on `CLOUDFLARE_API_TOKEN`: for leeandco or qom, "a
successful apply against the wrong tenant", in leeandco's words. All three
consumers' own instances fail at parse instead. Copy-mode `zbc update` re-lays
main's module over leeandco's and qom's forks, and pasting an id past that
failure is this case. Replacing the forks is
[distribution-drift](./distribution-drift.md)'s subject; the sender-domain test
all three carry is [cloudflare](./cloudflare.md)'s.

**Left open:**

- **Destroy.** The change lets a full `zbc destroy production` reach a client's
  live sending domain, which leeandco reserves for "a deliberate act by a person
  with the right credential"; whether it may is [d1](./d1.md)'s question about a
  database.
- **Apex SPF.** Main says onboarding adds an SPF record to merge by hand with
  any already there, and cedarpad's instance, sending from an apex with
  routing's SPF, says to check and merge "if needed". leeandco and qom,
  onboarding subdomains, each measured on 2026-10-06 that the record lands at
  `cf-bounce.<domain>`; web, onboarding the zabaca.com apex on 2026-09-14,
  found nothing written there; cedarpad's own ADR, written once its apex was
  live, lists only `_dmarc.cedarpad.com` and `cf-bounce.cedarpad.com`. If so,
  main's caveat is wrong; web's runbook says it applies to an apex "onboarded
  the old way".
- **The bar.** zbc ships to companies that are not Zabaca, so the token half
  turns on how common leeandco's and qom's shape is: a client's site in the
  client's own Cloudflare account. The zone half came from single-account
  railmid.

## Evidence

- **leeandco**, forked from `74c795d`, diverged in `3c2357b` (named at
  `index.ts:67`). Under `packages/infra/`:
  - `modules/cloudflare-email/index.ts:28-51` (both keys, the root,
    `imports: {}`), `:76-131` (`{code, error}`), `:261-307` (wrong tenant at
    `:283-286`), `:403,412`, `:434-438`, `:627-651` (quoted at `:637-639`)
  - `environments/production/leeandcoconstruction-email.ts:11-26` (the lost
    day), `:59-65` (SPF), `:100-140`; `leeandcoconstruction-inbound.ts:99-123`;
    `leeandcoconstruction-email-token.ts:81-96`;
    `leeandcoconstruction-inbound-token.ts:69-86`
  - `tests/production-instances.test.ts:1245-1252` (sender domain)
- **qom**, leeandco's file (`index.ts:28-31`):
  - `packages/infra/environments/production/qualityom-email.ts:12-16` (SPF),
    `:37-48`; `qualityom-email-token.ts:14-18,29-37`
  - `packages/infra/tests/qualityom-email.test.ts:45-57`
  - `docs/adr/0007-one-root-token-mints-every-credential-in-the-client-account.md:6-14`
- **railmid**, forked from `9224fda`, edited in `274248a`:
  - `vendor/zbc/modules/cloudflare-email/index.ts:288-311` (`zones[0]` at
    `:304`), `:315-370`, `:382-386`, `:578-582`
  - `packages/infra/environments/production/railmid-email.ts:38-47` (deploy
    token), `:60-69`; `railmid-redirect.ts:44-45` (the rule)
  - `packages/infra/test/email.ts:103-112` (sender domain), `:138-145`
    (placeholder)
- **Pasted ids**, in `packages/infra/environments/production/`: cedarpad
  `canvas-email.ts:63-64` (sending only, five scopes `:33-35,48-52`; SPF
  `:41-46`, and at its root
  `docs/adr/0020-passwordless-auth-on-cloudflare-email-sending.md:3,63,80-81`);
  ceo `roamside-email.ts:16-17`; foothill-metabolic `foothill-email.ts:20-21`;
  web `web-email.ts:30-31` (SPF `:17-19`, and at its root
  `docs/runbooks/email-sending-zabaca.md:17-25`); zbc `email.ts:17-18`. None of
  these repos, nor railmid, has a `cloudflare-zone` instance for that zone.
- **main**, under `packages/cli/`:
  - `templates/infra/modules/cloudflare-email/index.ts:27-28` (SPF), `:39-45`
    (hint), `:59-75` (worker-name union), `:142,149` (the two account calls),
    `:216-231` (`zoneId` at `:220`), `:243,453` (token), `:326` (Zone Read);
    `registry.json:9,12`; `index.test.ts:138`
  - `templates/infra/modules/`: `d1/index.ts:31,130-137,151`;
    `cloudflare/index.ts:475,642-644`; `cloudflare-zone/index.ts:199,662,684-698`;
    `cloudflare-tunnel/index.ts:113`; `cloudflare-api/index.ts:31-73` (read by
    this module since `8692752`), `:249-251`;
    `cloudflare-token/index.ts:237-240`
  - `templates/apps/inbox/registry.json:8`; `plugin/skills/zbc/modules.md:23`;
    and, at the repo root, `README.md:220`
  - `src/engine/discover.ts:31`, `apply.ts:60,86-91`, `destroy.ts:64-87`,
    `on-demand.ts:1-16` (the mechanism since `736f8d4`, #114, first in
    zbc-cli-v0.16.0); `src/utils/copy-refresh.ts:165-181` (a built-in re-laid
    by name)
