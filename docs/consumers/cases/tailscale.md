# tailscale — new

**Consumers:** foundry, claude-mitm-proxy  ·  **Deployed in production by:** foundry, in `ryzen-9`, its one environment (`tailscale-acl`, `tailscale-authkey`; `tailscale-serve` until 2026-09-09), claude-mitm-proxy (outside zbc: its terminal installer, rolled out to mac-studio and ryzen-9 on 2026-09-14)

**Independence:** low. foundry's four directories are one author's, `tailscale-core` extracted from two. claude-mitm-proxy shares no code but has foundry's operator and writes the same node's serve config.

## What they needed

Three things: auth keys minted in the apply only for a missing or offline device, not a 90-day key in `secrets.yaml` that lapses unseen until a rebuild; the tailnet policy converged whole from the repo, guarded because it grants the access to write it; and serve routes declared, not left only in tailscaled's state. claude-mitm-proxy, whose web console sits behind zbc's `cloudflare-access`, rejected main's nearest equivalent for its shell, a Cloudflare tunnel behind Access: the tailnet is a second door.

## The interface, from five implementations

### Auth keys (foundry)

Config `tags` (required, `tag:` only), `checkHostname` (without it every apply mints), `expirySeconds` (900, at most 3600), `reusable` (false), `preauthorized` (true), `ephemeral` (false; Tailscale's device flag) and `description`; outputs `key`, `minted`, `tags`, `reason`. `key` is `''` when nothing needs enrolling: the provisioner's steady state, nothing minted or run. Its instance imports the policy's only for ordering: tags without a policy owner are refused at mint.

### The policy file (foundry)

Config `policyPath`; outputs `tailnet`, `sshActions`, `changed`. It owns the whole document (a partial writer must round-trip others' comments), with a HuJSON character scanner, a comparison blind to key order and comments, server-side validation before the write, `If-Match` on the ETag this apply read, and a refusal to drop the last ssh rule. No `destroy`, deliberately.

### Serve routes (foundry, claude-mitm-proxy)

Four rules agree:

- **One route, not the node's config:** foundry converges one `(port, path)`, claude-mitm-proxy only adds missing mounts; foundry's ADR rejected owning the config, as a first apply would delete every unmigrated route.
- **Never over Funnel:** the tailnet is their whole authentication boundary.
- **Read the status back**, failing if the route is absent.
- **Match by port**, not the MagicDNS name, which a declaration cannot know.

Differences:

| | foundry | claude-mitm-proxy |
|---|---|---|
| status read | JSON | text, whose port-less :443 hid mounts and Funnel until `ef3e3b9` |
| a listener on the port | ignored | refused since `966e36b`, after its :8443 mount left ryzen-9's incusd deaf to the tailnet: provider behaviour, not a quirk |
| proof | the read-back | also a TLS fetch from the operator's machine: a Linux host cannot reach its own serve URL |
| URL from | the status, else a placeholder | `Self.DNSName`, else fatal |
| teardown | none | `--uninstall`, on the recorded port |
| paths per port | one per instance | two |
| runs on | the applying node, via `host-exec` | a fleet member, over ssh, lima or locally |

Uncounted, varnick-app's installer keeps the four rules on ryzen-9's :8444 but refuses other paths on its port.

### The door (foundry's `tailscale-core`)

A library: the OAuth exchange, the API root and `oauthFields` (`tailnet`, `clientIdSecret`, `clientSecretSecret`), spread into both schemas. The client never expires and has no human owner; each apply trades it for a one-hour bearer. Scopes: `auth_keys` and `devices:core:read` for keys, `policy_file` for policy.

## What it takes upstream

Main has no Tailscale module or library.

**Auth keys:** a new `packages/cli/templates/infra/modules/tailscale-authkey/`; main already ships the provisioner half, foundry's code promoted in `04a73e1`, whose comments name "the authkey module". Against foundry's version:

- Declare `secretOutputs: { key: { rotates: 'each-apply' } }` (ADR-0016; foundry's engine predates it). The steady-state `''` is under `MIN_REDACTABLE_LENGTH`, so each mint-free apply would warn "too short to redact", as a declared `cloudflare-access` `clientSecret` would on reuse; [engine-credential-lifecycle](./engine-credential-lifecycle.md) decides whether an empty declared value is no credential.
- Rename `ephemeral` (say `ephemeralDevice`): the engine ignores it, but readers see zbc's flag.
- Drop the `'foundry apply'` `description` default.
- Add no `ready` probe. ADR-0013 and `types.ts` call this a lag case, but it has no retry; its incident was reading `online` for `connectedToControl`, so every apply minted.

**Mint avoidance** stays module config (ADR-0016), and no shared helper suggests itself: `cloudflare-token`, `gcp-service-account` and `turso` mint every apply, `cloudflare-access` once, for a holder outside the apply. Only `tailscale-authkey` skips a mint because nothing needs a key.

**The policy file:** a new `tailscale-acl/` resolving `policyPath` against `ctx.projectRoot`, not `process.cwd()`. No module or engine file on main writes conditionally (`If-Match`, an ETag, a 412); `host-file`, the nearest whole-document converge, compares bytes locally. `cloudflare-access` refuses to lock out its operator, but no module guards a policy document. foundry's ssh guard, with no override, assumes every box's only door is Tailscale SSH: a quirk in that form.

**Serve routes:** a new host module, `tailscale-serve/`, through `host-exec`: the four rules, the listener check, the JSON status only, and a `destroy` (`tailscale serve --https=<port> --set-path=<path> off`, then a re-read), so `zbc destroy <env> <instance>` replaces foundry's by-hand take-down. foundry reverted a `state: 'absent'` teardown the day it landed (mutations left the suite green; it holed the drift test), then built the seam to test such code: main's `host-exec`. Registry prerequisites: the applying user is tailscaled's operator; targets should be loopback TCP, since tailscaled 1.102.5 serves `unix:` only to root or an operator who can `sudo tailscale`.

Out of scope: routes nobody declares, or that a deleted declaration leaves live ([engine-undeclared-state](./engine-undeclared-state.md)); and claude-mitm-proxy's far half, where no apply runs: `host-exec` acts only on the applying machine, and `remote-provision` reaches another only with a digest-gated script and no read-back ([host-modules](./host-modules.md)).

**The door:** `tailscale-core` as a `kind: "library"` (ADR-0015), using `ctx.secret` for its missing-secret check.

**The bar.** Outside comments, only the `description` default and the ssh guard are foundry-specific, and `tailscale-serve` touches only the applying node. But it is all one operator's tailnet: do companies other than Zabaca run one they would converge from a repo? foundry keeps these modules to edit them freely.

## Evidence

**foundry** (archive at `ef1d3e14`; history read over ssh on ryzen-9). Novel, so no `nearestRev`: first written on 2026-08-04 (`abcd9380` authkey, `34a55fb9` acl), 2026-08-06 (`cf4a94ed` serve) and 2026-08-07 (`df9c7553` core). Its one environment: `zbc.config.ts`.

- `packages/infra/modules/tailscale-authkey/index.ts:5-35,58-89,101-124,131-151,153-224` (the `description` default at `:160`); instance `environments/ryzen-9/vultr-authkey.ts:13-21`, importing the policy instance at `:20`, consumed at `vultr.ts:43,66-72` through `vendor/zbc/modules/provision-core/index.ts:126-141` and `vendor/zbc/modules/remote-provision/index.ts:125`; a tag without a policy owner refused at mint, `environments/ryzen-9-agent-isolation.test.ts:54-57`
- `modules/tailscale-acl/index.ts:7-30,34-96,102-117,131-145,158-210` (whole-document ownership at `:10-14`, `process.cwd()` at `:159-161`); instance `environments/ryzen-9/tailscale-acl.ts:26-31`
- `modules/tailscale-core/index.ts:3-31,33-52,59-92`
- `modules/tailscale-serve/index.ts:5-34,49-61,69-83,85-110,112-116,120-133,140-171,174-178`; `docs/adr/0016-tailscale-serve-is-declared-one-route-at-a-time.md:13-32`; route files from `cf4a94ed` to `4d50a4d8` (2026-09-09); the teardown `06cd9c65`, reverted with both reasons in `3eb836e7`, and the seam `845f59f1`, all on 2026-08-15; routes other repos own on the same node, `environments/ryzen-9-live-tailnet-routes.test.ts:410-414` (claude-mitm-proxy's :443) and `:423-428,456` (varnick-app's :8444, live since 2026-10-10)
- `LEARNINGS.md:852-858` (the OAuth client), `:889-893` (`connectedToControl`), `:898-907` (the 90-day key)
- The engine: zbc-core v0.12.0 (`CLAUDE.md:202-204`), with no `secretOutputs` in `vendor/zbc/src/types.ts:7-20`; CLI 0.7.0 (`package.json:33`)
- Keeping the modules: `CLAUDE.md:197-200`. `tailscale-core/index.ts:30-31` also cites varnick ADR-0006 (`ryzen-9:~/varnick/.scratch/varnick/adr/0006-client-platforms-leave-foundry-at-the-first-client-secret.md:26-32`), which decided where a client platform's infrastructure lives, not what goes to zbc. Of the eight foundry modules it lists, five went upstream in `04a73e1`; `github-runner`, `tailscale-acl` and `tailscale-authkey` did not

**claude-mitm-proxy** (`9b46f8f`; commits from the local checkout at `fb520fa`, where the cited lines are unchanged). Not a module, and convergence with foundry's serve, not a fork: it dates from 2026-09-14 (`c1e7f51`) and shares no code.

- `scripts/remote/terminal-setup.sh:4-7,69-91,95,118-133,426,516-558,563-571`; `scripts/install-terminal.sh:6-16,80-96,116-121,153-159`
- `docs/adr/0022-a-terminal-is-a-capability-and-tailscale-is-its-only-door.md:19-23,27-49,61-65,79-83`; `docs/adr/0023-the-console-is-a-view-and-cloudflare-access-is-its-door.md:54-55,66-68`, with `packages/infra/environments/production/fleet-access.ts`
- the rollout `7d08722` (2026-09-14); `966e36b` and `ef3e3b9` (2026-09-24)

**varnick-app** (`f5b7bd2`; the cited files are unchanged since `df8d621`; uncounted, as product code run on users' hosts that its zbc project does not declare). Not independent of claude-mitm-proxy either: its Funnel awk (`scripts/remote/install-peer.sh:104-105`) is `c1e7f51:scripts/remote/terminal-setup.sh:450-452`, verbatim.

- `scripts/remote/install-peer.sh:81-117,123-196` (other paths on its port refused at `:145-147`); `docs/adr/0011-each-host-serves-the-phone-page-behind-tailscale-serve.md:29,35-38`

**main** (`0ef349d`):

- No Tailscale module: `git log main -- 'packages/cli/templates/infra/modules/tailscale*'` is empty, and the word occurs under `packages/cli/` only in comments and `host-exec`'s test fixtures. `cloudflare-tunnel/` and `cloudflare-access/` ship: `git ls-tree main packages/cli/templates/infra/modules/`
- The provisioner half, promoted in `04a73e1` (2026-08-19): `provision-core/index.ts:18-27,103-127,132-147`; `vm-provision/index.test.ts:136-154,170-177`
- Secret outputs, ADR-0016 (`40ef706`, #129, 2026-09-08): `docs/adr/0016-a-credential-is-an-output-the-engine-refuses-to-write-down.md:42,44`; `engine/secret-outputs.ts:40,118-125`, with one registry per apply at `engine/apply.ts:190`; `cloudflare-access/index.ts:806-807`, which declares no `secretOutputs`
- Engine surface: `src/define-module.ts:41`; `src/types.ts:61-66` (readiness), `:101` (`projectRoot`), `:145` (`secret`); `docs/adr/0013-readiness-is-a-precondition-of-the-imports-edge.md:9,13`
- Minters: `cloudflare-token/index.ts:292-318`, `gcp-service-account/index.ts:245-258`, `turso/index.ts:165-168`; `cloudflare-access/index.ts:54-63,1049-1076`
- No conditional write in a module or the engine: `git grep -n -i -E 'if-match|etag|412|hujson' main -- packages/cli/templates/infra packages/cli/src` finds nothing (walgit's store, an app, has one: `packages/cli/templates/apps/walgit/shared/store.ts:186-201`); `host-file/index.ts:27-32`
- Lockout guard: `cloudflare-access/index.ts:134-138,854-861`, since `7600753` (2026-08-23)
- Host surface: `host-exec/index.ts:1-20`, promoted in `2d18477`; `remote-provision/index.ts:13-25,91-131`; targeted destroy at `commands/destroy.ts:18-22`
- The library kind, ADR-0015 (`6030286`, #126): `docs/adr/0015-a-library-is-a-registry-kind.md:23`. Its `:13` says the `provision-core` that `tailscale-core` copied was already upstream; it was foundry's own until `04a73e1` (2026-08-19), and `tailscale-core` dates from 2026-08-07
- Paths: bare `<module>/index.ts` and `index.test.ts` are under `packages/cli/templates/infra/modules/`; `src/` is `packages/cli/templates/infra/src/`; `engine/` and `commands/` are under `packages/cli/src/`; `docs/adr/` is the repository root's.
