# The knowledge base is the knowledge app's, and the inbox asks it

Status: accepted. The knowledge app's side is `packages/knowledge/docs/adr/0001`; the Knowledge tab's is `packages/space/docs/adr/0008`. The owner answered four open questions when accepting it: where the knowledge is kept, who may change it, what happens to the one-time carry from an earlier app, and what the old tables become. They are the decisions below.

## What this supersedes, and what it leaves

- **Supersedes, in part, decision 21 of ADR 0001** (the draft chat, the knowledge page and the carry): the knowledge page, the knowledge routes the owner used, the one-time carry from an earlier app (`import-knowledge`), and "the assistant reads its mailbox's active entries from this store". The
  chat itself, its persona, its prompt and the model it calls stand.
- **Supersedes the earlier rule that "entries belong to a mailbox"** (made when a second Cloudflare mailbox was added): an entry is marked with the businesses it is for, and a mailbox draws on the entries of its business. A persona's own rules (for example, general information only and never legal advice, nothing about another business) belong to the persona and are unchanged by any entry it reads.
- **Supersedes decision 23's "the owner's Gmail has no knowledge base":** the owner's Gmail belongs to a business (the company declaration's `businesses`), so it
  reads the entries marked for that business. While none is, its prompt says the knowledge base is empty and it states no price, hour or policy.
- **Leaves** the inbox's old per-mailbox tables (`knowledge_entry` and `knowledge_version`, with the migrations that made them) exactly as they are, read by nothing.
  Dropping them would be a one-way migration of the store of live mail that nothing needs; going back is redeploying two builds.

## What the inbox does now

- **The assistant asks the knowledge app first.** A service binding, `KNOWLEDGE`, to the knowledge Worker's `InboxKnowledgeAccess` entrypoint (in the space's Worker the knowledge store is handed to the inbox in-process, with the same face). Before the model
  is called, and before anything of the owner's is saved, the assistant names the business of the conversation's mailbox (the declaration says which; the inbox
  never keeps its own list) and asks for that business's ACTIVE entries (`src/assistant/assistant.ts`, `src/knowledge.ts`). A mailbox in no business is
  given no knowledge base, in the prompt's existing words, and the app is not asked.
- **The four-second rule.** The app is waited for at most `ANSWER_WITHIN_MS` (four seconds, the space's read wait). If it does not answer, refuses, answers
  something that is not a reply, or the Worker has no binding, the turn is refused (503) with "The knowledge base could not be read, so nothing was drafted.
  Ask again in a moment.", the owner's words stay in the box, and nothing is saved but the audit of a failed call (words typed into an empty reply box are saved as the owner's draft before the assistant is asked, as the page always did). **It never drafts as if the business had no
  entries**, because a draft written without them could leave out a price on record and still look complete.
- **Claude's script keeps its commands and its token at this address.** `knowledge [business-id]` and `propose-knowledge` are handed on to the app, which
  names Claude as the proposer (`agent:` and the token's client id). The app's inbox entrypoint can read and propose and nothing else, so Claude's token can
  never change what an assistant says. The script's `import-knowledge` and its route are gone.
- **The owner changes entries in the space's Knowledge tab only.** The inbox's Knowledge page, the Knowledge item under each mailbox in its menu
  and its owner-only knowledge routes are deleted; `#/knowledge` is one line linking to the tab, so an old bookmark says where it went.
- **`SpaceInbox` loses `knowledge` and `changeKnowledge`.** The space reads and writes the base through its own binding to the knowledge app.

## The carry from an earlier app will not run

An earlier app's few knowledge entries stay in that app, and the knowledge base starts empty. Both of the inbox's old bases were empty when the switch went in, so nothing is moved either, and **the switch checks they still are** just before it deploys
(`scripts/pre-switch-check.ts`, deleted after the switch deployed): if either holds an entry it stops and says which, and the owner adds it again in the tab afterwards.

## Why this and not a bigger change

The assistant stays in the inbox (moving it into a separate app was rejected; its reason still holds). Only where it finds the knowledge moved.
The cost is a way to fail that did not exist (the app does not answer), which is why the refusal above is a sentence and not a quiet empty base.
