# knowledge: Context

The one knowledge base of an install: what its assistants may tell people. Built for an install with several businesses, each with its own assistant. The company layer's terms (install, declaration, business, entrypoint, assertion) are in
[`packages/workspace/CONTEXT.md`](../workspace/CONTEXT.md).

## Glossary

- **Knowledge base**: every entry of the install, in every status, with its history. One per install, in one Durable Object.
  Not the inbox's old per-mailbox knowledge, which it replaces and does not take anything from.
- **Entry**: a title, a body, the **businesses** it is for, a **status** and its **versions**.
- **Business**: defined in [`packages/workspace/CONTEXT.md`](../workspace/CONTEXT.md). An entry is for at least one, named by its
  id. "Every business" is a control in the tab that ticks the declared businesses; what is stored is the list, so a business added
  later starts with no entries.
- **Status**: `active` (what the assistants read and quote to customers), `proposed` (Claude's, waiting for the owner; nothing reads
  it), `removed` (read by nobody, history kept; a rejected proposal is here too).
- **Version**: the entry as it was at a change: who, when, title, body and businesses. Appended, never edited or deleted. A change of
  businesses alone is a version, because it decides which customers are told the entry. Every change names the version its author
  was shown, and is refused as a conflict over an entry that has moved on.
- **Owner**: the install's owner. Adds, edits, removes, puts back, approves and rejects, and no one else does.
- **Proposal**: what Claude puts forward, a new entry or a change to one (`replaces`). A proposed change copies the entry's words
  and businesses as they stood and records the entry's version; approving it applies the copy as the owner's edit and keeps the
  proposal under Removed, and is refused as a conflict once the entry has been changed since, so it can never undo a later edit.
  Only an active entry can be the target of a change.
- **What an assistant is given**: the words (title and body) of a business's active entries, oldest first, and nothing else.
- **Space face** (`createSpaceKnowledge`, formerly the entrypoint `SpaceKnowledge`): the Knowledge tab's way in, called in the space's Worker with the person its one sign-in check named. Admits the owner only.
- **Inbox face** (`createInboxKnowledge`, formerly the entrypoint `InboxKnowledgeAccess` of a Worker of its own that has since been deleted): the inbox's way in, called in-process in the space's Worker, with no assertion. Reads and proposes; cannot edit, remove or
  approve.
