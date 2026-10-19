# engine-credential-lifecycle — engine

**Consumers:** cedarpad, agent-lab  ·  **Deployed in production by:** cedarpad, agent-lab

## What they needed

[ADR-0016](../../adr/0016-a-credential-is-an-output-the-engine-refuses-to-write-down.md)
(40ef706, #129) shipped the 2026-09-02 ask: declared credential outputs,
scrubbed from engine messages and `zbc apply --json`, and `rotates: 'never'`,
refusing an `ephemeral` instance whose credential is held outside the apply.
Two needs remain, both in production.

### 1. One credential, two environments or two projects

An apply sees one environment of one project; a credential needed elsewhere
moves by hand.

**cedarpad** keeps `workspace` a separate environment so a production apply
never needs ryzen-9 (`zbc.config.ts:5-12`). Production names three workspace
credentials as plain keys (`canvas.ts:74-76`; `admin-access-token.ts:3-7`),
copied by hand: the `ws-access` service-token pair; `WS_SUPERVISOR_TOKEN`, one
copy per environment, for the guest and the Worker; and
`CLOUDFLARE_ROOT_TOKEN`, whose workspace copy came from foundry's repo with
`GITHUB_PAT`. Its `preview/secrets.yaml` is a hand copy of production's,
flagged as debt (`preview/canvas.ts:15-21`).

**agent-lab** mints and rotates its stored R2 tokens with the account root,
`root-ryzen-cf`, kept out of its append-only repo on purpose
(`docs/hosting.md:35,91`). Its runbook exports zbc's copy for one
`zbc run … rotate --yes`, then unsets it (`:93-97`), and `stored-token` falls
back to `process.env` for it (`stored-token/index.ts:27-32,160-167`). Being
irreversible, `rotate` first applies r2 with the root exported
(`engine/actions.ts:132`).

**The root's reach**, by name: zbc and eight consumers hold a
`CLOUDFLARE_ROOT_TOKEN` minting into account `99a19e58…`. zbc, foundry and
cedarpad name theirs `root-ryzen-cf`, the token agent-lab borrows, so rolling
it means re-encrypting it by hand into at least four files in three repos. qom
and leeandco, each on its own account, keep one root in one repo.

Nothing stops a preview and a production `gcp-service-account` sharing a
`serviceAccountId` either; only a doc comment keeps them apart
(`gcp-service-account/index.ts:129-134`).

### 2. Somewhere to put a write-once credential

A write-once credential exists only in the minting apply's output; main's
only place for it is the log: `cloudflare-access` prints its pair
(`cloudflare-access/index.ts:769-773`), a leak ADR-0016 by design cannot reach
(ADR-0016:41). cedarpad and leeandco ([cloudflare-access](./cloudflare-access.md))
paste it into a `secrets.yaml` by hand, agent-lab's `stored-token`
([cloudflare-token](./cloudflare-token.md)) writes it from an action with
`sops set --value-stdin` (`stored-token/index.ts:138-158`), and foundry issues
its incus trust token from a script ([incus](./incus.md)).

## The interface, from two implementations

cedarpad and agent-lab share no code but are one operator's repos: two answers
to one gap, not independent designs. Both keep the credential sops-encrypted in
a `secrets.yaml` and moved the root without printing it. They disagree on the
config surface, a copy or a reference: cedarpad copies, across repos and then
environments, having accepted that a copy widens who holds it (a2e8370), with
nothing tying a copy to its original; agent-lab references zbc's, paying with
a shell export for one command. For a write-once value, cedarpad, leeandco and
agent-lab all chose a production `secrets.yaml` in the repo that reads it.

## What it takes upstream

1. **Credentials across environments and projects.** `loadSecrets` reads one
   environment's `secrets.yaml` (`engine/secrets.ts:4-33`) and `ctx.secret`
   only that map (`templates/infra/src/context.ts:28-49`); nothing in the
   engine or `templates/infra/src` reads `process.env`, and `zbc secret get`
   (`commands/secret.ts:304-354`) would replace agent-lab's `sops -d`, not its
   export ([cli-gaps](./cli-gaps.md)). Either `loadSecrets` merges a
   per-environment list of files, so cedarpad's root and bearer rest once but
   agent-lab names a path into another checkout (`hosting.md:94`) that one of
   its two sops recipients cannot decrypt, or `ctx.secret` falls back to
   `process.env`, making every key overridable from the shell: a policy call
   more than a mechanism. A cross-environment import, a hard error today
   (`CONTEXT.md:42`; `engine/resolve.test.ts:87-96`), fits neither: two of
   cedarpad's three values are keys, not outputs, and the Access secret is
   empty after its minting apply (item 2). Every instance here is on Zabaca's
   own account; the bar question is whether other companies run one account
   root across many repos.
2. **Declare the built-ins' credentials.** Only `cloudflare-token` and
   `gcp-service-account` declare `secretOutputs`, and the registry records only
   declared keys (`engine/secret-outputs.ts:109-113,195-203`), so three
   built-ins' credentials reach `--json` and any engine error quoting them
   verbatim, unstarred in the catalog
   (`plugin/skills/zbc/modules.md:21-22,28,38`). `turso` mints a full-access
   `authToken` with no expiry on every apply and never revokes one
   (`turso/index.ts:106-109,166-168,195-198`; [turso](./turso.md)).
   `cloudflare-access`'s `clientSecret` is `''` unless the apply mints or
   rotates it (`cloudflare-access/index.ts:806-807,1215`).
   `cloudflare-tunnel`'s `runToken` (`cloudflare-tunnel/index.ts:253-254,414`)
   already crosses an import at cedarpad (`ws-tunnel-run.ts:36`). Declare all
   three, turso's as `authToken: { rotates: 'each-apply' }`, and star them.
   Open: a declared value under 8 characters warns every run
   (`engine/secret-outputs.ts:118-125`), so should an empty one count as no
   credential? [tailscale](./tailscale.md)'s key asks the same.
3. **`rotates: 'never'`**, declared by no built-in and only by lov's
   pass-through `secret-token` ([cloudflare-token](./cloudflare-token.md)).
   `cloudflare-access` ("created once, thereafter REUSED, never rotated",
   `cloudflare-access/index.ts:54-63`) has no `destroy` (`:65-66`), so it is
   already refused as ephemeral (`engine/resolve.ts:107-115`), and on the
   apply path `'never'` adds only the scrub. `cloudflare-tunnel` has one
   (`cloudflare-tunnel/index.ts:420-440`), so an ephemeral tunnel gets a new
   token every apply, unannounced to a cloudflared the apply cannot reach
   (`:59-62`): only `credentialFile` prints the restart note (`:405-410`).
   `'never'` would refuse it (`engine/resolve.ts:128-140`), but also the
   wirings that hand the token over: `credentialFile`, and cedarpad's
   restarting script (`ws-tunnel-run.ts:10-19`). It also arms the on-demand
   refusal, which assumes any apply rotates (`engine/on-demand.ts:231-244`) and
   is how an irreversible action applies its imports (`engine/actions.ts:132`):
   any such action importing a `'never'` instance, even transitively, would be
   refused, though neither module rotates on re-apply
   (`cloudflare-access/index.ts:1049-1073` unless `rotate: true`;
   `cloudflare-tunnel/index.ts:70-73`). Open: should the refusal fire then,
   before `cloudflare-access` declares `'never'`? Should `rotates` move from
   the module (ADR-0016:35) to the instance, as the tunnel's wirings need?
4. **A hand-off other than stdout.** Move main's `writeSecrets`
   (`commands/secret.ts:43-105`), unexported CLI code outside zbc-core, into
   `templates/infra/src`; take the value on stdin, not `sops set`'s argv
   (`:69-73`); and put the environment name on the context
   (`templates/infra/src/types.ts:98-102`). An action could then store what it
   mints. Open: may `apply` write a committed file too, or only an action whose
   result an operator commits (`hosting.md:99`)?
5. **Two scrub holes ADR-0016 does not list.** `redactError` returns a thrown
   non-`Error` unchanged (`engine/secret-outputs.ts:91-92`): rebuild it. A
   declared credential in `workerVars` goes onto the `wrangler deploy` command
   line (`cloudflare/index.ts:488-495,725`), and a module cannot tell it from
   another output (`types.ts:139-165`): let `cloudflare` ask, and refuse it.

## Evidence

- **cedarpad** at f95b302; no module involved, so not a fork. At the root:
  `zbc.config.ts:5-12`, `vendor/zbc/modules/cloudflare-access/index.ts:769-772`.
  Under `packages/infra/environments/`: `production/canvas.ts:74-76`,
  `production/admin-access-token.ts:3-7`, `workspace/ws-access.ts:70`,
  `workspace/ws-service.ts:56`,
  `workspace/ws-tunnel-run.ts:10-19,36`, `preview/canvas.ts:15-21`; key names
  in `production/secrets.yaml:22-24` and `workspace/secrets.yaml:2-3`. 049bc91
  (2026-08-14) added the Access pair to production, a2e8370 (2026-08-19) the
  workspace root and `GITHUB_PAT` from foundry (its message: copying "widens
  who holds them … asked and answered rather than assumed"), and 5542f86
  (#463, 2026-10-09) the production root from the workspace, by sops without
  printing it.
- **agent-lab** at 6432107; `stored-token` is `novel`, so not a fork:
  `docs/hosting.md:35,91-99`;
  `packages/infra/modules/stored-token/index.ts:27-32,138-167,228-230`;
  `.sops.yaml:5-7`, two recipients, one of them in zbc's `.sops.yaml`;
  `packages/infra/environments/production/secrets.yaml`, which holds no root;
  `production/agent-lab-data-key.ts:8` imports `agent-lab-bucket.ts`, an r2
  instance; 9e81f26 (2026-10-08), whose root came from zbc's secrets.
- **lov** at 902dc42: `packages/infra/modules/secret-token/index.ts:17`, a
  19-line pass-through declaring `tokenValue: { rotates: 'never' }`.
- **The root's reach**, key names in each repo's
  `packages/infra/environments/<env>/secrets.yaml`: `CLOUDFLARE_ROOT_TOKEN` at
  cedarpad `production:27` and `workspace:1`, claude-mitm-proxy `production:1`,
  croft `production:2`, foundry `ryzen-9:5`, games `production:1`, lofi
  `production:1`, railmid `production:5` and web `production:3`, where every
  `cloudflare-token` instance targets `99a19e58…`. qom's root (`production:2`)
  targets `e806306d…`, and leeandco's `CLOUDFLARE_LEECO_ROOT_TOKEN`
  (`production:3`) `aca38b5d…`. `root-ryzen-cf` is named at foundry
  `LEARNINGS.md:794-796`, cedarpad `workspace/ws-token.ts:21` and zbc
  `packages/infra/environments/production/zabaca-dns-token.ts:21` (key at
  `secrets.yaml:12`).
- **main** at 0ef349d, every line as cited above. `engine/` and `commands/` are
  under `packages/cli/src/`, `templates/` and `plugin/` under `packages/cli/`,
  and a bare `<module>/index.ts` under `packages/cli/templates/infra/modules/`.
  `CONTEXT.md`, `.sops.yaml` and ADR-0016
  (`docs/adr/0016-a-credential-is-an-output-the-engine-refuses-to-write-down.md`)
  are at the root.
