# @zabaca/zbc

Notes for releases that change behaviour a consumer depends on. Releases that
only add or fix things are described by their `release(cli): @zabaca/zbc <x.y.z>`
commit message and the PRs it names; this file exists for the ones a consumer
has to read before upgrading.

## 0.14.0

### An import naming an instance the environment does not contain is now a hard error

**If an instance file imports an instance whose own file is missing from the
environment directory — or does not `export default` it — `zbc apply` now fails
instead of running.** The message names both:

```
Instance "web" imports "main-db", which is not in packages/infra/environments/production
```

Before, this was two silent shrugs that compounded. The dependency sort dropped
the edge, so the importer could run first, and the apply loop then wrote
`undefined` into the context under that name. What the operator saw was a module
reporting a missing OUTPUT — "instance main-db doesn't emit databaseUrl" — for an
instance that was never there at all, which sends the reader to the wrong file.
No environment that applies today is affected: every import it resolves is one
the engine already found.

`zbc destroy` deliberately does **not** enforce this. An environment whose graph
has gone bad is exactly the one you need to be able to tear down, and refusing
there would strand every resource in it; destroy never needed the missing
instance's outputs, so the edge is skipped as before.

### `zbc destroy` may apply an imported instance, when a destroy asks for its output

A `destroy` used to receive `imports: {}` — the engine refused to look anything
up, on the theory that the imported instance might already be gone. Modules
worked around it: `cloudflare`'s destroy carried a swallowed catch around its
`apiToken` reference and fell back to a `CLOUDFLARE_API_TOKEN` in
`secrets.yaml`, which is a second copy of a credential `cloudflare-token` mints
fresh on every apply and never persists.

Now `ctx.output` answers during a destroy, and the engine applies the referenced
instance on demand to answer it — once per run, in dependency order, logged:

```
→ applying deploy-token (needed by web's destroy)
```

**Opt-by-use:** a destroy that never reads an import applies nothing. **But if
your worker instance declares `apiToken: { from, output }`, its teardown now
resolves that reference rather than reading `secrets.yaml`** — so the imported
instance's apply has to succeed for the destroy to proceed. Removing a
now-unused `CLOUDFLARE_API_TOKEN` from an environment that only kept it for
teardown is safe; keeping it costs nothing.

Two limits worth knowing, both deliberate:

- **A targeted `zbc destroy <env> <instance>` refuses to do this** and says so.
  A full-environment run tears down whatever it applied later in the same pass
  (an import sorts before its importer, so it sorts after it in reverse); a
  targeted run has no such pass, and the target filter exists precisely because
  a thing's dependencies are shared infra you did not ask to touch. Provisioning
  that infra and walking away is the same mistake with the sign flipped. Run the
  full destroy, or apply the imported instance yourself first.
- **If a full destroy aborts partway, something it applied on demand can outlive
  the run.** It was going to be torn down later in that same pass; the pass
  stopped. Re-running `zbc destroy <env>` finishes the job.

A `destroy` that wraps `ctx.output` in a `try`/`catch` — the shape the old
`cloudflare` destroy had, so the shape a fork most likely copied — swallows the
engine's request to apply the import, gets nothing, and takes its fallback. The
engine cannot stop that (nothing in JavaScript survives a bare `catch`), so it
notices afterwards and prints a warning naming the instance.

### An imported output that is an empty string, or not a string, is now refused

`cloudflare-api`'s `resolveRef` — the reviewed one, used for every Cloudflare
credential — has always required a non-empty string. `cloudflare`'s
`workerVars`/`workerSecrets`/`r2Bindings` and `cloudflare-email`'s
`workerName` accepted an empty one, and `fly`'s `flySecrets` accepted anything
at all and ran it through `String()`.
They now all use the strict reading: an output that is `''`, a number, or a
boolean fails by name instead of reaching a provider as an empty credential or
the text `"true"`.

**If you reference an output whose empty value is meaningful** — the `fly`
module's `ipv4`/`ipv6` are `''` when no address is allocated — that reference
now fails. No instance in this repo does. A module that genuinely wants the
empty answer asks for it: `ctx.output(ref, field, { allowBlank: true })`, which
is what `provision-core`'s `volatileEnvFrom` does, since "nothing to mint" is a
real answer there.

### Copy-mode repos: `zbc add` now backfills missing `packages/infra/src/` files

Three modules — `fly`, `cloudflare-api` and `provision-core` — now import
`../../src/context`, a file that did not exist before this release. In a
copy-mode repo `packages/infra/src/` is written once, by `zbc init`, so a repo
scaffolded on an older CLI has whatever `src/` shipped *then*, and `zbc add fly`
would have installed a module importing a file that is not in the tree.

`zbc add` now copies any missing engine file into `packages/infra/src/` before
installing a module, skipping every file you already have. **If you already ran
`zbc add` on 0.14.0 and got an unresolvable `../../src/context` import, re-run
the same `zbc add` and it will be written.** Subtree consumers were never
affected — `zbc update` refreshes `vendor/zbc/src` wholesale.

### `ApplyContext` gained `secret()` and `output()`; the three fields are unchanged

`secrets`, `imports` and `projectRoot` are still there and still mean what they
meant. One reading changed with them: a secrets.yaml key written `KEY:` with
nothing after it parses to `null`, and `ctx.secret` now treats that as the blank
placeholder it looks like (accepted under `allowBlank`, refused as empty
otherwise) rather than as a `null` handed to a module expecting a string. A custom module reading them directly keeps working. The two methods are
where the rules now live — "what is this secret", "what did the instance I
imported emit" — and a module that adopts them gets the engine's messages
instead of its own. `defineModule` supplies them, so a module body may assume
they exist whoever called `apply`.

## 0.13.0

### `WALGIT_PUBLIC` opens the host for `true`, not only for `1` — this widens access

**If your walgit deployment sets `WALGIT_PUBLIC` to anything other than `1`,
check it before upgrading.** A value of `true` previously left the host
token-gated; after this release it opens the host — reads, writes and ref-event
subscriptions all serve anyone, with no credential.

The variable was read three different ways. `/llms.txt`'s access claim used
`flagEnabled`, which accepts `1` **or** `true`; the ref-event socket and the
container's git auth each tested `=== '1'`. So a deployment spelling it `true`
published a manual telling agents that reads and writes need no credential,
while every clone, push and subscribe answered 401. All three now read one
`caps.publicAccess`, derived once in `shared/capabilities.ts`.

That is the correct reading of the operator's intent — they asked for public and
got a closed host lying about itself — but it is a widening, so it ships named
rather than silently.

What each value does now:

| `WALGIT_PUBLIC`                     | before                                     | after              |
| ----------------------------------- | ------------------------------------------ | ------------------ |
| `1`                                 | open                                       | open (unchanged)   |
| `true`                              | **closed**, while `/llms.txt` claimed open | **open**           |
| unset                               | closed                                     | closed (unchanged) |
| anything else (`yes`, `on`, `TRUE`) | closed                                     | closed (unchanged) |

The widening covers `true` only. The accepted vocabulary is unchanged — it is
still exactly what `flagEnabled` has always taken — so an unrecognised value
still reads as a token-gated host.

Unaffected if you set `WALGIT_PUBLIC=1`, leave it unset, or do not run walgit.

**Fail-closed is unchanged.** Public access is still an explicit opt-in and not
the absence of tokens: with neither tokens nor public configured the container
still refuses to boot, so a deployment that loses its secrets fails closed
instead of opening to the world.

### walgit's ref-event stream now needs both halves configured — this narrows

**If your walgit deployment sets `WALGIT_EVENTS_TOKEN` without
`WALGIT_EVENTS_URL`, the ref-event stream stops being served.** The socket path
was previously claimed on the token alone; it is now claimed on the same
`caps.events` the documents advertise from, which requires both.

That configuration never worked: the token is what claims the socket at the
edge, and the URL is where the container's `post-receive` announces. With only
the token a subscriber connected, was handed current refs, and then waited
forever, because the push path had nowhere to announce to. It now 404s instead,
and `/llms.txt` and the landing page stop offering a stream — which is the same
failure, said out loud, before an agent writes a client against it.

Set `WALGIT_EVENTS_URL` as well to keep the stream. Unaffected if you set both
(as this repo's own `agentgit` deployment does) or neither.
