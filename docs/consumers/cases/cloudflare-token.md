# cloudflare-token — upgrade

**Consumers:** leeandco, agent-lab, cedarpad, lov  ·  **Deployed in production by:** leeandco, agent-lab, cedarpad, lov

All four repos are Zabaca's; leeandco is a client's site. Eleven repos, zbc
included, mint with cloudflare-token: nine into Zabaca's account `99a19e58…`,
qom and leeandco into client accounts.

## What they needed

A scoped Cloudflare token that works when its reader first uses it, holds
exactly the grant it names, and lasts as long as its reader holds it. Since the
2026-09-02 run main has a per-instance root (index.ts:215), readiness at the
imports edge (index.ts:332-351) and secret outputs (index.ts:237-240). Still
open: Access-only tokens, which eight of the eleven repos mint, are proven by
`/tokens/verify` alone; a duplicated permission name grants both twins; nothing
keeps a token for a reader outside the apply; no R2 grant narrows to a bucket.

## The interface, from four implementations

leeandco's fork, agent-lab's `stored-token`, lov's `secret-token` and cedarpad's
hand procedure.

### Readiness

leeandco, main and agent-lab are one lineage here, not three votes: main's
readiness quotes leeandco's measurements (index.ts:117-125), and agent-lab built
on main's. All three probe as the new credential, for 30 to 60 s, against the
reader's call. They differ:

| | Probe named by | Retried on | Wait runs |
|---|---|---|---|
| main | the module, per granted read group (index.ts:142-172); else verify | any throw (readiness.ts:152-193) | imports edge only |
| leeandco | the instance's `readinessProbe`, set on six of seven; else a derived read group; else verify, with a warning | 10000, 401, 403 | inside apply; `waitUntilUsable` exported |
| agent-lab | the reader's call: S3 list per bucket, or verify for a token value | any throw | `mint` and `rotate` actions |

**Access tokens get the weak proof, silently.** Main has no Access row, so
Access-only ones fall back to verify (index.ts:169-171), which leeandco measured
going green 0.5 to 1.5 s before a scope-gated call. A first-attempt pass prints
nothing (readiness.ts:168-175), and `proves` still claims read permissions
(index.ts:333). That is qom's and games' tokens today, and the other six repos'
once they take main's module ([distribution-drift](./distribution-drift.md)).
cloudflare-access's first call with such a token reads the organisation
(cloudflare-access/index.ts:845); refused, with no `orgName`, it warns and skips
the `teamDomain` check (:918-931).

### Duplicate permission-group names

"Access: Apps and Policies Read/Write" each exist twice, account- and
zone-scoped; both modules refuse unknown names and pick no twin silently.
Main (2026-08-19) grants every twin (index.ts:264-272), `zones` narrowing only
the zone twins (:81-89), and cannot be asked for one (:261-263). leeandco
(2026-08-14) lets `zones` choose, none for the account twin and any for the
zone twin, and throws where that settles nothing.

Neither fits every instance. qom-access-token sets `zones` and needs the account
twin, which leeandco's rule would withhold. Most instances cannot set `zones`:
zone names resolve with the root (index.ts:283), and neither Zabaca's root
(zabaca-dns-token.ts:18-23) nor leeandco's holds Zone Read. railmid's redirect
token leaves `zones` unset for that reason, so its grants, like such instances'
Access zone twins, cover every zone of the account (index.ts:81-89). railmid
calls granting both "not a problem" (railmid-access-token.ts:27-31).

### A reader outside the apply

cloudflare-token rolls its in-memory value every apply (index.ts:22-27), so its
advice to "mint a separate named token" for a human (registry.json:12) cannot
be written in zbc.

| | Reader | Credential | Minted by |
|---|---|---|---|
| agent-lab `stored-token` | tools/data via `zbc secret get`; r2, inside the apply, via its fixed `CLOUDFLARE_API_TOKEN` | token value or derived S3 keys, in secrets.yaml | `mint` and `rotate` actions; apply only proves |
| cedarpad, by hand | container env; operator script via `sops exec-env` | S3 keys derived from the deploy token, re-`sops set` each rotation | the dashboard |
| leeandco, qom's copy | `wrangler d1 migrations apply` | none at rest: a D1 token per command, waited on, deleted in `finally` | the script, every run |

All three agree that a value must not roll while something outside the apply
holds it; cedarpad's container fingerprints its env, so a rolled pair, which its
vendored engine could already wire, would replace every running container after
each apply. They split on keeping it at rest (agent-lab, cedarpad) or minting
per use (leeandco, qom; the migrations themselves are [d1](./d1.md)'s).
agent-lab's and cedarpad's S3 derivations match main's (index.ts:103-111), yet
nothing surveyed or on main imports main's in-memory S3 keys.

lov's `secret-token`, read inside the apply, never rolls either. Believing no
root existed for an account main's own production mints on, lov passes its
standing deploy token through as an output with `rotates: 'never'`, meeting
cloudflare-access's reference-only rule (cloudflare-access/index.ts:80-81) in
form only. It gives up the minted token's narrow scope and per-apply roll, not
a credential at rest: the built-in path reads a root at rest on every apply
(index.ts:242), which agent-lab avoids by borrowing zbc's for one command
([engine-credential-lifecycle](./engine-credential-lifecycle.md)).

Fixed secret names widen tokens at rest. agent-lab stores
`agent-lab-r2-admin` under the one name r2 reads (r2/index.ts:48) and narrows it
by hand; an `apiToken` reference on [r2](./r2.md) frees it only if r2 can import
item 3's stored credential. cedarpad's deploy token carries cloudflare-email's
scopes for the same reason (cloudflare-email/index.ts:243; inferred: nothing
records the edit). An `apiToken` on that module, and cedarpad's apex SPF check,
belong to [cloudflare-email](./cloudflare-email.md).

### Bucket-scoped R2 grants

Only agent-lab asks for this, in production. A `buckets: { names, permissions }`
key beside `permissions` builds a policy on
`com.cloudflare.edge.r2.bucket.<account>_default_<bucket>` for the "Workers R2
Storage Bucket Item" groups. Main builds only account and zone policies
(index.ts:66-97) and has no bucket key (:191-216). agent-lab proved the shape
against the real bucket.

## What it takes upstream

In `packages/cli/templates/infra/modules/cloudflare-token/` unless named.

1. **Readiness.**
   - Add READ_PROBES rows for the Access read groups at the GETs
     cloudflare-access makes (cloudflare-access/index.ts:845, :948, :1001,
     :1050), foundry's combined `Organizations, Identity Providers, and Groups
     Read` included. claude-mitm-proxy's write-only token stays on verify.
   - When only verify ran, say so, and stop `proves` claiming read
     permissions: it is one string per module (types.ts:84), so it must cover
     both cases or come to depend on config.
   - Correct the docs' count of four loops that could not tell transient from
     permanent (ADR-0013:9-13, :35; types.ts:47-50, :61-66;
     readiness.ts:17-20): there were three, leeandco's and ceo's retried only
     named codes, and foundry's misread a field ([tailscale](./tailscale.md)).
   - Open:
     - An instance-level probe path like `readinessProbe`, on which
       ADR-0013:39 is silent. One path cannot serve importers that start
       differently, as leeandco's two Access importers do; with the rows
       above, main's probe of every granted row can.
     - An S3 probe, since main never proves the S3 keys it emits
       (index.ts:320).
     - A wait helper for readers off the edge, in `templates/infra/src` or
       exported as in leeandco's fork: leeandco's D1 script imports
       `waitUntilUsable`, qom's copy rewrote it because its module's wait is
       inside `ready`, and agent-lab's actions return nothing (types.ts:7-8).
       Main already leaves an in-body retry to the module
       (gcp-service-account/index.ts:96-104).
     - Failing fast on codes no wait fixes (`CfError.has(10042)`), an engine
       change since a probe cannot answer "permanent" (ADR-0013:35): on
       2026-09-09 leeandco's probe spent 16 attempts on R2's `403 10042 Please
       enable R2`, which main would log at once (readiness.ts:185-190) but
       still retry for 30 s (:176-181).
2. **Twins.** Let a permission entry name its scope (say,
   `{ name, scope: 'account' | 'zone' }`), keeping both as the default, which
   qom-access-token needs.
3. **A credential that outlives the apply**, as a mode on cloudflare-token or
   agent-lab's module built in. It reverses main's "never store it"
   (registry.json:12), and main's two credentials held past the apply are not
   API tokens (cloudflare-access/index.ts:54-63;
   cloudflare-tunnel/index.ts:253-254). A root at rest in every minting repo
   matters because Zabaca's repos share one account; whether other companies
   keep tokens at rest, or share accounts that way, is the bar question. Either
   way, apply proves and never rolls; `mint` and `rotate` are actions; an
   output copy for r2 or cloudflare-access declares `rotates: 'never'`, which
   no built-in does yet
   ([ADR-0016](../../adr/0016-a-credential-is-an-output-the-engine-refuses-to-write-down.md));
   S3 keys and bucket grants work as in item 4. The engine owes the action
   what agent-lab rebuilt: a secrets.yaml writer taking the value on stdin, as
   its `sops set --value-stdin` does and main's CLI-private one does not
   (commands/secret.ts:51-105, :70-73), and the environment's name, absent
   from `ApplyContext` (types.ts:98-102), which agent-lab carries as an
   unchecked `env` config key ([engine-verbs](./engine-verbs.md) item 3).
4. **Bucket grants.** Add a `buckets` key that builds the bucket resource, and
   relax `permissions`' `nonempty()` (index.ts:201) when it is set, for a
   bucket-only token like agent-lab-data-key.

## Evidence

- **leeandco**: a fork of 3a5bf85 through foundry's vendored copy (9dc32d4,
  2026-08-14), unchanged since f051a9c. Its readiness (9b4d362, 8636e81,
  2026-08-14) predates main's ae34961 (2026-09-07); its twin rule (f051a9c,
  2026-08-14) converges with main's ec24ecb (2026-08-19), not a fork.
  - `packages/infra/modules/cloudflare-token/index.ts`: twin rule :215-314;
    verify at 112/111/202 ms against the D1 list at 1621/610/808 ms :358-413;
    retry codes :415-437; `waitUntilUsable` :439-478; `readinessProbe`
    :538-552; the wait and warning in apply :638-667.
  - `packages/infra/environments/production/`: `leeandco-access-token.ts`:114
    (organisation probe); five more `readinessProbe`s at
    `leeandco-deploy-token.ts`:98, `leeandco-mail-token.ts`:77,
    `leeandco-members-token.ts`:58, `leeandcoconstruction-email-token.ts`:93,
    `leeandcoconstruction-inbound-token.ts`:83;
    `leeandco-cli-service-token.ts`:96-98 and `leeandco-access.ts`:201 (import
    order), with
    `modules/cloudflare-access-service-token/index.ts`:238 (service tokens
    first); `leeandcoconstruction-dns-token.ts`:24-26 (no Zone Read).
  - `docs/research/cloudflare-credential-forensics.md`:89-115;
    `packages/infra/scripts/with-client-d1-token.ts`:8-41.
- **agent-lab**: novel; 9e81f26 (2026-10-08), on zbc-core-v0.23.0.
  `packages/infra/modules/stored-token/index.ts`:8-33, :35-36, :38-59, :69-85,
  :97-132, :138-167, :191-247;
  `packages/infra/environments/production/agent-lab-r2-admin.ts`:3-16,
  `agent-lab-data-key.ts`:4-20; `docs/hosting.md`:89-102;
  `tools/data/cli.ts`:25-44; b4eff17 (push, pull and deep verify against the
  real bucket).
- **cedarpad**: an escape hatch from 3fd476a (2026-06-29), older than
  cloudflare-token. `packages/infra/environments/production/canvas.ts`:17-24,
  :78-81, `canvas-email.ts`:41-52, `admin-access-token.ts`:26-31;
  `packages/canvas/scripts/census-unmigratable.sh`:29, :57;
  `packages/canvas/worker/container-env.ts`:24-28,
  `canvas-container-lifecycle.ts`:82-89;
  `vendor/zbc/modules/cloudflare/index.ts`:104-111.
- **lov**: novel; 8ea6761 (2026-10-14).
  `packages/infra/modules/secret-token/index.ts`:4-19;
  `packages/infra/environments/production/lov-access-token.ts`:3-11, read by
  `lov-access.ts`:26, :37 and `lov-access-oauth.ts`:24, :33.
- **qom**: `packages/infra/environments/production/qom-access-token.ts`:30-48,
  :57-64; `packages/infra/scripts/with-client-d1-token.ts`:27-31, :113-130.
- **Other Access-only tokens**, under `packages/infra/environments/`: games
  `production/games-access-token.ts`:11-16, whose engine has `ready`;
  claude-mitm-proxy `production/fleet-access-token.ts`:21, foundry
  `ryzen-9/access-token.ts`:34-45, railmid
  `production/railmid-access-token.ts`:27-31, :37-42 and web
  `production/web-access-token.ts`:42-51, whose vendored modules, like
  cedarpad's, have none. railmid's `zones`:
  `production/railmid-redirect-token.ts`:21-30.
- **ceo**: `packages/infra/modules/gcp/index.ts`:120-126 retries only a 404.
- **The eleven minting repos**, by `accountId`: zbc, cedarpad,
  claude-mitm-proxy, croft, foundry, games, lofi, railmid and web on
  `99a19e58…`; leeandco on `aca38b5d…`; qom on `e806306d…`.
- **main** at 0ef349d; cloudflare-token unchanged since 40ef706. Since the last
  run: 6d23700 (#121), ae34961 (#124), 40ef706 (#129); the twin grant is
  ec24ecb. Body paths: modules under `packages/cli/templates/infra/modules/`
  (bare `index.ts` and `registry.json` are cloudflare-token's), `types.ts`
  under `packages/cli/templates/infra/src/`, `engine/readiness.ts` and
  `commands/secret.ts` under `packages/cli/src/`, ADR-0013 at
  `docs/adr/0013-readiness-is-a-precondition-of-the-imports-edge.md`,
  `zabaca-dns-token.ts` in `packages/infra/environments/production/`. No
  module under `templates/` declares `rotates: 'never'`, nothing on main
  contains `edge.r2.bucket`, and nothing outside cloudflare-token reads its
  `s3AccessKeyId` or `s3SecretAccessKey`.
