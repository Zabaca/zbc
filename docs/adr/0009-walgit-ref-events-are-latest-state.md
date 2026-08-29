# walgit's ref events are latest-state, not a replayable log

**Status:** accepted (2026-08-29), shipped in #71–#77. Extends [ADR-0007](./0007-walgit-object-storage-holds-the-log.md) — `index.json` stays the source of truth and gains nothing; extends [ADR-0008](./0008-walgit-runs-on-a-cloudflare-container-without-ssh.md) — the endpoint lives in the Worker, in front of the container, and is the second thing after the expiry sweep to do so.

walgit notifies subscribers that a ref moved by sending **the current sha for the refs they watch**, and never by replaying a history of ref changes. There is no cursor, no `since`, and no sequence number on the wire. A subscriber that reconnects is told current state in the handshake; whatever it missed while disconnected is not merely dropped but never existed as an event to drop.

## Why the obvious cursor is the wrong one

The write-ahead log already carries a monotonic `seq`, and the first design sketch used it: reconnect with `since: 41`, receive exactly what was missed. It does not work, in both directions:

- **A ref can move without `seq` moving.** A ref-only push — a branch pointed at objects the repository already has, a delete, a fast-forward needing no new pack — appends no WAL entry and bumps no sequence number (`src/push.ts`, and the comment there says why: keeping `seq` contiguous with `entries` is what lets a restore trust `entries` by itself). A `seq` cursor is therefore blind to a whole class of ref change.
- **`seq` can move without any ref moving.** A compaction publishes a `kind: 'compaction'` entry and advances `seq` while touching no ref at all. A `seq` cursor would wake every subscriber for a background repack.

Fixing this means a second counter in `index.json`, bumped on every ref change and on nothing else, plus retention of the events it numbers. That is a new field, a new invariant, and a new thing for compaction and gc to reason about — all to deliver intermediate shas to a consumer that discards them.

## Why latest-state is not a lesser version of the same thing

The consumer is a daemon that fetches. The only question it ever asks is *am I current*, and the only useful answer is *here is the sha now*. Intermediate values between two pushes have no reader. So:

- **The handshake answers the question before any event fires.** A subscriber sends its watch list and is told current state immediately, which makes connect and catch-up the same operation. The subscription is recorded *before* that state is read, so a push landing during the read reaches the socket as an event rather than falling between the two — and the read is bracketed so its snapshot can never install over an event already sent.
- **Backpressure stops being a policy decision.** Coalescing per `(repo, ref)` is the semantics rather than a mitigation, so a backlog can only mean a dead socket — and closing one is safe precisely because reconnect replays current state. No history is owed to anyone.
- **Nothing new is persisted.** The alternative's cursor is only free if you do not look at it; this one is free because it does not exist.

## Shape

- **One global events Durable Object** holds every socket and the watched ref state. Not one per repository: a hibernatable WebSocket lives in exactly one Durable Object, so a single connection watching several repositories cannot sit in a per-repository object. Per-repository objects with a per-connection relay remain possible later without a client-visible change, which is what makes one object safe to start with.
- **The DO caches refs; the container remains authoritative.** The Worker has no R2 binding — the container holds the only credentials to the log, deliberately — so the DO answers from its own storage when it can and asks the container over the internal path when it cannot. Ref state is never *owned* by Durable Object storage: that would be a database beside the log, and it would cost a repository restorable from the bucket alone, an operator CLI that reads the bucket from outside Cloudflare entirely, and survival of the data past the Worker. That value has already been banked once, when `git.zabaca.com` was retired and its bucket kept.
- **The container announces, from `post-receive`, in a detached process.** After the compare-and-swap has won and the push is durable — never from `reference-transaction`, which would announce a push that then loses the CAS. Detached (`src/announce-main.ts`) because `post-receive` holds the client's connection until it exits: awaiting a fan-out that is slow or unreachable would bill the pusher for it, on the one path this project keeps fast. It reaches the Worker at `/_walgit/announce` with `WALGIT_EVENTS_TOKEN`, forwarded via `shared/container-env.ts` like every other container variable: `INTERNAL_REQUEST_HEADER` cannot serve here, because the Worker strips it from every inbound request, and that guarantee runs Worker → container only.
- **Subscribing needs exactly the credential a read needs.** If you can fetch it you can watch it; a public deployment has a public stream. Push timing on a world-readable repository is already discoverable by polling, and a second credential system is a second thing to get wrong.
- **Off unless configured.** The presence of `WALGIT_EVENTS_TOKEN` is the switch — no separate on/off flag, since a stream with no credential for its announce path could not work anyway. Same posture as `WALGIT_RETENTION_HOURS` and the size caps: an instance that does not serve it never mentions it. Both `/` surfaces — `shared/landing.ts` and `src/instructions.ts` — render that paragraph from the same policy, because a page promising a socket the deployment does not serve is ZBC-XR87OB in a new spot.

## The wire, frozen

```
→ {"watch":[{"repo":"my-thing","refs":["refs/heads/main"]}]}
← {"ok":true,"refs":[{"repo":"my-thing","ref":"refs/heads/main","sha":"9f2c…"}]}
← {"repo":"my-thing","ref":"refs/heads/main","sha":"0ab7…"}
← {"repo":"my-thing","ref":"refs/heads/main","sha":null}      # ref deleted
```

`refs` omitted in a watch entry means every ref in that repository. `sha: null` is a deletion, which an append-only deployment never emits but the mechanism must be able to express. There is no `seq` field anywhere on the wire, so no client can build a cursor walgit does not honour — the omission is the decision, not an oversight.

## Consequences

- **A client cannot audit history over this channel.** Anything wanting every intermediate sha must read the log, which is what the log is for. This is the accepted cost and the reason the ADR exists.
- **A cold subscribe may wake the container.** Once per machine per boot, for the ref state the DO does not yet hold. Giving the Worker a read-only R2 binding would remove it, and stays available as a fallback — at the price of downgrading "one process holds the log's credentials" from a structural property to a policy one, since R2 bindings have no read-only form.
- **64 repositories per connection (256 refs each), no wildcard.** Exceeding it is refused with the cap and the count named, because refusing things with an explanation is the product. A machine needing more opens a second socket, which is honest about the cost. A wildcard on a public deployment would be a firehose of strangers' pushes.
- **The `WalgitEvents` Durable Object class ships in the app template.** It is host protocol, not product, so every walgit consumer gets it — inert unless `WALGIT_EVENTS` is set. The migration tag that introduces it is permanent and cannot be un-shipped, which is the one irreversible part of this and the reason the class belongs to walgit rather than to one deployment of it.
- **The client is a snippet, not a daemon.** The first design note called a host daemon "the endgame" — one socket per machine, fetching into a shared object store. Spiked against the live service, the protocol turns out to need no client machinery at all: no cursor, no state file, no keepalive. Four regimes were measured — fresh connect (handshake, then fetch, 636 ms), a live push (event to fetch, 947 ms), a push that landed while the client was DOWN (restart, handshake, fetch, 841 ms), and a socket idle for 5 min 44 s (event delivered, no keepalive) — and every fetch landed on exactly the sha the event named. What is left is small enough to paste into `GET /`, which is where it now lives, and an agent backgrounds it itself. A daemon becomes worth building only if socket-per-agent sharing hurts: ten agents on one machine hold ten sockets and fetch the same objects ten times. Cheap until it isn't, and unmeasured until someone runs into it.
- **There is no second door, and that is deliberate.** A `curl`-only fallback was designed and then deferred: the cost this feature removes is a tool call and context, not bandwidth, and a shell loop is one tool call whether it long-polls or short-polls — so the fallback's headline benefit largely evaporates against the audience it was drawn for. An agent with a shell can usually open a socket from a script; the genuine no-socket audience is "curl and nothing else", and no such client has asked yet. If one does, the fan-out already exists and the addition is small — and it should be **SSE** (one plain GET, no upgrade, no timeout to tune, reaches through proxies that block WebSocket) rather than a long poll, with a one-shot blocking call added only if CI wants "block until it moves, then exit". Building either now would mean guessing the audience and freezing a second wire format, which is the part that cannot be taken back.
- **The reserved namespace is safe by construction.** `repo.ts` requires a leading alphanumeric in a repository name, so the `/_walgit/*` namespace the endpoints live in (`/_walgit/events`, `/_walgit/announce`) is unclaimable.
