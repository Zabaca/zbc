# The knowledge base is an app of its own with no address, and it starts empty

> **Amended:** the store is now the SPACE's Worker's, the Knowledge tab calls this package's code in that Worker, and this package's own Worker (a forwarder for the inbox while the inbox moved in) has been deleted, so the package is a library. "An app of its own" holds for the code and its rules, not for the Worker. "No address" holds for the forwarder, and the space's address is the space's.

Status: accepted. This is the record of the choice of where the install's knowledge base lives, and of the four decisions (a to d, below) that shaped it.

## Why an app of its own

Each mailbox of the inbox used to keep its own knowledge base inside the inbox's store (ADR 0001 of the inbox, decision 21, and the shared mailboxes' rule that entries belong to a mailbox). The owner wants one knowledge base for the organisation, each entry
marked with the businesses it is for, and a Knowledge tab of its own in the space. Three places could hold it; this is the one chosen (decision a):

- **In the inbox's store, re-keyed by a migration** (rejected): the cheapest, but it migrates the store of the live mail,
  so undoing it is a forward fix, and restoring the inbox after a mail problem would take the knowledge base back with the mail.
- **A second store inside the inbox's Worker** (rejected): no migration of the mail store, but a knowledge change still
  restarts the inbox, and the next reader (a pointer on Today, a site's chat, a client's install) has to go through the inbox.
- **An app of its own** (this one): it deploys, fails and is restored apart from the mail. The inbox's store is never migrated, so
  going back is redeploying two builds (the inbox's and the space's). A knowledge change never restarts the inbox. Another reader
  binds to it without going through the inbox. The cost is the most parts of the three: a new Worker, two bindings, a second contract
  and a deploy order (this Worker before the inbox and the space).

The inbox's assistants stay in the inbox (a second inbox for a business's mail was rejected and still is); only the entries they
read live here.

## No address

The Worker has no route, no Custom Domain, no `workers.dev` or preview hostname, no Access application and no DNS record. Nothing on
the internet reaches it; only a Worker in the account with a service binding does, as the space reaches the inbox's `SpaceInbox`
and the inbox reaches a site's client directory. The store of what assistants may tell customers is behind a binding, not a door.
The infra package's `test/knowledge.test.ts` pins it. Claude's script keeps its commands and its token at the inbox's address and the
inbox hands its reads and proposals on; the space admits no service token, so this is Claude's only way in, and nothing else needs a
sign-in page of the knowledge app's own.

## Who may call each entrypoint, and with what

- **`SpaceKnowledge`, for the Knowledge tab.** Every method takes the Access assertion the space forwards and verifies it itself
  against the space application's audience (`SPACE_ACCESS_AUD`), by the company layer's rule
  ([ADR 0001](../../../workspace/docs/adr/0001-the-apps-verify-the-assertion-the-space-forwards.md)): a forged, expired,
  other-audience or service-token assertion is `not-signed-in`; a verified person who is not an owner of the install (a teammate)
  is `not-admitted`. Then it admits the install's owner, who alone reads the whole base (every status) and changes it. The actor
  stamped on every write is the owner's address, never anything the caller typed. The inbox admits its owner only, and so does
  this: a teammate has no business seeing what the assistants say before it is approved.
- **`InboxKnowledgeAccess`, for the inbox.** No assertion. It has no route, so only a Worker with the binding calls it, as the
  inbox calls a site's client directory without one. It does three things: gives a business's active entries (the words only) when
  the owner asks an assistant for a reply; reads the base for Claude's script; takes Claude's proposals, naming the proposer, which must
  be an agent (`agent:` and the token's client id). **It cannot edit, remove or approve anything**: those exist on the space's
  entrypoint alone. The only thing it can write is a proposal, and nothing reads a proposal until the owner approves it in the tab. That
  is why it can do without a sign-in: the worst a Worker holding the binding can do is put a proposal in front of the owner.
- **The boundary underneath is the account's deploy rights.** The Durable Object's own `call` is meant to be reached by the two
  entrypoints alone, but nothing in the code stops another Worker in the account from binding the class by `script_name` and calling
  it. What stops that is who may deploy to the account (the deploy token and the secrets file behind it), the same boundary every Worker
  here rests on. The store still applies its own rules to whatever it is asked: only the owner's address writes, only an agent proposes.
- Each class is exactly its contract's methods (the workspace package's `src/knowledge.ts`), pinned by test, because the runtime exposes
  every method of an entrypoint over RPC whatever TypeScript says about `private`.

## The rules, moved, and what changed with the key

The rules are the inbox's knowledge store's, unchanged in meaning: every version kept and never edited, the version check, the owner
alone changing entries, Claude only proposing, the assistants only reading, at most fifty proposals waiting. What changes is the
key. An entry is marked with **businesses** from the company declaration, not a mailbox:

- At least one business per entry, each one the declaration lists. A change of businesses is an edit, so it makes a version: the
  history shows who changed whom an entry is told to, and when.
- "Every business" (decision b) means every declared business ticked and stored as a list. A business added to the declaration later starts
  with no entries and is told nothing until the owner marks an entry for it.
- Adding an entry whose title and body an active entry already holds is a conflict, whatever its businesses, and the sentence says
  to add the business to that entry. The fifty-proposal cap counts the whole base.
- A proposal names its businesses; a proposed change may change the words, the businesses or both, and what it leaves out is the
  entry's. Approving applies both as the owner's edit.
- **A proposed change is written against one version of its entry** (`replaces_version`, recorded when Claude proposes), because it
  copies the entry's words and businesses as they stood. Approving it once the entry has been changed since is a conflict: otherwise
  it would write the old copy back over the owner's later edit (a corrected price) or put back a business the owner took off the
  entry, which would tell that business's customers something the owner had withdrawn. The proposal can still be rejected, and
  Claude proposes again against the entry as it is. Only an ACTIVE entry can be the target of a change, so a proposal cannot rewrite
  another proposal or a removed entry. (This was found in review before the first release; migration 0 carries the column because it had not shipped.)
- The businesses are the declaration's because it is the one file the inbox, the space and this app all read, so they cannot
  disagree about the list.

## It starts empty

Nothing is carried and nothing is moved (decision d). When this base replaced the inbox's per-mailbox knowledge bases, both held 0 entries,
so there was nothing to move; a business's entries kept in a separate app stay there: the carry (`import-knowledge`) will not run and its code is deleted.
The owner adds what is wanted in the tab. The switch checks first that the old bases are still empty and
stops, telling the owner which, if either, holds an entry. Why not build a move anyway: for a base that is empty it would be code with
nothing to prove it against. The `source_ref` column the inbox's table had for the carry does not exist here.

## Consequences

- If this app does not answer within four seconds, the inbox refuses the draft-chat turn with a sentence and saves nothing; it never
  drafts as if the business had no entries (the behaviour of the switch, recorded here because this app is what it waits for).
- Restoring the inbox no longer takes the knowledge base back with the mail, and the base's store keeps Cloudflare's 30 days of
  history without a restore screen of its own: versions are never edited and a removal is put back in one click.
- Undoing the switch is redeploying the inbox's and the space's previous builds. Anything added here after the switch stays here, read
  by nothing, and is copied back by hand if wanted. This Worker can stay deployed, unused.
- A deploy that changes the Worker's name, the Durable Object's class or its migration tag, or the object's name, comes up with an empty
  base beside the stored one.

## Decisions

- **a.** This option, the app of its own. Putting the base in the inbox's store, or a second store in the inbox's Worker, was rejected.
- **b.** "Every business" means the declared businesses ticked and stored as a list. A business added later starts empty.
- **c.** Only the Knowledge tab changes knowledge (the per-mailbox items and the Settings section are removed; the inbox's own
  Knowledge page becomes a line linking to the tab).
- **d.** No carry. The base starts empty.
