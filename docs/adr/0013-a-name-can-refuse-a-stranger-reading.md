# A name can refuse a stranger reading

**Status:** proposed (2026-09-12). Builds on [ADR-0012](./0012-a-name-can-refuse-a-stranger.md), whose closing consequence — "this ADR must not be read as a step toward private repositories" — this one revises: it was the step, and this is the next. Extends [ADR-0011](./0011-walgit-records-who-pushed-and-refuses-nothing.md): the same key, the same verifier, one more thing done with the answer. Extends [ADR-0008](./0008-walgit-runs-on-a-cloudflare-container-without-ssh.md): smart-HTTP remains the only transport, which is the whole difficulty here.

A claimed repository may carry a **Reader List** — key fingerprints in a file called `readers`, beside `signers`, on the same `refs/walgit/signers` commit chain. While the file exists the repository is **Private**: every read is refused unless the reader proves, by signature, a key that is listed or a Signer. While it does not — every repository until someone writes one — nothing changes.

Accounts still do not exist. Tokens still do not exist. Anonymous pushing to an unclaimed name is untouched.

## Why now and not before

The landing page has said since ownership was designed: _there is nobody to be private from until a name has an owner_. ADR-0012 gave a name a Signer List; this ADR spends it. The order was forced: a Reader List on a name anyone can write to protects nothing, because the next stranger's push can add themselves to it. So privacy requires a Signer List, and a Reader List on an unclaimed name is refused as an unreadable list — the same sentence, the same place.

## The mechanism is the same ref

The Reader List is a second file in the tree the Signer List already lives in, so everything ADR-0012 bought applies unchanged: writing it is a signed push judged by the Signer List that stood before it, the Index carries a derived copy beside the signers (`claim.readers`), a restore replays both, and reading it is a clone. No new ref, no new endpoint, no second authorization model for writes.

Same format and same parser — one fingerprint per line, blank and `#` ignored, a bad line fails the file, same size cap, unreadable refused. One difference, on purpose: **an empty Reader List is valid.** An empty Signer List is refused because it hands the name to the next stranger; an empty Reader List loses nothing, because Signers read without being listed. It is the spelling of "private, and only I read it" — the shape most agents will write.

**Presence is the switch.** There is no `private` marker, no per-repository flag, and no third state. A repository is Private if the file exists and world-readable if it does not, so absence keeps one spelling in the Index and on the wire, exactly as Unclaimed does. Going back is a commit that removes the file. Nothing is retroactive: a clone taken while the name was world-readable is a clone, and walgit says so rather than pretending otherwise.

## What is gated

Every read, behind one gate: clone and fetch (`info/refs` and `upload-pack`), the Provenance Read, and a Watch on the event stream. ADR-0011 put the Provenance Read behind "exactly the credential a clone needs" and ADR-0009 made an event a strict subset of a fetch; gating any of the three differently would create the second model both refused. A Watch that names a Private repository the presented key cannot read is refused whole, not silently narrowed — a subscriber left waiting on a repository it will never hear from is the worse failure. When a Reader List changes, the container's Announce says so, and the Fan-out closes the sockets that were reading on the strength of the old one: a socket that outlives a revocation is a leak.

## The Read Challenge

This is the hard part, and it is git's asymmetry rather than ours. `git push --signed` is a `receive-pack` capability: git builds the certificate, signs it with `user.signingkey`, and the hook sees it. `upload-pack` has nothing of the kind — no fetch ever invokes a signing key. Over SSH the transport carries identity; walgit has no SSH. Over HTTP git's only identity is the `Authorization` header a credential helper fills in.

So the key is proved the way git leaves room for:

- the host publishes a **nonce** — `HMAC(seed, floor(now / 300 s))`, accepted for the current and previous window, so there is no nonce state anywhere and a captured signature is good for at most ten minutes;
- the client signs it — `ssh-keygen -Y sign -n walgit-read` with the same key that signs its pushes — and presents fingerprint and signature as Basic username and password, which `presentedCredential` already parses;
- the host verifies with `ssh-keygen -Y check-novalidate -n walgit-read`, the verifier ADR-0011 chose because it needs no registry, and looks the fingerprint up.

**Its own namespace.** `walgit-read` rather than `git`, so a Read Challenge signature can never be replayed as a Push Certificate, and never as an SSH authentication — the property ADR-0011 relied on in the other direction.

**Verified in the container, everywhere.** The Worker gates event subscriptions and cannot spawn a subprocess; rather than a second verifier — an SSH signature parser over WebCrypto that would have to agree with `ssh-keygen` forever — the Worker forwards the presented credential to an internal container route and acts on the verdict, the way the Fan-out already asks the container for refs. Subscribing to a Private repository wakes the container; so would fetching it.

**The nonce is fetched, not forwarded.** The 401 carries `WWW-Authenticate: walgit-ssh nonce=…` because that is what the header is for, but the helper does not depend on git handing it over: only git ≥ 2.42 forwards `wwwauth[]`, and a version cut-off an agent cannot see is a footgun. The helper fetches `GET /_walgit/challenge` itself — one round trip, one nonce for every repository on that host.

**The client is a credential helper**, shipped in `@zabaca/agentgit` and configured once per machine:

```
git config --global credential.https://agentgit.zabaca.com.helper '!agentgit credential'
```

After that `git clone`, `git fetch`, `git push` and `agentgit watch` need nothing typed. The helper ignores `store` and `erase` — there is nothing to store — and a cached stale signature costs one extra 401 and a re-sign, not a failure.

**Why not a token.** A repository-scoped bearer token, hashed into the same tree, would let a bare `git clone https://token@…` work with no helper. It was rejected because a token is a secret: something to store, leak, rotate and revoke by rewriting, and the front door's first line — no account, no token, no key — would become false at the exact moment the service started keeping things worth stealing. The helper is forty lines and one config line; the token is a second identity system.

## How it is turned on

`WALGIT_PRIVATE_REPOS`, and it is a seed rather than a boolean — the nonce needs one, and ADR-0011 already established that the seed IS the capability. Requires `WALGIT_SIGNER_LISTS`; off in the package. It does not ride the signer-list flag for the reason ADR-0012 gave against riding the certificate seed: a deployment that turned on ownership must not acquire read gating as a side effect.

**Existence is not hidden.** An unauthenticated read of a Private repository answers 401 with the challenge, which says the name exists and is Private. Answering 404 would hide it and break every helper that keys on 401. The name stopped being the secret worth protecting when ownership landed.

**Discovery is `/llms.txt`, the landing page and the 401 body**, which names the helper and the config line. `GET /` renders three bytes under its budget and does not take this; the failure lands on our server, in our words, at the moment it is relevant. It is one more field on `Capabilities` (`shared/capabilities.ts`) — `namesCanBePrivate`, true only with this seed AND `namesCanBeClaimed` — so every document renders it from the same place, and the landing page's "Private" row, which today says holding a name is not a step toward closing it, is rendered from that field rather than rewritten by hand.

## Boundary

The mechanism ships in the walgit app template, off. Turning it on for agentgit is instance configuration and a separate ticket; when it lands, the landing page's "Private" roadmap row becomes a rule beside Append-only and Public. _Capabilities, never opinions._

## Consequences

- **Privacy is a promise, and that is the one-way door.** Once agentgit says a Private repository is unreadable by strangers, weakening the gate is a breach rather than a change. The mechanism is small; the commitment is not.
- **An agent with no key and no helper cannot read a Private repository**, and the 401 says exactly what to run. This is the same population ADR-0011 named — keyless cloud agents — and the same answer: a harness that mints a stable key per agent.
- **A revoked reader keeps their clone.** Git has no way to reach into a working tree, and walgit does not pretend to.
- **Every read of a Private repository costs a signature verification** — a subprocess, on the container, bounded by the same caps as a signed push. Fetches on world-readable repositories pay nothing new.
- **`ssh-keygen` is now on both sides of the wire.** The client needs it to sign; it was already needed for `git push --signed`, so nothing new is installed.
- **Nothing here is retroactive**, in either direction: going Private does not recall a clone, and going world-readable does not re-publish anything that was not already pushed.

## Vocabulary

**Reader List** — the fingerprints a repository lets read it, in `readers` beside `signers`. **Private** — a repository whose tree holds one; its opposite is world-readable, never "public", which names a Deployment that asks no token. **Read Challenge** — the nonce-and-signature exchange by which a reader proves a key over a transport that signs nothing on fetch.
