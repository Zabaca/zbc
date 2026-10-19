# incus — new

**Consumers:** foundry  ·  **Deployed in production by:** foundry

One implementation, on ryzen-9, foundry's only environment. cedarpad (two machines; its release
needs the remote) and agent-lab (since idle) enrolled on the daemon it configures, and implement
none of it.

## What they needed

The far end of `vm`'s `target: { remote, project }`, which incus-core says "assumes a daemon
someone configured by hand" (`incus-core/index.ts:17-20`). For cedarpad to converge its own guest
on ryzen-9 (foundry ADR-0026), the daemon must listen on the network, hold a project to scope client
certificates to, and trust each declared identity restricted to it, enrolled by a single-use token
issued outside apply (foundry ADR-0027). Beside that: Prometheus metrics, and in-guest checks of
what a `vm-provision` script declared.

## The interface, from one implementation

| Module: config → outputs | incus imposes | foundry chose |
|---|---|---|
| `incus-listener`: `port` (8443), `tokenExpiry` (`1H`) → `address`, `tokenExpiry`, `changed` | Only daemon-wide `core.remote_token_expiry` bounds a token's life (incus 6.0.0 has no `--expiry` on `trust add`); it accepts `0H`, issuing dead tokens | No address field: binds `tailscale ip -4`, refusing anything outside 100.64.0.0/10. Refuses `0H`. Owns, and reads back, only its two keys |
| `incus-project`: `name`, `config` → `name`, `created`, `changed` | incus adds six `features.*` keys at creation, so only declared keys converge. Under `features.profiles: 'false'` guests inherit `default`'s profile, hidden from restricted certificates | Refuses `default`, where foundry's guests live. Leaves the project's `restricted` key unset: a certificate's guests can mount host paths. No `destroy` |
| `incus-trust`: `name`, `projects` → `name`, `projects`, `state`, `changed` | A token embeds the server's addresses, so trust follows the listener. The store keys on the name: one identity per machine | Every identity `--restricted`, never to `default`. An existing entry is checked, never adopted. Rotation is additive: no `destroy` |

**What the read-back cannot see.** From 2026-09-14 to 2026-09-24 a claude-mitm-proxy `tailscale
serve` mount on `:8443` left incusd "deaf to the tailnet while still answering its own machine"
(966e36b). The guard is on the serve side ([tailscale](./tailscale.md)).

**Handing the token to a holder outside the apply.** Until 2026-08-18 an agent's apply printed the
live bearer token from `config trust add` into a persisted transcript, unredactable because
"printing the token *is* the mechanism" (foundry ADR-0027). Now it only reports `trusted`,
`pending` or `unenrolled`, exiting 0 on `unenrolled` by decision: only acts outside the apply
change it. ADR-0016:49 calls this right for `incus-trust`, not as the general pattern. The act,
`bun run incus-enrol <name>`, takes its scope from the declaration through the module's schema,
refuses an enrolled name, an outstanding token or a never-expiring daemon, and prints the token
once. [engine-verbs](./engine-verbs.md) counts it among operator acts outside zbc.

**Metrics.** Since 2026-08-03 a root script sets `core.metrics_address=127.0.0.1:8444` and trusts
a self-signed certificate minted on the box, outside `secrets.yaml`, as `--type=metrics`, because
`host-file` writes as the applying user (main `host-file/index.ts:31-41`). An edit to the script
alone waits for a reboot or a failed run (main `systemd-unit/index.ts:58-59`;
[host-modules](./host-modules.md)).

## What it takes upstream

The bar: one consumer, one machine, every client identity a Zabaca repo's, and a listener needing
Tailscale, which main has no module for ([tailscale](./tailscale.md)). Main ships the client half
(`vm/index.ts:488-494`), used only by cedarpad against this daemon.

1. **Three modules beside `incus-core`** (`modules: ["incus-core"]`, ADR-0015): `incus-project`
   and `incus-trust` close to foundry's shapes, and a server-config module for the two keys whose
   open decision is the address, declared with the wildcard refused or resolved from tailscaled.
   Metrics adds a third key and a certificate-file `--type=metrics` mode on `incus-trust`. They
   would be the first callers of four incus-core exports (`incus-core/index.ts:131,146,181,193`).
2. **Enrolment as an action on `incus-trust`.** `zbc run <env> <instance> enrol` already parses the
   declared config through the module's schema, outside apply (`engine/actions.ts:116,138`;
   `types.ts:23-24,33-42`); foundry's engine predates actions. The action would still print the
   token, which no engine redaction reaches (ADR-0016:41): that hand-off is
   [engine-credential-lifecycle](./engine-credential-lifecycle.md)'s. `incus-onboard`, an
   onboarding walk-through, adds only foundry's merge workflow, hardcoded to cedarpad.
3. **The cross-instance rules on the imports edge.** Only a repo test holds that a trust entry
   follows the listener and its projects and names only declared ones; the module reads nothing
   through `imports`. As `{ from, output: 'name' }` references, `projects` entries would fail by
   name when undeclared and carry the order. The listener rule would also need the entry, or its
   enrol action, to read a listener output such as `tokenExpiry`.
4. **vm-provision (upgrade): a check declared with the provision.** It skips a run whose digest
   marker matches unless `force` is set, and reads nothing back
   (`vm-provision/index.ts:124-144,175-178`). A CI guest had been provisioned many times "by a
   script that had never installed a node"; foundry's three tests now `incus exec` into each CI
   guest to check what a provision change declared (node, a working bwrap, a sysctl). Their stated
   reason, an older marker stopping reruns, does not hold: the digest covers the script
   (`provision-core/index.ts:28-44`). A second `force: true` instance with its own `marker` can run
   such a check today (`vm-provision/index.ts:92-93,141,175`; likewise
   `remote-provision/index.ts:77,92-161`), as can foundry's vendored copy. Missing is a check
   attached to its provision, run whether or not the script ran. `ready` is a poor carrier: its
   probe is retried to a timeout, and runs only where the instance is imported
   (`types.ts:44-56,68-75,86-87`). One such guest runs zbc's own `@zabaca/agent` tests
   (`.github/workflows/publish-npm.yml:100-108`).
5. **The client's config directory.** incus keys an identity to the directory, not a repo: a second
   repo using ryzen-9's default, which holds cedarpad's certificate, would silently act inside
   cedarpad's grant. The rule (agent-lab ADR-0010), a hand-set `INCUS_CONF` per repo, reaches
   `vm`'s commands because `host-exec` passes the environment through
   (`host-exec/index.ts:107-119`). No `target` field or documented convention names the
   certificate an apply presents.
6. **Either way, main's docs describe callers zbc does not have:** incus-core's header and those
   exports' docs (`incus-core/index.ts:4-5,30-35,124-129,139-142,177-179,186-191`), and `vm`'s note
   on runners (`vm/index.ts:50-57`).

The 2026-09-02 cases recorded the three modules and the hand-off, both still open. Unverified:
whether the three identities are still in the trust store, readable only by incus on ryzen-9.

## Evidence

No upstream counterpart, so no nearestRev. On main (0ef349d),
`git grep -E 'project (create|set|delete)|trust (add|remove|revoke)|add-certificate|https_address|metrics_address'`
over `packages/cli/templates/` and `packages/cli/src/` hits only a captured help transcript
(`incus-core/incus-config-set.help.txt:14`) and a timeout doc (`incus-core/index.ts:38`). foundry
read at ef1d3e14 (2026-10-18); its incus modules are unchanged since 2026-08-19. A bare ADR number
is zbc's (ADR-0016 is the secret-outputs one of its two); foundry's are marked.

- foundry modules, all 40719103 (2026-08-18), under `packages/infra/modules/`:
  - `incus-listener/index.ts:14-48,66-96,109,136-201`; foundry ADR-0027:64-73,86-90
  - `incus-project/index.ts:21-51,83-152`; `environments/ryzen-9/incus-project-zabaca.ts:20-33`;
    `LEARNINGS.md:513-582` (the profile behaviour, probed live)
  - `incus-trust/index.ts:17-68,122-135,224-335`, its apply read-only since da1a626c
    (2026-08-18); instances `ryzen-9/incus-trust-cedarpad.ts`, `incus-trust-cedarpad-mac.ts:9-17`
    and `incus-trust-agent-lab.ts`; foundry ADR-0026:10-15 and ADR-0027:39-44,108-120. All three
    identities were redeemed at least once (ec5c499d, dbb38be2, `LEARNINGS.md:381-396`).
- The order and scope rules: `environments/ryzen-9-incus-remote.test.ts:166-172,190-207`.
- `scripts/incus-enrol.ts:25-31,77-101,114-179` (da1a626c); ec5c499d (2026-08-19) quotes it
  refusing to reissue for `cedarpad` on the production daemon.
  `scripts/incus-onboard.ts:9-43,154-232` (dbb38be2, 2026-08-19), run against mac-studio through to
  `done`; it has never written a declaration (mac-studio's was hand-written,
  `incus-onboard.ts:130-132`). `vendor/zbc/src/types.ts:13-20`: the vendored engine (d4cb29d,
  squashed 2026-08-23) has no `actions`.
- Metrics (7cdf1a3a, 2026-08-03): `environments/ryzen-9/hardening-script.ts:30-34,347-361`, run by
  the `RemainAfterExit` oneshot in `hardening.ts:4-28`;
  `services/monitoring/prometheus/prometheus.yml:58-68`; the certificate in the live trust store,
  foundry ADR-0027:160-165.
- The `:8443` hold: claude-mitm-proxy 7d08722 (2026-09-14, terminals on ryzen-9 at serve port 8443)
  and 966e36b (2026-09-24).
- In-guest checks: cdc016ca (2026-09-14), 51031018 (2026-09-15) and 28e31c26 (2026-10-12), each
  also editing `ryzen-9/ci-shared-provision.ts` and `ci-fredrin-provision.ts`. Tests:
  `environments/ryzen-9-live-ci-node.test.ts:44-56,78-129` (the node quote at :53-55),
  `ryzen-9-live-ci-tooling.test.ts:41-55`, `ryzen-9-live-ci-compaction.test.ts:25-34`; their stated
  reason, `machine-asserted.test.ts:86-95`. The vendored `force`:
  `vendor/zbc/modules/vm-provision/index.ts:84,134`.
- cedarpad: `packages/infra/environments/workspace/ws.ts:59-81`, the only remote `target` in any
  surveyed checkout; `.claude/skills/release/SKILL.md:229-231`.
- agent-lab: `docs/adr/0010-agent-lab-has-its-own-incus-client-identity.md` (its ryzen-9 checkout);
  the registry notes it dropped its ryzen-9 environment.
- main (0ef349d): `vm`'s remote `target` landed in 04a73e1 (2026-08-19). The four incus-core
  exports have no caller outside incus-core's `index.ts` and `index.test.ts`. `findVmOutputs`
  matches only vm-shaped imports (`vm-provision/index.ts:56-64`), so a check instance can also
  import the provision it follows. The 2026-09-02 cases at `4b80c2e`:
  `single-consumer-modules.md:36-38,55-57` and `engine-credential-lifecycle.md:42-66`.
