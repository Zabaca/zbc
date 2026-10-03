# Built-in modules

The catalog of what `zbc add` can install. It is a map, not the manual: before
writing an instance, read the module's `index.ts` (`vendor/zbc/modules/<name>/`
in subtree mode, `packages/infra/modules/<name>/` in copy mode). The doc comments
on its `configSchema` are the manual, and `registry.json` names the secrets it
reads and the token scopes it needs.

**Kinds.** A *module* gets instances. A *library* is code that sibling modules
import as `../<name>`; it has no instance, and `zbc add` installs it
automatically. An *app* is a whole package scaffolded into `packages/<name>/`,
together with the modules it deploys through.

## Cloudflare

| Name | Kind | Converges | Outputs | Credential |
| --- | --- | --- | --- | --- |
| `cloudflare` | module | Deploys a Worker from a package's own `wrangler.jsonc` (assets, Durable Objects, Containers). The only *deploy* module. See [wiring.md](wiring.md) | `deployUrl`, `workerName` | `CLOUDFLARE_API_TOKEN`, or `apiToken: { from, output }` |
| `cloudflare-token` | module | Mints a scoped account-owned API token from a root token. R2 S3 credentials come with it. Has a readiness probe | `tokenId`, `tokenValue`*, `s3AccessKeyId`, `s3SecretAccessKey`* | `CLOUDFLARE_ROOT_TOKEN` (`rootTokenSecret`) |
| `cloudflare-zone` | module | A zone's DNS records (authoritative, deletes gated) and settings (forward-only) | `zoneId`, `zoneName`, `nameServers` (array), counts | `apiToken` ref, required |
| `cloudflare-tunnel` | module | A remotely-managed tunnel, its ingress and DNS records | `tunnelId`, `runToken`, `hostnames` | `apiToken` ref, required |
| `cloudflare-access` | module | A Zero Trust application and its allow / service-auth policies | `appId`, `aud`, `teamDomain`, `clientId`, `clientSecret`, … | `apiToken` ref, required |
| `cloudflare-email` | module | Email Service for a domain (beta): sending (SPF/DKIM/DMARC) and inbound routing rules | `domain`, `addresses`, `dnsStatus`, … | `CLOUDFLARE_API_TOKEN` (extra Email scopes) |
| `d1` | module | A D1 database plus idempotent schema (`statements`, `additiveColumns`). Has a readiness probe | `databaseName`, `databaseId` | `CLOUDFLARE_API_TOKEN` (D1: Edit) |
| `r2` | module | An R2 bucket | `bucketName` | `CLOUDFLARE_API_TOKEN` (R2 Storage: Edit) |
| `cloudflare-api` | library | API root, response envelope, `cf()` helper, errors | — | — |

\* declared secret output: redacted from logs and `--json`.

A credential marked "`apiToken` ref" comes from a `cloudflare-token` instance
that this instance imports: `apiToken: { from: '<token instance>', output: 'tokenValue' }`.
It is never a `secrets.yaml` key.

## Other providers

| Name | Kind | Converges | Outputs | Credential |
| --- | --- | --- | --- | --- |
| `turso` | module | A Turso database (optionally `migrationsDir`) | `databaseUrl`, `authToken` | `TURSO_API_TOKEN` |
| `fly` | module | A Fly.io app deploy, for payloads that need raw inbound TCP | `appName`, `hostname` | `FLY_API_TOKEN` |
| `gcp-service-account` | module | A GCP service account plus a fresh key every apply, pruned to `maxKeys`. Has a readiness probe | `saEmail`, `saKey`*, `saKeyId` | `GCP_SERVICE_ACCOUNT_KEY` (`credentialSecret`) |
| `gcp-api` | library | Google REST root, RS256 JWT bearer grant, error shape | — | — |

## The host running apply

These converge the machine `zbc apply` runs on, or a machine it can reach.

| Name | Kind | Converges | Outputs |
| --- | --- | --- | --- |
| `host-dir` | module | A directory: mode, owner via `sudo chown` | `path`, `mode`, `owner`, `changed` |
| `host-file` | module | A file from inline content or a SOPS secret value | `path`, `changed` |
| `host-symlink` | module | A symlink. Refuses to replace a regular file | `path`, `target`, `changed` |
| `systemd-unit` | module | A user or system unit (service or timer) | `unit`, `changed`, `active` |
| `systemd-mask` | module | A masked user unit (needs a `reason`) | `unit`, `path`, `changed` |
| `docker-compose-stack` | module | `docker compose up -d` in a directory | `dir`, `running` |
| `vm` | module | An incus container or VM plus cloud-init for SSH | `name`, `type`, `sshUser`, … |
| `vm-provision` | module | The inside of an incus guest over `incus exec` (packages, files, units), digest-gated | `instance`, `digest`, `changed` |
| `remote-provision` | module | The same converge over SSH, for a machine this repo does not host | `host`, `digest`, `changed` |
| `incus-storage-pool` | module | An incus storage pool | `name`, `driver`, `changed` |
| `host-exec` | library | The one `exec` seam host modules shell out through (`withExec` in tests) | — |
| `incus-core` | library | `sudo incus` invocation and JSON reads | — |
| `provision-core` | library | Digest-and-marker logic so a second provision is a no-op | — |

`changed` outputs exist for sequencing. Import the instance whose change should
trigger a restart.

## App templates

| Name | What it scaffolds | Deploys through |
| --- | --- | --- |
| `inbox` | Agent-accessible email inbox Worker: JSON API, an MCP server at `/mcp`, web UI | `cloudflare`, `cloudflare-email`, `r2` |
| `secret-relay` | The project's own Secret Relay, which `zbc secret request` / `edit` need | `cloudflare` |
| `warehouse` | dlt + dbt-duckdb data warehouse on a Container, with parquet marts in R2 | `cloudflare`, `r2` |
| `walgit` | A git host whose source of truth is a write-ahead log in object storage | `cloudflare`, `r2` |

An app template has no placeholders. Its per-project identity (`workerName`,
bucket bindings, vars) lives in the instance files you write for it, and
`zbc add <app>` prints them.
