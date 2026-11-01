# cloudflare-zone — upgrade

**Consumers:** leeandco, qom, ceo, varnick  ·  **Deployed in production by:** leeandco, qom, ceo

## What they needed

**Creating the zone.** Main converges only a zone that exists; an empty lookup
throws `Zone "…" not found` (`cloudflare-zone/index.ts:680-690`). Cloudflare
Registrar makes the zone for a domain bought through it; a domain registered
elsewhere has none until someone does. leeandco's module created one for its
client's Squarespace domain on the first apply; qom added its client's, at Network
Solutions, in the dashboard, "the one piece of the account not created from
this repo" (qom ADR-0007:43-45).

**Only in the declared account, and only when absent.** Cloudflare filters the
zone list by token permissions rather than refusing, so "no such zone"
and "this token cannot see it" read the same (leeandco and varnick both record
it). A zone for leeandco's domain once landed in Zabaca's account and was
deleted (2026-08-14).

**Replacing a record at its name** (leeandco): done by hand (§2).

**Zone settings** (ceo): closed, with two loose ends (§3).

## The interface, from two implementations

One design, not two. foundry wrote both halves on 2026-08-05: `cloudflare-zone`,
which refuses an absent zone, and `client-account`, which creates zones.
`client-account` moved to varnick; leeandco ported `cloudflare-zone` and added
creation (2026-08-14), citing foundry's lesson that an empty list proves
nothing; upstream promoted `cloudflare-zone` with neither creation half
(`04a73e1`, 2026-08-19). What leeandco's shares with main, wrong-account
refusal and no `destroy` included, is foundry's code, not convergence. Only
leeandco's has run; varnick has no environments.

Both chose:

- `POST /zones` with the declared account and `type: 'full'`, since a partial
  setup leaves the nameservers where they are.
- Creation in `apply`, converging because the next apply finds the zone, and no
  `destroy`: a new zone answers for nothing until a registrar points at it;
  deleting one detaches a live domain.
- The zone's status beside its nameservers, and what this apply created.

They differ on:

| | leeandco | varnick |
|---|---|---|
| Creation | in `cloudflare-zone`, behind `createIfAbsent` (default `true`), one zone per instance | a separate module over every zone in the account, writing no records ([single-consumer-modules](./single-consumer-modules.md)) |
| The account, before any create | an unfiltered lookup refuses a zone in another account | a lookup filtered to it, and an account-name check that catches a real id for the wrong account |
| A zone the token cannot see | named in the failed create's error | caught by a second lookup after creating, naming Zone Read |
| Nameservers | printed with the status on every apply | output only |

## What it takes upstream

### 1. Closed: create the zone when the lookup finds none

Closed in 0.24.0 (2026-11-01). A fifth consumer forced it: radiolo, whose
client's domain is registered at Spaceship, had its zone made by a one-off API
call that morning, the third client domain onboarded a third way.
`createIfAbsent` on `cloudflare-zone` creates an absent zone with
`{ name, account: { id: accountId }, type: 'full' }`; `zoneStatus` and
`zoneCreated` join `nameServers`, and every apply prints the pair and the
status. The open questions, settled:

- **The default is `false`.** An empty lookup is also a mistyped name or a
  token that lost Zone Read, so creation is one declared line per domain, and
  existing instances (qom's; zbc's `zabaca-zone`, `agentgit-zone`) behave
  exactly as before. That is also why 0.24.0 has no CHANGELOG entry.
- **Creation lives in `cloudflare-zone`** (leeandco's shape), one zone per
  instance, because the instance already names the account and the zone.
- **The guard order is leeandco's:** a zone found in another account is refused
  before anything decides to create, and a failed create is wrapped with the
  permission gap it most likely is.
- **`registry.json`** names Zone Read, Zone Write (account-wide, for creation)
  and Zone Settings Read beside its write half.

Still unverified live: whether `POST /zones` refuses an existing name in the
same account. Radiolo's was a fresh create, the tests stub the refusal, and no
repo records a real one.

Main's other zone lookups (`cloudflare-tunnel/index.ts:335-346`,
`cloudflare-token/index.ts:277-283`) still check no account, though neither is
reported misfiring.

### 2. Delete first at a blocked name

Main pairs records by type and name and creates before it deletes (`:374,
753-778`), so replacing a CNAME with an AAAA at one name fails at the create,
`allowDelete: true` or not; leeandco deletes the CNAME by hand first
(`leeandcoconstruction-zone.ts:187-196`). Deleting without a standing
`allowDelete` is [engine-undeclared-state](./engine-undeclared-state.md)'s.

### 3. Closed: zone settings and SRV records

Zone settings closed in `ed8ce39` (#128, 2026-09-08), answering ceo; ADR-0016
(zone and Access) keeps them off the deploying module. Both are forward-only;
main's takes four ids (`:176-190`) and plans before writing
(`:56-73, 727-751`), ceo's takes any and PATCHes without reading the zone.
Nobody declares anything but `always_use_https`, which main's runs on qom's
zone and zbc's (`agentgit-zone.ts:36`). SRV records closed in `eb1770c`
(2026-09-30), which qom's Outlook autodiscovery record needed. Loose ends:

- Closed in 0.24.0: `registry.json:10` asked for Zone Settings Edit alone, but
  the module first reads `/zones/:id/settings` (`:728`), which Cloudflare
  refuses with 9109 on the write group alone (zbc's `zabaca-dns-token.ts:12-16`);
  it now names Zone Settings Read too.
- ceo has not moved over: its fork still PATCHes `always_use_https` on
  roamside.com from the deploying instance, with no account check, on the
  standing `CLOUDFLARE_API_TOKEN`. Moving takes an imported token (`apiToken`
  is reference-only, `:200-212`; tokens at rest are
  [cloudflare-token](./cloudflare-token.md)'s) and an instance authoritative
  over roamside.com's records, which reports each as drift until transcribed
  and deletes none without `allowDelete`. A copy-mode `zbc update` would
  overwrite the fork ([distribution-drift](./distribution-drift.md)).

## Evidence

- **leeandco** (`cloudflare-zone`, production; `divergent` from `aefae28`, but
  a sibling of main's rather than a fork, since the survey dates only
  upstream's copy; it lacks main's `settings` and SRV records):
  `packages/infra/modules/cloudflare-zone/index.ts:63-71, 251-259, 581-685, 738-757`,
  `index.test.ts:387-403`;
  `packages/infra/environments/production/leeandcoconstruction-zone.ts:7-9, 172-218`,
  `leeandcoconstruction-dns-token.ts:18-20, 32-46`;
  `packages/infra/tests/production-instances.test.ts:251-256`. Ported from
  foundry in `9dc32d4` and given creation three minutes later in `46fe38a`;
  `28343bb` records the creating apply (nothing imported) and a second with no
  changes, all on 2026-08-14.
- **varnick** (`client-account`, never run; the module is
  [single-consumer-modules](./single-consumer-modules.md)'s):
  `packages/infra/modules/client-account/index.ts:40-64, 222-224, 252-259, 343-345, 365-390, 443-473`,
  `index.test.ts:161-168`; `client-domain/README.md:192-194` (registering
  varnick.com created its zone). Written in foundry (`7d55a3bc`, 2026-08-05,
  eighteen minutes after foundry's `cloudflare-zone`, `ccf1e566`), moved to
  varnick in `8e220fd` (2026-08-08).
- **qom** (main's module verbatim, `current`; production):
  `docs/adr/0007-one-root-token-mints-every-credential-in-the-client-account.md:43-45`;
  `packages/infra/environments/production/qualityom-dns-token.ts:26-32`,
  `qualityom-zone.ts:5-10, 36-43, 126`.
- **ceo** (`cloudflare`, production, applied by hand, copy mode; `divergent`
  from `e83bf83`; at `1de32a3`):
  `packages/infra/modules/cloudflare/index.ts:166-185, 304-305, 564-580`;
  `packages/infra/environments/production/tour-guide.ts:29-37`. Zone settings
  added in `f64883c` (2026-07-27).
- **Redirect modules' lookups:** railmid
  `vendor/zbc/modules/cloudflare-redirect/index.ts:121-136`, qom
  `packages/infra/modules/cloudflare-redirect-rules/index.ts:308-326`.
- **main** (`0ef349d`), under `packages/cli/templates/infra/modules/`:
  `cloudflare-zone/index.ts:56-73, 82-84, 176-190, 200-212, 225, 374, 661-698, 727-778`,
  `cloudflare-zone/registry.json:10`, `cloudflare-zone/index.test.ts:700`,
  `cloudflare-tunnel/index.ts:335-346`, `cloudflare-token/index.ts:277-283`,
  `vm/index.ts:329-356, 572-586`. Also `packages/cli/src/engine/apply.ts:212`,
  `packages/cli/src/utils/copy-refresh.ts:158-175` and, under
  `packages/infra/environments/production/`, `zabaca-dns-token.ts:12-16`, `zabaca-zone.ts:6-8`, `agentgit-zone.ts:6-9, 36`.
  Nothing under `packages/cli/templates` or `packages/cli/src` matches
  `'POST', '/zones'`, `createIfAbsent` or `type: 'full'`.
