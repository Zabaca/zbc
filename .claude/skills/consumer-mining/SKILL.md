---
name: consumer-mining
description: Mine zbc's consumer repos for what the next module should be and how the existing ones should change. Reads every consumer listed in docs/consumers/registry.json, strips the copies of our own old code, and writes one case file per module — the capability someone had to build themselves, the code that proves it, and what it would take upstream. Use when deciding what to build next in packages/cli/templates/infra/modules/, when a module keeps getting worked around, or when asked what consumers need from zbc.
user-invocable: true
---

Consumers write zbc's roadmap without meaning to. Every module in a consumer's
`packages/infra/modules/` is a built-in that did not exist; every edit to a
vendored one is a built-in that did not do the job; every `wrangler` call in a
shell script is a thing `defineModule` could not express. This reads that
record and turns it into per-module cases.

**The deliverable is per module, not per repo.** Repos are where evidence
lives; nobody acts on "here is what leeandco does". They act on "here is what
`cloudflare-zone` is missing, from four independent implementations".

## The mistake this exists to prevent

A copy-mode consumer's `cloudflare` is hundreds of diff-lines from ours. Almost
none of that is their idea — it is **our own module, frozen at whatever `zbc
add` copied**. Diff against `main` and every stale copy looks like a deep well
of consumer insight, and a review built on it reads our own history back to us
as feedback.

So the collector hashes each consumer module against **every historical
revision** of the template of the same name. Verbatim match at any revision →
`stale`, dropped, no case, no zbc change. On the first three repos surveyed
that alone dropped `stiqr/cloudflare` and `leeandco/cloudflare` — the two
loudest "forks" — while keeping `crux/cloudflare`, which is genuinely edited.

Matching is done twice: on the file, and on a **normalised** form with quote
style, trailing punctuation, indentation and blank lines stripped. A consumer
running prettier against our biome produces a file that differs on every line
and means nothing by any of it — crux's `cloudflare` scored 0.538 similarity
with zero real edits. Such a match reports `formattingOnly: true` and is still
dropped. Comments are deliberately *not* stripped: a consumer's comment is
frequently the finding — ceo's `cloudflare` carries two production incidents in
its comment blocks.

Never diff a consumer module against `main` by hand, and never read a raw diff
as evidence of divergence without checking whether a formatter explains it.
Those are the two ways to reach a confidently wrong answer here.

## Run it

```bash
bun scripts/consumer-survey.ts            # every consumer in the registry
bun scripts/consumer-survey.ts crux ceo   # or named ones, while iterating
```

Writes to `.consumer-survey/` (gitignored): `<id>.json` per consumer, plus
`index.json` — the same findings regrouped by module name, which is the shape
the rest of this works from. GitHub consumers are cloned shallow; the two with
no remote are read over ssh, straight off the machine named in the registry.

Each module carries a verdict:

| Verdict | Meaning | Worth a case? |
|---|---|---|
| `current` | verbatim copy of our newest revision | no — nothing to learn, nothing to fix |
| `stale` | verbatim copy of an *older* revision of ours | no — they need an upgrade, we need nothing |
| `divergent` | our module, edited | **yes** — the edit is a patch already written against our interface |
| `novel` | no built-in of that name has ever existed | **yes** — a resource we have no module for |

## Fan out, one agent per consumer

Only for consumers whose survey has material — `divergent`, `novel`, or escape
hatches. Give each agent its own `.consumer-survey/<id>.json` and this brief:

> Read `.consumer-survey/<id>.json`. The checkout is at
> `.consumer-survey/repos/<id>/`. For each module with verdict `divergent` or
> `novel`, and for the escape hatches, report what capability the consumer
> needed and what evidence proves it. Do not propose zbc changes and do not
> compare against other consumers — you cannot see them. Report only what this
> repo shows.

For a `divergent` module, the agent diffs against the revision the consumer
actually forked, never against `main`:

```bash
git show <nearestRev>:packages/cli/templates/infra/modules/<name>/index.ts > /tmp/base.ts
diff /tmp/base.ts .consumer-survey/repos/<id>/<path>
```

**Check which side is older before you read the diff as a fork.** `divergent`
assumes the consumer edited our module. That is false when ours is the younger
one — `cloudflare-access` entered the templates on 2026-08-19 by promoting
foundry's version, and leeandco's copy already existed. Its `nearestRev` is
then not a fork point at all, and diffing against it presents two independent
implementations as one deriving from the other. Every finding carries
`upstreamFirstSeen`; when it postdates the consumer's work, the diff is a
**convergence comparison** — where they agree is the interface — and the low
similarity is mostly upstream having moved on since.

**Then check the finding against current upstream, not just against the fork
point.** A consumer's divergence is real by construction — they edited our code
— but their *reason* for it can be as stale as the code they forked. leeandco's
`cloudflare-token` gave three reasons; one of them, a permission-group name
collision that mints a token which authenticates and then 403s, had already
been fixed on `main` **and fixed more completely than their version**, from the
same incident hit independently. Reporting that as a gap would have been a
patch applied backwards.

So for every `divergent` finding: grep current `main` for the thing they say is
missing before calling it missing. The verdict says their code differs; only
`main` says whether we still lack the capability.

Fixed report schema per finding, so the synthesis step can merge them:

- **capability** — one line, what the consumer can do that zbc cannot
- **evidence** — file:line in their repo, plus the config keys involved
- **why the built-in fell short** — from the diff, not from guessing, and
  confirmed still true on current `main`
- **deployed?** — is it wired into an instance in a `production` environment,
  or does it sit unapplied? Production means evidence; unapplied means opinion.

## Synthesise per module

One pass over all the reports, grouped by module name. This step is the only
one that can see across consumers, and convergence is the thing it is for:

- where independent implementations **agree** — that is the interface
- where they **disagree** — that is the config surface
- where only one went — that is either a real edge case or one project's quirk,
  and saying which is the judgment call this whole exercise is buying

`index.json` already lists each implementation's `configKeys` and `outputKeys`;
start from that table rather than re-reading every file.

Weight the evidence:

1. **independence** — implementations written without seeing each other beat
   copy-paste siblings. Identical files across two repos are one data point
   about the interface, even while being two about the need.
2. **production** — wired into a `production` instance beats an unapplied file.
3. **count** — a ranking signal, never a gate. One `vercel` is a fine case; five
   copies of a Zabaca-operational thing is still not one.

## Write the cases

One file per module at `docs/consumers/cases/<module>.md`, overwritten each run
— the cases are derived, and `.consumer-survey/` holds the evidence they came
from:

```markdown
# <module> — <new | upgrade>

**Consumers:** <ids>  ·  **Deployed in production by:** <ids>

## What they needed
<the capability, one paragraph>

## The interface, from N implementations
<keys everyone chose | keys only some chose, with who>

## What it takes upstream
<concrete change to packages/cli/templates/infra/modules/…, or a new module>

## Evidence
<file:line per consumer, and the nearestRev each divergent one forked from>
```

Then a rollup at `docs/consumers/cases/README.md`: every case, one line each,
ordered by consumer count, `new` and `upgrade` split apart.

## Where this stops

It produces cases, not commits. Deciding which to build — and whether a
capability belongs upstream at all, given zbc ships to companies that are not
Zabaca — is a human call made against `CLAUDE.md`'s bar. A case that argues its
own promotion has overstepped; it should make the need legible enough that the
call is easy.

Registry maintenance is manual: a new consumer means a new entry in
`docs/consumers/registry.json`. The collector will not discover one on its own,
by design — `access` and `tier` are facts no script can derive.
