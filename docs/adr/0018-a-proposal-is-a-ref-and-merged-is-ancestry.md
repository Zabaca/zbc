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
- **The receive hook refuses a malformed Proposal** rather than storing it: a target that does not exist, a target outside `refs/heads/` and not the Signer List (see the amendment below), a tip that is not a commit. With the flag off the namespace is an ordinary ref namespace under the ordinary gate.

## Why not the alternatives

- **Host-assigned numbers** (Gerrit's `refs/changes/NN`) need a magic push target and a reply naming the ref, machinery git does not offer over smart-HTTP. A pusher-chosen id costs nothing and collisions are already refused.
- **Stored state** — a row in `index.json` or a signed `proposals` file — would be the first fact about a repository that is not a git object or a signature over one, and the first thing a Materialize could not rebuild from packs. Every state a Proposal needs is derivable, so none is stored.
- **A merge endpoint** is what every other host offers and what an agent without a clone would like. It was refused because it puts the host's name on a write, and because the conflict it hits has nowhere to be resolved.
- **A `proposers` list** was the first design. It was dropped when the rule collapsed to reading: on a world-readable name a list of who may propose is a list the world can ask to join, and on a Private name the Reader List already is that list.

## Consequences

- The word is **Proposal**. "Pull request" already means a GitHub PR elsewhere in this repository, and "change request" is an approval-board ticket; the glossary in `packages/walgit/CONTEXT.md` lists both under _Avoid_.
- The first thing walgit ships that a stranger can put in a claimed repository. Its blast radius is bounded by what a push already is: attributable, append-only, capped, expiring.
- walgit may gain capabilities, never opinions: everything above is instance configuration for agentgit, and nothing in `packages/agentgit/` but the Client changes.


## Amendment (2026-09-18): the Signer List is a target

This ADR originally refused every target outside `refs/heads/`, in one clause,
"so nobody proposes a Signer List". That refusal was aimed at a write, and it
also closed the only door a stranger has: a name's refusal could say how to be
added but not what the reader itself could do, because the answer was always
"get somebody already listed to push a commit". A Proposal is exactly the shape
of that request, and refusing it bought nothing — a Proposal is not a write to
its target.

- **One more target, spelled `walgit/signers`.** The ref is
  `refs/walgit/proposals/walgit/signers/<id>`: the id is still the last segment,
  the target is still in the ref name, and the spelling is the list's ref with
  `refs/` dropped. The exception is exact — `walgit/signers/deeper` is an
  ordinary branch name and is resolved as one — so the grammar gains a constant
  rather than a rule. Every other target that begins `refs/` is refused as
  before.
- **Nothing else changes.** Who may propose is the same rule (signed, and a
  reader where a Reader List exists); it is held under the Proposal namespace
  like any other; Merged is `merge-base --is-ancestor` against
  `refs/walgit/signers`; and the list itself is still written only by a key it
  already names. A Proposal against the list is a request, not a grant.
- **The refusal offers it.** `heldMessage` leads its remedy with proposing the
  list wherever Proposals are open to the key reading it, and leaves the line
  out entirely where they are not — a remedy naming a door that 404s is worse
  than the terse one it replaces.
- **`agentgit accept` grows a second path.** A branch is accepted where it is
  checked out; the list is accepted with no checkout at all — fetch both tips,
  fast-forward or `merge-tree` + `commit-tree`, push the result signed to
  `refs/walgit/signers`. Nobody has the list checked out, and an agent's own
  working tree must not move to accept a stranger's request. A conflict in the
  `signers` file is left to the Signer with the manual recipe: which lines hold
  the name is not something a client decides.
- **Ref Events are unchanged.** `merged` is still computed for branch moves
  only. A Signer who accepted a list Proposal knows it landed; a Watcher reading
  `merged` on the Signer List ref is a surface nothing has asked for.
- **Not generalised.** The Reader List (`refs/walgit/readers`) is the same shape
  and is deliberately not admitted here: asking to read a Private name is a
  different question from asking to write one, and it can have its own decision.
