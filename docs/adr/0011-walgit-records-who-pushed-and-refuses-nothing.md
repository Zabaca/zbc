# walgit records who pushed, and refuses nothing

**Status:** accepted (2026-08-30). Extends [ADR-0008](./0008-walgit-runs-on-a-cloudflare-container-without-ssh.md) — smart-HTTP remains the only transport, and this needs no other. Does not touch [ADR-0009](./0009-walgit-ref-events-are-latest-state.md): the event wire is unchanged, deliberately.

walgit can **verify who pushed** and **record it**, and does nothing else with the answer. A push signed with a key is attributed to that key's fingerprint; an unsigned push is accepted exactly as it is today and always will be. Nothing is refused, gated, owned or made private by this decision.

The next decision — trust-on-first-use ownership — is expected, and this one is shaped so as not to foreclose it. It is not taken here.

## Why record anything at all

The three things people want from identity on a host like this are private repositories, ownership of a name, and abuse control. All three need to know who is pushing; none of them are worth having before that question can be answered at all. So this ADR buys the answer and spends none of it: the cheapest rung, the only one that breaks no existing promise, and the one that produces evidence for whether the others are wanted.

Provenance is also the only rung that is reversible. Ownership is not: once a repository can be claimed, un-claiming it is a policy nobody will agree on.

## The mechanism, measured rather than assumed

Every line here was run before it was written down, because the obvious assumption — that signed pushes are an SSH-transport feature — is wrong, and building on it would have been wrong in the expensive direction.

- **A signed push works over HTTP**, through walgit's own server (`bun src/server.ts` with a file store, `faa3cd5..5963498 HEAD -> main`). Push certificates are a `receive-pack` capability, not a transport feature.
- **The capability is gated by `receive.certNonceSeed` on the receiving repository.** With it set, the push is accepted and certified; without it, git refuses client-side with `fatal: the receiving end does not support --signed push` — which is exactly what agentgit says today.
- **The hook sees the certificate.** `pre-receive` receives `GIT_PUSH_CERT` (a blob id) and `GIT_PUSH_CERT_NONCE_STATUS=OK`, so replay protection works without walgit implementing any of it.
- **git's own verdict is useless here, and that is fine.** `GIT_PUSH_CERT_STATUS=N` with no signer, because git verifies certificates with GPG by default and these are SSH signatures. Configuring the server for SSH verification would require an allowed-signers file, which is a key registry — precisely the thing this design refuses to have.
- **`ssh-keygen -Y check-novalidate` is the way out.** It verifies the signature is genuine and returns the key fingerprint **without any allowed-signers file**: `Good "git" signature with ED25519 key SHA256:GzIPdanMaru82l2zW4O42kYBWBnzzctgl0bytRQmOkw`, byte-identical to the pushing client's key. That is exactly what trust-on-first-use needs and no more than it needs.
- **Signatures are namespaced.** git signs push certificates under the `git` namespace, so a signature cannot be replayed against an SSH authentication handshake. Verification must therefore pass `-n git`, and does.
- **`--signed=if-asked` is safe everywhere.** The same command pushes unsigned to a server without the seed and signed to one with it. An agent can pass it unconditionally, including to GitHub.
- **Provisioning cost is zero where a key already exists.** An agent's existing GitHub SSH key signed both a commit and a push with no new key, no passphrase prompt and no config beyond pointing `user.signingkey` at the `.pub` — and the host read back that key's own fingerprint. Key generation is 6 ms; signing a commit is 20 ms; there is no keyring, agent or passphrase in the path.

## What is verified, and what is not

**The push certificate**, not the commit signature. The certificate is a claim about *who moved this ref*, which is what ownership will need, and it carries the nonce that makes replay somebody else's problem. A commit signature is a claim about *who authored this content* — a different and equally real claim, but one that survives being cloned and re-pushed by an agent who signed nothing, so treating it as the identity of a push would attribute work to the wrong party.

Commit-signature status is recorded opportunistically when present. It is never required.

## Where provenance is written

In `index.json`, as a new optional map keyed by ref:

```
provenance?: Record<ref, { signer: string; ts: string }>
```

Written in the same compare-and-swap that publishes the push.

Three constraints forced this shape:

- **The certificate does not survive.** It arrives as a blob on the container's filesystem, and that filesystem is a Cache (ADR-0007) — wiped on restart, rebuilt from the log. A fingerprint not written into the log at push time is gone by the next cold materialize.
- **A ref-only push appends no WAL Entry.** A push that moves a ref without new objects bumps no sequence number and adds no entry (`src/push.ts`), so provenance hung off entries would be blind to a whole class of push. It is not blind to `index.json`, which every publish rewrites.
- **`refs` must keep its shape.** Widening `ref → oid` into `ref → {oid, signer}` would touch reconcile, materialize, verify, usage and gc, and would contradict the sentence in ADR-0007 that describes the Index. A separate optional map costs nothing when absent and changes no existing reader.

It is latest-state, per ref, like everything else here. There is no provenance history, and the absence is deliberate: the audit trail of *content* is the commit graph and its signatures, and a second ledger would be a second thing to keep true.

## How it is read

`GET /_walgit/provenance?repo=<name>`, and **not** on the event stream.

ADR-0009 froze that wire on purpose, and an event says one thing: a ref moved, and to what. Provenance is separate state with a different lifetime and a different reader, so it is a separate read. Written-and-unreadable would make the feature decoration, so a read path is required — but it is not this one.

The repository is a query parameter rather than a path segment because `SMART_HTTP` is the three git endpoints and no more; widening that grammar to carry a fourth would change what the Worker counts as a clone. It sits below the credential gate and above the git endpoints, and that position **is** the authorization: the read is behind exactly the credential a clone of that repository needs, so there is no second authorization model to keep in agreement with the first.

## How it is found

Both agent-facing documents render it from the seed, and say nothing about it without one.

`GET /` is read mid-task, so it gets the flag, the config that signs, and the endpoint to read back — nothing else. `/llms.txt` is fetched deliberately, so it carries what a fingerprint is taken to mean, that walgit keeps no allowed-signers list, and that unsigned pushes are ordinary.

The recommended form is **`--signed=if-asked`**, never `--signed=yes`: it signs where the host takes a certificate and pushes normally where it does not, so one command is correct everywhere and an agent never branches on which host it is talking to. `--signed=yes` against a host with no seed is refused by the client's own git before a byte leaves the machine, which is also why a document must not offer signing on a deployment that has none — the failure lands after the agent has written the push, not before.

## Boundary

Verification and recording are **mechanism**, so they ship in the walgit app template, **off unless `WALGIT_PUSH_CERT_SEED` is set** — the seed joins the forwarded environment (`shared/container-env.ts`), and `openssh-keygen` joins the container image, which currently installs only `git` and `git-daemon`. A deployment that never sets the seed advertises no capability, and git therefore never signs against it: unchanged in every observable way.

Ownership policy, when it comes, is **opinion** and belongs to agentgit as instance configuration. *Capabilities, never opinions* (`CONTEXT-MAP.md`).

## Consequences

- **Anonymous stays first-class, permanently.** Unsigned pushes are not second-class, not rate-limited differently, and not marked as suspect. The service's opening line is that there is no account, and provenance must not quietly make that false.
- **The nonce seed is configuration, not state.** It must be an environment variable rather than generated at boot, because the container's disk is wiped on restart and a regenerated seed would invalidate in-flight nonces. `ensureBareRepo` already rewrites hooks on every access, so applying the seed there means rebuilt repositories inherit it for free.
- **Verification costs a subprocess per signed push**, on a container anyone can push to. Bounded by the existing size caps and by the fact that only signed pushes pay it.
- **Cloud agents have no key.** Local agents mount `~/.ssh` and are therefore already signers at no cost; agents authenticated with a minted token have a credential that cannot sign. Under this ADR that is fine — they push unsigned. It stops being fine when ownership lands, because "whoever pushed last owns it" is dangerous for an agent whose key is regenerated each run, so the harness minting a stable key per agent is a prerequisite for the ownership ADR rather than for this one.
- **An undiscoverable capability is an unused one.** Signing is worth almost nothing if an agent cannot learn from the front door that the host will read it, which is why the documents are part of this ADR rather than a follow-up. It also means the rendering discipline applies one step harder here than to a size cap: an unenforced cap misleads, while an unadvertisable flag fails in the client.
- **A fingerprint is portable identity without a registry.** It is the same string GitHub already knows that key by, which means attribution can be cross-referenced by anyone who cares, while walgit holds no account, email or token.
- **This ADR deliberately leaves key loss unsolved.** Nothing is gated on a key, so losing one costs nothing. Every rung above this one has to answer it, and every identity system eventually becomes a recovery system.

## Vocabulary

**Signer** — the key that signed a push, named by its fingerprint. Never "user" or "account": neither exists. **Provenance** — the recorded fact that a signer pushed a given ref update. Deliberately not "identity", which implies a registry. **Claim** is reserved for the trust-on-first-use assertion, if ownership lands; "owner" implies a permission system rather than a first-mover fact.
