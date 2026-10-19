# engine-undeclared-state — engine

**Consumers:** foundry, railmid, cedarpad, leeandco, qom, foothill-metabolic (6)  ·  **Deployed in production by:** foundry, railmid, and leeandco by hand. cedarpad's hand steps have no recorded run, and qom's leftover is untouched.

zbc keeps no state (`CONTEXT.md:12-13`), and `zbc list` reads only the
declaration (`packages/cli/src/commands/list.ts:21-28`). ADR-0017 deferred
pruning until the engine knows "which provider objects an instance *owns*"
(`docs/adr/0017-a-third-verb-and-a-value-typed-imports-edge.md:134-145`), and
main has not added it.

## What they needed

Each of the six holds live resources no instance names, and needed to compare
what the provider holds with what this repo and others own, then remove the
difference once, on a person's decision, with a failed removal reported.

- **foundry** (production) runs three censuses of one design in its test
  suite, covering incus guests and projects, Access applications and tailscale
  serve routes, each failing on anything live that nothing declares or exempts,
  since a repo-only test was green for days with :8802 live. Its ADR-0029
  decommission removed agent-host's Access application and tunnel and Forge's
  two serve routes from the repo, leaving them live for the lead; only the routes
  have come down (2026-09-14). Cutting the destroy-less `github-runner`'s
  `count` from four to two left two registrations, removed by hand
  ([host-modules](./host-modules.md)).
- **foothill-metabolic** (preview) runs by hand a sweep, written in ceo,
  flagging each `-pr-<N>` Worker or Turso database whose PR is no longer open:
  the close-time `zbc destroy preview` cleans up "most of the time, not always".
- **railmid** (production) deletes, after each deploy, its Worker's custom
  domains that `wrangler.jsonc` no longer names (its vendored `cloudflare`'s
  `pruneCustomDomains`, 2026-09-05).
- **cedarpad**, on our unedited `cloudflare`, prescribes that deletion by hand
  through the same API, found independently, and `wrangler containers delete`
  for three deleted Durable Object classes' container applications.
- **leeandco** deleted undeclared production DNS records outside any apply
  three times, declining `allowDelete` because it is "a standing permission".
  Its move into the client's account (2026-08-14) left the old Worker and
  database in Zabaca's account as the rollback, the Worker still taking quote
  requests the new admin never shows. Deleting the old sending subdomain's
  instance file put it beyond zbc, and the runbook's hand DELETE has not run.
- **qom** left its old Worker live at qom.zabaca.com on moving into its
  client's account (2026-09-30), and nothing in the repo can destroy it. Its
  layout follows leeandco's: a second instance, not a second design.

## The interface, from three implementations

Where they agree:

- **An empty read is no answer.** Cloudflare answers a token without the scope
  with `success: true, result: []`: foundry treats an empty list as
  unanswered, and varnick's `client-account` fails unless every declared zone
  is visible. foothill's `curl -s … or []`, the counterexample, reads a refused
  token as zero Workers, as main's list-then-delete destroys read an empty list
  as absence (`d1/index.ts:246-249`).
- **The declared side is rebuilt by hand.** foundry reads `config.port`,
  `config.name` or `config.domain` from each instance file; foothill hard-codes
  its `PR_NUMBER` name templates.
- **A record of what other repos own expires with it.** foundry's leases name
  each owner and fail once they match nothing live, so a stale one cannot bless
  whatever takes the name next. leeandco's runbook, independently, is the only
  record of its kept resources' ids, and nothing checks it.
- **Report first; delete on a decision, inside a set the deleter alone
  writes.** railmid's flag deletes at once, though its own comment asks for a
  report first.

Where they disagree, the config surface:

| | Ownership is known by | Deletion |
|---|---|---|
| foundry | a marker on the resource, never inherited (incus `user.owner`), else a leased list (serve routes, Access) | a person's act |
| foothill | the `-pr-<N>` suffix and the PR's state | a person's act |
| railmid | a parent: the deployed Worker's domains | a standing flag in `apply` |

Main has two of the forms, each inside one module. By parent, `cloudflare-zone`
and `cloudflare-access` report each undeclared record in the zone or policy on
the application and delete it only with `allowDelete: true`
(`cloudflare-zone/index.ts:221-225, 765-778`;
`cloudflare-access/index.ts:46-52, 227-232, 1164-1182`), and
`gcp-service-account` prunes its keys to `maxKeys` (`index.ts:79-85, 240-243`).
By prefix, `cloudflare-email` marks its rules `zbc:` (`index.ts:109-110`) but
never reports one it stopped declaring (`:384-413`), and its destroy deletes
every `zbc:` rule on the zone, whichever instance wrote it (`:458-472`).
varnick's unapplied `client-account` fails the apply on an undeclared zone by
default, deleting nothing (`failOnDrift`; [single-consumer-modules](./single-consumer-modules.md)).

**Where the bar is in question.** foundry's Access census audits an account
where seven other Zabaca repos own applications, which only its root token
allows; its other two cover one machine; leeandco's and qom's leftovers are
one operator's account moves. foothill's need is zbc's own: the scaffolded
preview names instances from `PR_NUMBER`, and its cleanup runs
`zbc destroy preview` once and checks nothing
(`packages/cli/templates/workflows/preview.yml:11-12, 69-86`).

## What it takes upstream

Independent, smallest first:

1. **A destroy that reports what it left.** Six of main's eleven built-in
   destroys log a failed delete and return (`cloudflare/index.ts:824-832`,
   `turso/index.ts:206-211`, `d1/index.ts:251-262`, `r2/index.ts:91-104`,
   `cloudflare-email/index.ts:473-528`, `fly/index.ts:426-429`), and
   `incus-storage-pool/index.ts:150-152` returns silently on a failed listing;
   the engine then prints `✓ … destroyed` (`engine/destroy.ts:92`). They
   swallow because the engine stops at the first failure (`:88-90`;
   `r2/index.ts:85-87`), which can also strand what it applied on demand
   (`packages/cli/CHANGELOG.md:99-101`). The change attempts every instance and
   exits non-zero naming each still standing (`engine/destroy.ts:53-93`);
   the seven then throw, `turso` and `fly` taking `d1`'s absent-versus-failed
   split (`d1/index.ts:242-250`), and the scaffolded cleanup job turns red on a
   miss.
2. **`zbc list --json` carries identity.** It has no config
   (`list.ts:10-19, 62-69`), though `list.test.ts:10-12` says foothill's
   reconciler "needs exactly this set". `ListedInstance` gains the parsed
   config or a per-module identity (`workerName`, `dbName`, `domain`, `port`).
   foothill would still need one per open PR, which the listing cannot name.
3. **A census hook.** An optional module function lists what the provider holds
   in the instance's ownership scope; the engine reports what no instance of
   the module declares, outside `apply`, converging nothing, as foundry's
   ADR-0016 keeps its census out of `tailscale-serve`. It follows the first and
   third rules above, with an ownership form declared per module, ADR-0017's
   missing half. Its credential comes through `imports`, not foundry's
   fabricated context, which rolls a token every suite run
   ([cloudflare-token](./cloudflare-token.md)). An ADR-0017 action has that edge but
   sees only its own instance and returns nothing (`engine/actions.ts:116-138`;
   `templates/infra/src/types.ts:8`).
4. **Deletion as one act**: an `irreversible: true` action on
   `cloudflare-zone` and `cloudflare-access` deleting the undeclared members it
   finds, beside or instead of `allowDelete`. No built-in declares an
   action, and an action takes no input (`types.ts:8`; `commands/run.ts:20-37`;
   [engine-verbs](./engine-verbs.md)), so it deletes what it finds, not the lines the operator
   read. Even `allowDelete: true` cannot swap leeandco's `www` CNAME for an
   AAAA, because `cloudflare-zone` creates first (`index.ts:374, 753-778`); the
   reorder is [cloudflare-zone](./cloudflare-zone.md)'s.
5. **The deploy module's own leftovers.** Main's `cloudflare` leaves removal to
   wrangler, which sends no route PUT for an empty list
   (`cloudflare/index.ts:607-626, 724`), so the last route stays, and turns a
   refused PUT into per-zone POSTs that delete nothing, blaming a token without
   all-zones permission, which `cloudflare-token` mints when `zones` is set
   (`cloudflare-token/index.ts:202-207`). The change reports the deployed
   Worker's undeclared custom domains and last route, deletes them on opt-in
   (railmid's patch plus a report-only mode), and fixes the destroy or its
   comment (`index.ts:817`) once the container question is settled.
6. **A retired instance.** `zbc destroy` resolves only declared instances
   (`engine/destroy.ts:30-38`), so reaching leeandco's sending subdomain means
   restoring its file, a second sending identity. A destroy-only
   state, skipped by `apply`, refused as an import and reached by
   `zbc destroy`, avoids that. No consumer asks for a state file.
7. **Adoption**, open since 2026-09-02: the census in reverse, turning a live
   resource into an instance file, implemented only in ceo's `obs` `capture.ts`
   ([single-consumer-modules](./single-consumer-modules.md)).

Set pruning, which varnick's `client-preview` does inside a name prefix its
branded types enforce ([single-consumer-modules](./single-consumer-modules.md)), stays open as ADR-0017
left it.

Open:

- Does wrangler detach a dropped custom domain? railmid and cedarpad say not,
  unobserved; its whole-list `override_scope: true` PUT does not obviously
  agree, and with none declared it sends nothing.
- Does `wrangler delete` remove container applications? `cloudflare/index.ts:817`
  (2026-06-23) says yes, `templates/apps/walgit/README.md:911-913` (2026-08-28)
  no.
- Does D1's list answer a scope-less token with an empty success, which `d1`'s
  destroy reads as gone?
- Why did foothill's destroys miss (the swallowing, the first-failure abort, or
  a job that never ran), and do they still? Every recorded miss is ceo-era.
- Do other companies have several writers and one auditor?

## Evidence

- **foundry** (production, in `bun run test` on ryzen-9), under `packages/infra/environments/`:
  - censuses: `ryzen-9-live-tailnet-routes.test.ts:13-35,37-67,290-303,376-456,458-517`; `ryzen-9-live-guest-owners.test.ts:26-38,105-112,346-361,459-535`, the marker read from `config`, not `expanded_config`, at `:105-112`; `ryzen-9-live-access-applications.test.ts:34-55,74-84,91-180,229-243,264-282`; registered at `machine-asserted.test.ts:73-74,83-85`; foundry `docs/adr/0026-a-guest-is-converged-by-the-repo-that-owns-it.md:62-65`. One design: 9c80b38c (serve routes, 2026-08-07), 1277a5f1 (incus, "the same structure", 2026-08-18), eca8e469 (Access, 2026-08-23).
  - the account: the leases at `ryzen-9-live-access-applications.test.ts:91-150` name cedarpad, agent-lab, ceo, web, games, tax and claude-mitm-proxy, and the one at `:140-149` records a `cloudflare-access` limit ([cloudflare-access](./cloudflare-access.md)); the root token and the token minted per run: `ryzen-9/access-token.ts:5-9`, `ryzen-9-live-access-applications.test.ts:184-198`.
  - left live: `docs/adr/0029-the-unattended-inference-consumers-are-decommissioned.md:172-173`; `ryzen-9-live-tailnet-routes.test.ts:379-386`, the routes down at `:393-400`; the application and its tunnel still pending at `ryzen-9-live-access-applications.test.ts:169-180`. Runners: the message of ff1583a7 (2026-08-20), read on ryzen-9; `packages/infra/modules/github-runner/index.ts` defines no `destroy`.
- **foothill-metabolic** (preview, by hand): `scripts/check-orphan-previews.sh:2-9,17-18,32-38,50-61`; cleanup `.github/workflows/preview.yml:80-97`; names `packages/infra/environments/preview/turso.ts:7`, `foothill-metabolic-cf.ts:49`; its destroys log and return at `packages/infra/modules/cloudflare/index.ts:239-247`, `turso/index.ts:111-116`. Written in Zabaca/ceo 2a271a4 (2026-06-02) and moved on 2026-07-27 (ceo 3f5ef1d, foothill e97dc04); 6723aa2 swept seven ceo-era Turso orphans.
- **railmid** (production; `cloudflare` divergent from f064805, the prune a vendor-only commit, 9410da7, [distribution-drift](./distribution-drift.md)): `vendor/zbc/modules/cloudflare/index.ts:475-493,548-555,726-745`; `packages/infra/environments/production/railmid.ts:150`; `apps/server/wrangler.jsonc:50-51`.
- **cedarpad** (prescribed for production, no recorded run; `cloudflare` a stale, unedited copy): `packages/canvas/wrangler.jsonc:10-12,138-142`; `packages/canvas/scripts/deploy.sh:32-34`; `docs/adr/0027-workspace-containers-run-on-the-durable-object-policy.md:48-51`, all from 6346b8b. Same endpoint as railmid; neither cites the other.
- **leeandco** (production, by hand; environment files under `packages/infra/environments/production/`): DNS deletions `leeandcoconstruction-zone.ts:133-157` (2026-08-14), `docs/runbooks/apply-order.md:37-43` (2026-09-09), `docs/runbooks/cutover.md:6-14` (2026-10-05); `allowDelete` declined at `leeandcoconstruction-zone.ts:153-157`; the swap `:187-196`, its `cloudflare-zone` copy (divergent from aefae28) keeping main's ordering at `packages/infra/modules/cloudflare-zone/index.ts:706-731`; the move `leeandco.ts:20-26`, `leeandco-auth-db.ts:17-23`, the old Worker's quote requests `leeandco.ts:64-72`; the subdomain and the record `docs/runbooks/remove-zabaca-sending-subdomain.md:9-19,33-61`, `CLAUDE.md:54-59`. The record is independent of foundry's leases: bc32a11 (2026-08-15) and 390b6f9 (2026-09-10), against eca8e469.
- **qom** (no survey finding; read directly for this case): `packages/infra/environments/production/qom.ts:44-54`; `docs/adr/0006-the-site-moves-to-the-clients-domain-and-account.md:38-41`; layout from leeandco at `docs/adr/0005-the-site-is-its-own-repo-and-business-state-stays-in-ceo.md:8`.
- **varnick** (unapplied; written in foundry, 7d55a3bc, 2026-08-05): `packages/infra/modules/client-account/index.ts:54-64,189-196,459-473,475-492`; `client-preview/index.ts:290-314`.
- **main** (0ef349d): short paths resolve under `packages/cli/src/` (`engine/`, `commands/`), `packages/cli/` (`templates/`) and `packages/cli/templates/infra/modules/` (`<module>/index.ts`). Eleven modules define `destroy`; the four not named above throw (`cloudflare-token/index.ts:352-361`, `cloudflare-tunnel/index.ts:420-440`, `gcp-service-account/index.ts:297-314`, `vm/index.ts:685-707`). The engine's gap in its own words: `README.md:89-93`, `host-symlink/index.ts:91-94` ("the engine prunes nothing"). `cloudflare-access` reads policies on its application (`index.ts:444-467,1164-1182`). `git grep` finds no built-in declaring `actions`. wrangler 4.147.0 `wrangler-dist/cli.js`: route PUT `:159417-159419`, none for an empty list `:160286`, the fallback `:159440-159443,159522-159526`, custom domains `:159530-159533,159549,159562,159630-159632`, none when none is declared `:160305`; 4.110.0 has the same paths.
