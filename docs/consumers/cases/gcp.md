# gcp — new

**Consumers:** ceo, foothill-metabolic (2, **one lineage**)
**Deployed in production by:** foothill-metabolic (production + preview);
ceo's copy is unapplied
**Independence:** low — foothill inherited its whole `packages/infra/` tree from
`Zabaca/ceo`, so this is two data points about the *need* and one about the
interface.

## What they needed

A Google Cloud service account, a key for it, and a Calendar it owns. zbc has
no Google module of any kind.

The module speaks raw Google REST with a hand-rolled ~20-line RS256 JWT bearer
grant (`index.ts:39-59`) rather than pulling in an SDK or shelling out to
`gcloud` — a deliberate choice, recorded in ceo's
`docs/decisions/0017-own-scheduling-replace-reclaim.md:41`.

## The interface, from 2 implementations

Identical, 182 lines each: config
`{projectId, serviceAccountId, displayName, calendarSummary, calendarTimeZone, maxKeys}`
→ outputs `{saKey, saEmail, calendarId}`. No `destroy`, deliberately (`:180`).

**That interface is two modules welded together.** `projectId`,
`serviceAccountId`, `displayName`, `maxKeys` → `saKey`, `saEmail` is a service
account. `calendarSummary`, `calendarTimeZone` → `calendarId` is Google
Calendar, provisioned by acting *as* the service account just minted. They are
in one module because the second needs the first's credential in the same run,
which is the ordering constraint from
[engine-output-wiring](./engine-output-wiring.md) showing up again on a
different provider.

Do not ship this shape upstream. The service-account half generalises to any
Google consumer; the Calendar half is one application's need.

## What it teaches beyond the provider

Both halves of the module exist to work around engine gaps, and both are
covered by their own cases:

- it mints a fresh key **on every apply** and prunes to `maxKeys` so in-flight
  preview Workers keep working — [engine-credential-lifecycle](./engine-credential-lifecycle.md)
- it retries around a just-created SA that 404s its own keys endpoint, and a
  just-minted key the token grant briefly rejects —
  [engine-api-consistency](./engine-api-consistency.md)

foothill's deployment is the sharper evidence: **separate service accounts per
environment**, so a preview apply's key rotation cannot invalidate the
production credential (`preview/gcal.ts:5-9`). That constraint should be a
property of the engine's rotation story, not something each consumer rediscovers.

## Evidence

- ceo: `packages/infra/modules/gcp/index.ts:39-59,81-98,109-115,117-126,131-143,145-176,180`
- foothill: `packages/infra/modules/gcp/index.ts:79-181`; instances `production/gcal.ts:14-22`, `preview/gcal.ts:5-9,14-22`; consumed at `production/foothill-metabolic-cf.ts:47` (`GCAL_SAKEY`/`GCAL_SAEMAIL`/`GCAL_CALENDARID`)
- ceo decision record: `docs/decisions/0017-own-scheduling-replace-reclaim.md:41`
