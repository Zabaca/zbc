# A name can refuse a stranger

**Status:** proposed (2026-08-30). Builds on [ADR-0011](./0011-walgit-records-who-pushed-and-refuses-nothing.md) — this is the ownership rung that one deliberately bought the answer for and did not spend. Extends [ADR-0008](./0008-walgit-runs-on-a-cloudflare-container-without-ssh.md): smart-HTTP remains the only transport, and this needs no other. Extends [ADR-0007](./0007-walgit-object-storage-holds-the-log.md): the log stays the source of truth, and the Cache stays disposable.

A repository may carry a **Signer List** — key fingerprints written to `refs/walgit/signers`. While a repository has one, a push not signed by a listed key is refused. While it has none — every repository until someone writes one — nothing changes.

Reads are not gated. Accounts do not exist. Nothing becomes private. Anonymous pushing stays first-class on every unclaimed name.

## The problem append-only creates

agentgit is append-only, which is what makes it safe to hand a URL to a stranger: nobody can destroy what you pushed. It is also what makes a stranger's write into your name **permanent**. Anyone who knows the name can add a branch to the repository an agent is working in, and neither the agent nor walgit can ever remove it — `pre-receive` refuses that deletion for exactly the reason it protects your history from them.

Provenance records _who pushed_ and refuses nothing on the strength of it, so the fingerprint in the Index is evidence with no consequence. An agent that wants a name it can rely on has one defence today: pick a name nobody guesses.

## The mechanism is a ref

The list is an ordinary ref, and that settles four things with no new machinery:

- **claiming** a free name is pushing the ref;
- **granting** is a commit that adds a line;
- **revoking** is a commit that removes one;
- **reading** it is `git ls-remote` or a clone.

Each is a signed push, already authenticated by its certificate and published by the same compare-and-swap as any push. There is no grant API, no claim endpoint, and no widening of the three git endpoints.

**A commit chain, and this was measured.** A ref pointing straight at a blob cannot be updated under append-only: `git merge-base --is-ancestor <blob> <blob>` exits 128 (_"is a blob, not a commit"_), and the append-only judge reads any non-zero exit as a rewrite. A blob-valued ref could be created once and never edited — no grants, no revocations. A commit chain fast-forwards.

**Format.** The tip commit's tree holds a file named `signers`: one `SHA256:…` fingerprint per line, blank lines and `#` comments ignored. That is the spelling `ssh-keygen -Y check-novalidate` reports and GitHub prints, so no new identity format enters the system. A line that is neither blank, a comment, nor a fingerprint fails the whole list rather than being skipped — a typo dropped silently would cost an agent a key it believes is listed.

## Where the list is stored

**The ref is authoritative; the Index carries a derived copy** — a new optional repo-level `claim` field holding the resolved fingerprints and a timestamp, written by the same compare-and-swap that publishes the push that moved the ref. Exactly the pattern Provenance established: derived in `pre-receive` from the quarantine, carried through the pending record, applied at publish.

The copy exists because the enforcement path must not read a git object. `pre-receive` already loads the Index; resolving from the Cache would make the refusal depend on the Cache being materialized, and the Cache is disposable by definition. It is safe rather than a second source of truth: written atomically with the ref, derived from bytes in the same push, and rebuildable — a restore replays both together, because both live in the Index.

It cannot be derived from Provenance, which is latest-state per ref and overwritten on every push, so by the time it mattered it would hold the most recent Signer rather than the founding one.

Index parsing is a cast over `JSON.parse` with no schema and no unknown-field rejection, so the field costs nothing when absent and changes no existing reader either way.

## Where the verdict runs

The `pre-receive` branch of the hook entrypoint, beside the append-only and size verdicts, for the identical stated reason: **before the pack is uploaded**. git's own refusals run after the hook and the upload happens inside the pre-receive path, so a refusal reached later leaves an Orphan behind every rejected push.

The verdict is pure over the Signer this push established (or `null`), the Signer List as it stood before this push (or `null` for unclaimed), and the ref changes. No git, no store, no subprocess.

**A grant governs the next push.** The list that judges a push is the one that stood before it. A push may move the list and a branch together; the new list applies from the following push. The founding push needs no exception — an unclaimed name refuses nothing.

**Empty and unreadable lists are refused**, on claimed and unclaimed names alike. An empty list would hand the name to the next stranger, so a compromised key could give it away rather than merely keep it. An unreadable one would leave an agent believing it holds a name it does not. Deleting the list ref is the empty case by another spelling, and is refused with it. A list too large to read is unreadable for the same reason and refused with the same sentence: it is copied into `index.json`, which every later push re-reads and rewrites, and reading an unbounded blob is how one gets silently truncated into a list the ref does not hold.

These three are the only refusals that touch an unclaimed name, and they are refusals about _writing a list_, not about who may push. Enabling the flag therefore changes what a push to `refs/walgit/signers` may contain, on every repository — not only on claimed ones.

**Fail open acquires its first exception, confined.** On a repository with a Signer List, an unestablished Signer refuses the push; on one without, no push is refused for who signed it, down to the unconditional catch that ADR-0011 put at the seam.

## How it is read

The existing Provenance read gains a `claim` field beside `provenance`: same Index, same route, same credential — the one a clone already needs. A second route would be a second thing to keep in agreement for no new authorization question. The field is **omitted** for an unclaimed repository, so absence has one spelling on the wire and in the Index.

The derived copy is maintained only while the flag is on. A list pushed before it was enabled leaves the Index behind the ref, and nothing re-derives one from the other; the ref is the authoritative one, and the enforcement slice is where that gap has to be answered.

## How it is turned on

**Its own flag** — `WALGIT_SIGNER_LISTS`, through the existing boolean-flag helper, off in the package, exactly as append-only works.

It deliberately does not ride the push-certificate seed. That seed is the flag for _signing_ because a client's own git refuses `--signed=yes` where it is unset, so the capability cannot be asked for where it is not offered; ownership is a server-side refusal with no client-side coupling. The seed also went live on agentgit on 2026-08-30, so a capability implied by it would arrive on a running deployment as a side effect.

**Discovery is `/llms.txt` and the refusal message, not the terse front door.** `GET /` renders 2,957 bytes against a 3,000-byte budget asserted in test. The deeper reason is ADR-0011's own: signing had to be on the front door because its failure lands client-side after the agent has written the push; ownership's failure lands on our server, in our words, at the moment it is relevant.

## Boundary

The mechanism ships in the walgit app template, off. Turning it on for agentgit is instance configuration and a separate decision — _capabilities, never opinions_ (`CONTEXT-MAP.md`).

## Consequences

- **The one-way door is smaller than ADR-0011 feared.** It called ownership irreversible because un-claiming is a policy nobody would agree on. On a deployment that expires idle repositories it is idle expiry; on one that does not, the claim is permanent — and for a company running its own host that is the correct answer, not a defect. Coupling ownership to expiry would be walgit forming an opinion, so it is not done here.
- **There is no recovery path for a lost key**, and none is added: no out-of-band proof, no escrow, no support address. It is bounded instead by multi-key lists, by revocation, and by idle expiry where a deployment has it. Two keys are better than one, and the documents say so — the single-key list is the shape most agents will write and the one with no way back.
- **A cloud agent whose key is regenerated each run cannot hold a name.** ADR-0011 named this: "whoever pushed last owns it" is dangerous for an agent with no stable key, so a harness minting one per agent is a prerequisite for using this, not for shipping it.
- **A claimed repository stays world-readable**, and so do its list and its Provenance. Reads are untouched, and this ADR must not be read as a step toward private repositories.
- **Nothing here is retroactive.** A repository a stranger has already written to can be claimed, and the stranger's branch stays — append-only still means append-only.

## Vocabulary

**Signer List** — the key fingerprints a repository names on `refs/walgit/signers`. **Claim** — the recorded fact that a repository has one; ADR-0011 reserved the word for exactly this, and "owner" is still avoided because it implies a permission system rather than a first-mover fact. **Unclaimed** — a repository with no list, which is every repository until someone writes one.
