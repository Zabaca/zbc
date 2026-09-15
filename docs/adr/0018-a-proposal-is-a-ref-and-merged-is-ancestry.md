# A proposal is a ref, and merged is ancestry

**Status:** proposed (2026-09-15). Extends [ADR-0011](./0011-walgit-records-who-pushed-and-refuses-nothing.md) (a Proposal is attributable because every push is), [ADR-0012](./0012-a-name-can-refuse-a-stranger.md) (a Proposal is the one push a claimed name takes from someone not on its Signer List) and [ADR-0013](./0013-a-name-can-refuse-a-stranger-reading.md) (who may propose is exactly who may read). Honours [ADR-0007](./0007-walgit-object-storage-holds-the-log.md): nothing here is state the log cannot hold.

walgit gains a **Proposal**: a ref under `refs/walgit/proposals/<target>/<id>` that names a commit its pusher wants in `refs/heads/<target>`. A Proposal is that ref and its Push Certificate and nothing else. It is **Merged** when its tip is an ancestor of the target's tip — computed on read from the Cache, never recorded — and it is open otherwise. There is no third state. The capability is deployment-wide (`WALGIT_PROPOSALS`), default off, and agentgit turns it on.

## What was decided

- **A Proposal is a ref the pusher names.** `git push origin HEAD:refs/walgit/proposals/main/fix-auth`. The id is the pusher's word; the target is in the ref name so `ls-remote` shows it and no commit is parsed. Updating a Proposal is a fast-forward push to the same ref, which append-only permits; a second pusher choosing a taken name is refused as a non-fast-forward and picks another. The host assigns nothing.
- **Merged is ancestry, only.** `merge-base --is-ancestor <tip> <target>`. A squash or a rebase of a Proposal's commits does not merge it and never will — the definition is "this commit is in the target's history", and a definition that also accepted "this content landed" would be ambiguous the moment the target moved on. Acceptance is therefore a fast-forward or a true merge, pushed by a Signer.
- **Whoever may read may propose.** On a world-readable name, anyone whose push is signed. On a Private name, its Signers and Readers — the Read Challenge already stops anyone else at the advertisement. An Unclaimed name refuses nothing anyway. There is no `proposers` file: the owner's control over *who* is the Reader List, and going Private is the escape hatch from the world.
- **The host never accepts.** No merge endpoint, no fast-forward endpoint. A ref moved by the host would be a write with no Push Certificate behind it, which ADR-0011 forbids. Acceptance is an ordinary push judged by the Signer List and recorded by Provenance; conflicts are resolved where git resolves them, in the accepter's working tree. The Client may add `accept <id>` as sugar for fetch, merge, push.
- **No rejection, no withdrawal, no comments.** Append-only means a Proposal ref cannot be deleted, and a rejection is a message to the proposer, which this host does not carry. A Proposal nobody accepts is open until the repository expires. *Superseded* — an open Proposal whose tip is an ancestor of a newer Proposal to the same target — may be derived from the same walk if it is free; it is not stored either.
- **A Proposal is a push.** It counts against the name's size caps and it extends idle expiry, because the landing page promises "pushing does". No separate budget. A world-readable name that is being filled with junk goes Private with one file.
- **Read surface.** `GET /<name>.git/proposals` returns id, target, tip, pusher fingerprint and merged, behind the Read Challenge like the Provenance Read. A Ref Event for a target moving carries the ids it newly merged, so a Watcher on `main` learns without a second call — the first field a Ref Event has carried beyond ref and sha. `agentgit watch --proposals` subscribes to the namespace for the current branch and reports `proposal` and `merged` events; it is opt-in because the default watch keeps a branch current and a stranger's push must not move a working agent's clone.
- **The receive hook refuses a malformed Proposal** rather than storing it: a target that does not exist, a target outside `refs/heads/` (so nobody proposes a Signer List), a tip that is not a commit. With the flag off the namespace is an ordinary ref namespace under the ordinary gate.

## Why not the alternatives

- **Host-assigned numbers** (Gerrit's `refs/changes/NN`) need a magic push target and a reply naming the ref, machinery git does not offer over smart-HTTP. A pusher-chosen id costs nothing and collisions are already refused.
- **Stored state** — a row in `index.json` or a signed `proposals` file — would be the first fact about a repository that is not a git object or a signature over one, and the first thing a Materialize could not rebuild from packs. Every state a Proposal needs is derivable, so none is stored.
- **A merge endpoint** is what every other host offers and what an agent without a clone would like. It was refused because it puts the host's name on a write, and because the conflict it hits has nowhere to be resolved.
- **A `proposers` list** was the first design. It was dropped when the rule collapsed to reading: on a world-readable name a list of who may propose is a list the world can ask to join, and on a Private name the Reader List already is that list.

## Consequences

- The word is **Proposal**. "Pull request" already means a GitHub PR elsewhere in this repository, and "change request" is an approval-board ticket; the glossary in `packages/walgit/CONTEXT.md` lists both under _Avoid_.
- The first thing walgit ships that a stranger can put in a claimed repository. Its blast radius is bounded by what a push already is: attributable, append-only, capped, expiring.
- walgit may gain capabilities, never opinions: everything above is instance configuration for agentgit, and nothing in `packages/agentgit/` but the Client changes.
