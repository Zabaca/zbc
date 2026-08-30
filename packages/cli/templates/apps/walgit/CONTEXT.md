# walgit

A git host where object storage holds the write-ahead log and is the source of truth, and the bare repo on local disk is a disposable cache (ADR-0007 in the zbc repository, `docs/adr/`). Every term below is a consequence of that sentence, and each names a file under `src/`. It serves git smart-HTTP — the only transport — from a Cloudflare Container behind a thin Worker (ADR-0008 there too).

One context of several in the zbc repository — see its root `CONTEXT-MAP.md`. This glossary travels with the package, so a consumer who runs `zbc add walgit` gets the vocabulary along with the code.

**walgit is the mechanism, not a product.** A deployment of it may be a product — agentgit is one — but the rule in both directions is: *walgit may gain capabilities, never opinions*. Anything specific to one deployment must be expressible as instance configuration, or it does not belong in this package. Every capability here defaults to off.

## Language

**Shared Kernel** (`shared/`):
The runtime-neutral third directory beside `src/` (the container process) and `worker/` (the Cloudflare Worker). Its rule is one sentence — *`shared/` imports no runtime, and both halves may import it* — and it is enforced rather than asserted: `shared/` is the only directory in both TypeScript programs, so a module there is typechecked against bun's ambient types and against the Workers runtime's (ADR-0010). It holds what both halves have to agree on exactly: the wire contract (`protocol.ts`), credential reading, limit reading and formatting, and the ref-event, telemetry and landing-page logic.
_Avoid_: common, util, lib — none of them says why a module qualifies

**Write-Ahead Log** (the WAL):
The ordered sequence of packfiles under `repos/<repo_id>/wal/`, and the source of truth for a repository. A push is not acknowledged until its entry is published to it. Object storage, not a filesystem and not a database — swappable through one adapter (`store.ts`).
_Avoid_: the bucket (names the backend, not the log), the archive

**Index**:
`index.json` — one object per repository carrying the sequence number, every WAL Entry, the **full ref state**, the Compaction Frontier and outstanding Tombstones. Refs live here rather than in a relational store, which is the point: there is no database to operate. Publishing a push means winning a conditional PUT on this object.
_Avoid_: the manifest, the metadata, the database

**WAL Entry**:
One packfile published to the log, by one push or by one compaction, identified by a monotonic `seq` and content-addressed by its sha256. Uploading a pack does not make it an entry — only the Index naming it does.

**Cache**:
The bare git repo on local disk. Disposable by definition: it can be deleted at any moment and rebuilt from the log, it is reconciled against the Index on every access, and nothing may be served from it that the log has not confirmed. Provisioned by `cache.ts`; git's own housekeeping is disabled on it, because a cache that repacks itself behind the log's back is a cache that disagrees with it.
_Avoid_: the repo (ambiguous with the repository the log describes), the replica, local state

**Reconcile**:
Force the Cache's refs to match the Index. Always one-directional — whatever the disk believes is discarded — and written as a single `packed-refs` file. A ref whose object is absent is reported rather than written: a stale clone is survivable, a broken one is not.

**Materialize** (walgit sense):
Rebuild a Cache from the Write-Ahead Log: download every WAL Entry above the Compaction Frontier, place its pack, then Reconcile. The container sleeps when idle and its disk is wiped on restart, so this is the normal path on ordinary first access after an idle pause, not disaster recovery.
_Disambiguate_: the zbc repository's warehouse uses the same word for a `dlt` extract plus `dbt run`. The two are unrelated; a bare "materialize" is ambiguous across that repo.

**Compaction**:
Repack a repository into a single WAL Entry that supersedes everything at or below the sequence number it started from, so a cold Materialize replays one entry however many pushes the repository has taken. A repack, never a rewrite: the history it encodes is identical, object for object, and refs are never touched.

**Compaction Frontier**:
The sequence number at or below which entries are superseded and no longer needed to restore. Materialize downloads from it forward; it only ever advances.

**Lease**:
The per-repository claim a node takes before compacting, so two nodes cannot both repack and both advance the frontier. It expires, because its holder is a process in a container the platform may stop at any moment — a lease only a graceful release could clear would wedge compaction for a repository permanently.

**Tombstone**:
A superseded WAL object recorded in the Index as scheduled for deletion, with the instant before which it must not be deleted. The delay is the whole mechanism: a compaction's compare-and-swap is instantaneous and a restore that read the Index a moment earlier is not.

**Orphan**:
A WAL object under a repository's prefix that the Index does not name — almost always a pack uploaded by a push that then lost the compare-and-swap, since rejecting at `reference-transaction` does not unwind the upload. Discovered by diffing the prefix against the Index rather than recorded at rejection time, and collected only once provably older than the slowest plausible restore.
_Avoid_: garbage (says nothing about why it is there), leaked object

## Provenance (ADR-0011)

**Signer**:
The key that signed a push, named by its fingerprint. Not a user and not an account — neither exists here. Established by verifying the push certificate git sends with `push --signed`, which is a `receive-pack` capability rather than an SSH one and works over smart-HTTP like everything else.
_Avoid_: user, account, identity (each implies a registry this host does not have)

**Provenance**:
The recorded fact that a Signer pushed a given ref update. Latest-state per ref in the Index, written by the same compare-and-swap that publishes the push — not hung off a WAL Entry, because a ref-only push appends none, and not left on disk, because the certificate arrives as a blob in the Cache and the Cache is wiped on restart.
_Avoid_: audit log (there is no history here; the history of content is the commit graph)

**Claim** (not built):
Reserved for the trust-on-first-use assertion that a Signer owns a repository, if ownership is ever added. Deliberately not "owner", which implies a permission system rather than a first-mover fact.

## Ref events (ADR-0009)

**Ref Event**:
A message telling a subscriber that a watched ref is now at a given sha. Latest-state, never a replayed history: there is no cursor, no `since`, and no sequence number on the wire. A deletion is the same message with a null sha.
_Avoid_: notification (implies delivery to an endpoint, which is exactly what this is not), webhook

**Watch**:
A subscriber's declared interest — a repository, optionally narrowed to named refs. Omitting the refs means every ref in that repository. Capped per connection at 64 repositories and 256 refs each, with no wildcard across repositories.

**Handshake**:
The first exchange on a subscription, in which the subscriber is told current state for everything it watches. It is what makes connect and catch-up one operation, and what makes a dropped socket cost nothing but the reconnect.

**Fan-out**:
The `WalgitEvents` Durable Object holding every subscriber's socket and the ref state those subscriptions need. One globally, not one per repository: a hibernatable socket lives in exactly one Durable Object. It holds a derived cache and asks the container when it does not know — the Index remains the source of truth and gains no field for this.
_Avoid_: the hub, the broker

**Announce**:
The container telling the Fan-out that refs moved, over `/_walgit/announce`, from `post-receive` — after the compare-and-swap has won and the push is durable, never from `reference-transaction`, which would announce a push that then loses. Authenticated, off the push's latency path, and never able to fail a push.

**Coalesce Window**:
The 250 ms in which one socket gets at most one message for a given repository and ref. A second move inside it REPLACES the queued message rather than joining it, so what a subscriber receives when the window elapses is the newest sha, once. It is a rate bound and not a reaction to a slow reader: the Workers runtime reports no backlog for a socket (no `bufferedAmount`), so there is nothing to react to. Sound only because a Ref Event is latest-state.
_Avoid_: backpressure, throttling, debounce (each implies a reader being watched, or a message being dropped rather than superseded)

## Provenance (ADR-0011)

**Push Certificate**:
The small signed document a `git push --signed` carries: the pusher's claimed key, the pushee, the nonce this host issued, and every ref the push moves — with an SSH signature over all of it. A `receive-pack` capability, not a transport one, which is why it works with no SSH anywhere. Advertised if and only if the receiving repository has `receive.certNonceSeed`, so that one config key is the whole of "this deployment takes signed pushes".
_Avoid_: the signature (the certificate is the document; the signature is one field of it), the token

**Signer**:
The key that signed a push, named by its fingerprint (`SHA256:…`). A key, never a user or an account — neither exists here, and either word would imply a registry walgit deliberately does not have.
_Avoid_: user, account, identity, owner (the last is reserved for a permission system that does not exist)

**Provenance**:
The recorded fact that a Signer moved a given ref — an optional map in the Index, ref → `{ signer, ts }`, written by the same compare-and-swap that publishes the push. Latest-state per ref like everything else here: there is no provenance history, because the audit trail of *content* is the commit graph.
_Avoid_: identity, attribution log, audit trail

**Provenance Read**:
`GET /_walgit/provenance?repo=<id>` — the whole of reading Provenance back: one repository, the Index's map as it stands, `{}` when nothing has been signed. Behind exactly the credential a clone of that repository needs, so a public deployment answers anyone and a token-gated one answers nobody else; there is no second authorization model. Deliberately not a Ref Event — that wire is latest-state and says only that a ref moved and to what (ADR-0009), while Provenance has a different lifetime and a different reader.
_Avoid_: the provenance API, the audit endpoint

**Fail open**:
The rule the whole capability is built to: a missing, malformed or unverifiable certificate, a bad nonce, or a verifier that is absent or throws records no Signer and **accepts the push**. Provenance is metadata and must never become a new way for a push to fail — anonymous pushing is first-class and stays that way.
