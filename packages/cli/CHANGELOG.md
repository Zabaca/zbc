# @zabaca/zbc

Notes for releases that change behaviour a consumer depends on. Releases that
only add or fix things are described by their `release(cli): @zabaca/zbc <x.y.z>`
commit message and the PRs it names; this file exists for the ones a consumer
has to read before upgrading.

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

| `WALGIT_PUBLIC` | before | after |
| --- | --- | --- |
| `1` | open | open (unchanged) |
| `true` | **closed**, while `/llms.txt` claimed open | **open** |
| unset | closed | closed (unchanged) |
| anything else (`yes`, `on`, `TRUE`) | closed | closed (unchanged) |

The widening covers `true` only. The accepted vocabulary is unchanged — it is
still exactly what `flagEnabled` has always taken — so an unrecognised value
still reads as a token-gated host.

Unaffected if you set `WALGIT_PUBLIC=1`, leave it unset, or do not run walgit.

**Fail-closed is unchanged.** Public access is still an explicit opt-in and not
the absence of tokens: with neither tokens nor public configured the container
still refuses to boot, so a deployment that loses its secrets fails closed
instead of opening to the world.
