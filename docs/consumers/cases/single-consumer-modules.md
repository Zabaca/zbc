# Single-consumer modules — parked

One consumer each. Recorded with enough evidence to revisit if a second
consumer ever needs the same thing; none is proposed for promotion on this
evidence. Grouped rather than given a file each, because a file per module here
would be 20 files of noise.

## Provider modules that would generalise

| Module | Consumer | Deployed | What it does | Note |
|---|---|---|---|---|
| `vercel` | ceo | **no** — unapplied | project + deploy, two modes (`build` local→upload, or `sourceDir`→Vercel builds), settings re-PATCHed every apply, custom domain | `.refine()` forces exactly one of `build`/`sourceDir` (`:235`). Vercel only honours `rootDirectory`/`installCommand`/`buildCommand` on *creation*, so without the extra PATCH pass (`:87-92`) config-as-code silently stops being authoritative |
| `posthog` | ceo | yes, production | dashboards + insights declared in the instance file, upserted by name, soft-deleted on destroy | zbc has no observability or analytics module at all. Keying is documented rather than solved: PostHog does not enforce name uniqueness and tags are paid, so no drift detection (`:12-16`) |
| `obs` | ceo | no — `workstation` env | OBS Studio config as code over obs-websocket against a *running* OBS | 769 lines, the only consumer module with tests. Its extras are the real finding — see [cli-gaps](./cli-gaps.md) |

ceo's `vercel` also invents its own import convention: every string output of
every import auto-flattens to `${instanceName}_${key}` upper-snake
(`:270-280`), where upstream `cloudflare` uses explicit `{name, from, output}`
entries. Worth deciding which zbc endorses before a second module copies the
implicit one.

## foundry's host family — a bare-metal consumer

13 novel modules, **zero divergent** — foundry never edits vendored zbc code, it
writes alongside it. One Ubuntu box running incus guests, systemd units,
docker-compose stacks, GitHub runners and a tailnet. zbc's built-ins cover cloud
plus host primitives (`host-file`, `host-exec`, `systemd-unit`, `vm`,
`incus-core`); everything foundry added sits in the gap between "a file on a
host" and "a service on a network".

Most of these fail the open-source bar in `CLAUDE.md` — they are Zabaca
operations, not things most software companies want. Three are worth keeping in
view because they demonstrate engine-level needs, and are cited in those cases:

- `tailscale-authkey` → [engine-credential-lifecycle](./engine-credential-lifecycle.md)
- `incus-trust` → same case, as the counterpoint: it deliberately **refuses to
  return** the credential, because mint-and-return put a live bearer token into
  an agent's persisted transcript twice in one morning (`:17-24`)
- `tailscale-core` → [engine-shared-module-code](./engine-shared-module-code.md)

Two more are interesting as patterns rather than as modules:

- **`claude-settings`** merges declared entries into `~/.claude/settings.json`,
  a document the Claude Code CLI *also* writes, and owns individual entries via
  a marker so an undeclared one stays findable. `host-file` exists and is wrong
  for this: it converges the whole document and would fight the CLI on every
  apply, each side reverting the other (`:11-13`). **Partial ownership of a
  file zbc does not exclusively own** is a general problem `host-file` cannot
  express.
- **`tailscale-acl`** writes the tailnet policy under `If-Match` with the ETag
  from the same apply's read, validates server-side before writing, and refuses
  any policy that would drop the last SSH rule. Optimistic concurrency and a
  lockout guard are both patterns no upstream module has.

Remaining foundry modules, recorded only: `apt-packages`, `git-worktree`,
`github-runner`, `forge-release`, `prometheus-reload`, `incus-listener`,
`incus-project`.

## varnick's client-* family

Four modules, **nothing has ever run** — no `environments/`, no apply script,
tests answer from stubs built from documented shapes. Design opinion, not
production evidence. `client-core` is covered in
[engine-shared-module-code](./engine-shared-module-code.md); `client-account`
converges a whole Cloudflare tenant zbc does not own, verifying a named human
holds Super Administrator before mutating anything, and reporting rather than
reconciling undeclared zones. Revisit only if varnick ships.

## leeandco's remaining Cloudflare modules

All five exist because that environment spans **two Cloudflare accounts** with
one root credential at rest — the same constraint driving
[cloudflare-token](./cloudflare-token.md). Every one takes its `apiToken` as a
reference to an imported instance rather than a secrets key.

### cloudflare-access — parallel lineage, not a fork

**The `divergent` verdict is misleading here and the survey now says so.**
Upstream's `cloudflare-access` was created 2026-08-19 by `04a73e1`
("promote foundry's incus and Cloudflare modules to core") and extended
2026-08-23 by `7600753` — which the survey named as leeandco's `nearestRev`.
Their copy predates both. So the 0.35 similarity is mostly *upstream moving on*
(it has since gained `appBody`, `findApp` and tunnel integration that leeandco's
lacks), not a consumer diverging from us.

Read as a convergence comparison instead, it yields two facts upstream does not
have, both measured 2026-08-18:

- `PUT /access/organizations` with `{name}` alone is **rejected** — the write
  must carry `auth_domain`
- the org offered only the `cloudflare` identity provider, so a correct-looking
  policy admitted nobody

leeandco's version also converges app + allow policy + Service Auth policy +
org identity providers together, and compares the team domain rather than
writing it (`:184`, `:217`, `:242`, `:382`, `:483`). Outputs are consumed as
`workerVars` at `leeandco.ts:126-127`. Deployed in production.

### cloudflare-zone — divergent, but lineage unverified

**Same caveat as `cloudflare-access` may apply.** `upstreamFirstSeen` for this
module is also **2026-08-19** — it arrived in the same foundry promotion
(`04a73e1`). Whether leeandco's copy predates ours was not established, so treat
the `divergent` verdict as unconfirmed until someone checks the dates on their
side. What follows is true of their module either way; only the word "fork" is
in doubt.

Adds `createIfAbsent` (`:257`, default true) and prints the assigned
nameservers on every apply as the registrar-cutover handoff (`:738`); new
outputs `zoneCreated`, `zoneStatus` (`:648`). Upstream hard-errors on a missing
zone, but a domain registered outside Cloudflare Registrar has no zone until
someone clicks one.

The sharp detail: **an unscoped zone list returns empty, not forbidden**, so
"absent" and "invisible to this token" are the same answer at lookup. They moved
the wrong-account check *before* the create decision so a refusal cannot become
a duplicate zone (`:589-640`). That failure shape belongs in
[engine-api-consistency](./engine-api-consistency.md) — a permission problem
wearing absence's clothes. Deployed in production with `allowDelete: false`.

### cloudflare-email — divergent

Takes `zoneId` as a union of literal-or-reference (`:404`) and `apiToken` as a
reference (`:414`), because upstream accepts only a literal `zoneId` and
`ctx.secrets['CLOUDFLARE_API_TOKEN']`, neither of which exists in a client
account. Its asymmetric teardown is written up in
[engine-verbs](./engine-verbs.md#4-teardown-sees-a-different-world-than-apply).
Deployed in production.

### cloudflare-access-service-token — novel

The long-lived Access service token an agent reaches `/admin` with, as repo
state: `duration` default `8760h` (`:126`), `storeHint` (`:145`), outputs
`tokenId`/`clientId`/`expiresAt` — **the secret deliberately not an output**,
and no `destroy`. Their reasoning against reusing `cloudflare-token` is the
rotation counterpoint in
[engine-credential-lifecycle](./engine-credential-lifecycle.md). Deployed in
production.

### cloudflare-account-member — novel

Who may sign in to the *client's* Cloudflare account, expressed as a diff.
Recorded in `.consumer-survey/leeandco.json`; not written up further.
