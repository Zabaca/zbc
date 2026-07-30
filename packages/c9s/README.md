# c9s

k9s for Cloudflare compute. One live table of everything running in the account,
switchable by resource kind, filterable, refreshing on its own.

**Requires [bun](https://bun.sh).** c9s ships as TypeScript and runs under bun, so
`npx c9s` under node will not work. Use `bunx`.

```bash
bunx @zabaca/c9s --demo    # fixtures, no network, no token
bunx @zabaca/c9s           # live account, needs CLOUDFLARE_API_TOKEN
```

Installed globally (`bun add -g @zabaca/c9s`) the command is just `c9s`. The
package is scoped because npm refuses the bare name: it is "too similar to
existing packages c8, co, coz, c12, cpx, cpr, cli, cpy, crc, cac", a distance
rule on short names that no amount of waiting will clear.

The token needs read on Workers Scripts, Containers, D1, R2, KV, Queues, and
Account Analytics. Nothing needs write: c9s never mutates.

Working in this repo instead:

```bash
bun run --cwd packages/c9s demo
bun run --cwd packages/c9s dev
```

Keys: `:` command, `/` filter, `1-9`/`tab` switch kind, `0` clear project scope,
`j`/`k` move, `↵` describe, `l` logs, `s` shell, `esc` cancel, `r` refresh, `q` quit.

`--demo` is genuinely offline: fixtures, no token, and no `shell` wired in, so `s`
does nothing rather than tearing down the UI to run wrangler against the real
account.

`:` opens the k9s-style command prompt with inline ghost completion and a live
candidate list. Kind keys and short aliases both work, so `:co`, `:cont`, `:ct`
and `:containers` all land on Containers. `tab` accepts the completion, `:q`
quits. Ambiguous input resolves to the first match in `KINDS` order, which is why
`:d` goes to Durable Objects and `:d1` to D1.

## Views

Seven product tables (Workers, Containers, Durable Objects, D1, R2, KV, Queues)
plus two derived ones:

- **`:all`**: every resource in the account on one screen, each attributed to a
  project. Filter it (`/foothill`) to see everything one project owns across all
  products at once, which the Cloudflare dashboard cannot do: it makes you visit
  six product pages and join them in your head.
- **`:projects`**: the rollup, one line per project with counts per product.

Workers carry live 24h metrics (`REQ`, `ERR`, `P50`) from the GraphQL Analytics
API. That query is allowed to fail: a token without analytics scope still gets a
usable table, with `-` in those columns.

## Actions

- **`↵` describe**: the full API object, plus live container instances (state,
  location) fetched through wrangler.
- **`l` logs**: streams `wrangler tail` into a pane. Closing it kills the
  subprocess; otherwise every `l` leaks a wrangler.
- **`s` shell**: unmounts Ink, hands the terminal to `wrangler containers ssh`,
  and mounts a fresh app back on Containers when the session ends. Ink and an ssh
  session cannot both own the tty.

## Project scope

Cloudflare has no namespace, so c9s adds one. `:proj foothill-inbox` sets a scope
that **persists as you switch resource kinds**, the way a k9s namespace does: press
`5` and you see only that project's R2 buckets. The scope shows in the info panel
and in the table title (`R2(foothill-inbox)[1]`). `0` clears it, as does
`:proj all`.

Enter on a row in the `:projects` rollup scopes to that project and drills into
`:all`, which is the fastest way in.

Scope and filter are different tools: scope is a persistent lens on one project,
`/` is a transient search inside whatever the scope currently shows.

## Projects, and why they are inferred

Cloudflare has no namespace. An account is one flat bag, the only real namespace
primitive (dispatch namespaces) is Workers-for-Platforms only, and worker tags
(`cf:service=`) are set inconsistently and exist on Workers alone. So c9s infers:
the `cf:service` tag when present, the owning script for a Durable Object, and
otherwise the longest Worker name that prefixes the resource at a dash boundary.

That heuristic is honest but not perfect. A container named `warehouse-warehouse`
with no matching `warehouse` Worker becomes its own project rather than joining
`zbc-warehouse`. Naming that follows the Worker fixes it; nothing else can, short
of Cloudflare shipping real grouping.

## Auth

`CLOUDFLARE_API_TOKEN` from the environment, else decrypted from this repo's
`packages/infra/environments/production/secrets.yaml`. Account is
`CLOUDFLARE_ACCOUNT_ID`, else the token's first account. Both are exported into
the environment so the wrangler shell-outs reuse them.

## Adding a resource kind

One entry in `src/resources.ts`: a key, command aliases, a title, the column
headers, and a `list` that returns rows keyed by those headers. Nothing else
changes; the number key, the `:` completion, the table, `all` and `projects` all
derive from it. Row keys beginning with `_` are metadata, not columns (`_raw`
feeds the describe pane, `_id` is the handle wrangler needs). Adding a fixture row
in `src/fixture.ts` is what makes it show up under `--demo` and in tests.

## Why some things shell out to wrangler

The REST API refuses container instances for API-token auth
(`/containers/applications/{id}/instances` → `NOT_ENABLED`) while wrangler's own
session succeeds, and the cloudchamber paths reject the token outright. Log
tailing and ssh have no REST equivalent at all. So those three go through
`bunx wrangler`; everything else is a direct REST call.

## What is deliberately not here

**No mutation.** c9s lists, watches, and shells in. Changing infrastructure is
`zbc apply`'s job, and keeping those apart is what stops the declarative path from
being quietly bypassed.

## Note on the abstraction

A Worker is not a pod. There is no long-lived process to watch, just isolates per
request, so "what is running" is only literally true for Containers and Durable
Objects. For Workers the honest columns are request volume, errors, CPU, deploy
age, and whether logs are on, which is what the table shows.
