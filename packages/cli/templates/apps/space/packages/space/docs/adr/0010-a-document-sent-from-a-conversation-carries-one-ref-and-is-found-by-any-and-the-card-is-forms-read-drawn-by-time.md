# A document sent from a conversation carries one ref and is found by any, and its card is forms' read drawn by time

Status: accepted. A document is shown as a card in its conversation, and the signed copy's card comes back. Builds on [0004](0004-a-conversation-is-one-history-per-person-and-every-send-carries-a-key-made-once.md) (a conversation is one history per person) and keeps [0007](0007-forms-screens-are-the-space-s-own-page-and-forms-keeps-the-api.md)
(forms' screens are the space's page; forms keeps the operator API and the signer's pages).

## What a conversation is, to forms

An envelope may carry **the conversation it was sent from**: `{ app, id }`, where `app` is `inbox` or `meet` and `id` is the id that app gives it (the inbox's contact id for the mail side of a person, meet's conversation id for a
direct message or a channel). It is stored in forms (migration `0004_conversation.sql`, two nullable columns held both-or-none by the schema), set once when the draft is made, and never changed. It is **not written into any event**: every event is sealed into the PDF each signer receives, and an internal id of the space has no place there.

Three choices follow from what a conversation is in the space:

- **The key is not the ref.** A person's row key is their first address, which changes when they gain one (`PersonRow.key`, not stored anywhere). A document would lose its conversation. The stored ids do not change.
- **A person's conversation has several refs**, because it is a merge: a mail contact per address and a direct message. A document carries **one** (the first: the mail contact, else meet's conversation) and is **found by any** ref the
  conversation has (`refsOf`, `src/conversation.ts`; forms' `documentsIn` takes the list, as `documentsOn` takes a list of addresses). So a document sent from the mail side still shows when the person starts a direct message.
  **Known gap: a merged contact.** The inbox's merge (`mergeContacts`, `packages/inbox/src/store/store.ts`) deletes the absorbed contact, so a document sent from a contact that is later merged into another carries
  an id no row has any more, and its card disappears from the merged person's conversation until the merge is undone (which restores the contact with its id). **People still lists the document** either way, because it finds
  documents by address. **Not built.** The fix direction: the inbox's people read returns the ids a contact has absorbed (`absorbed: string[]` on `InboxPerson`, read from the merge's audit entries, undone ones left out), and `refsOf` adds
  them as inbox refs, so `documentsIn` finds the document by the old id with no change to forms. Until documents are sent from conversations in volume nothing is hidden by this; it is to be built before they are.
- **A card shows for the conversation it was sent from, not for everyone it is for.** A document sent from Forms to the same person carries no conversation and is not a card; People lists it. This is the rule "its card shows in
  that conversation and nowhere else", and the reason `documentsIn` is its own read and not `documentsOn` with a filter.

## Send for signature is forms' own Send, filled in

The conversation's header links to `/forms/send?from=<the row's key>` (a full page load, like every way into Forms, which renews its day-long sign-in). The Send screen reads `GET /api/conversation/signers?key=`: the person's name and
addresses (the one on the newest mail first, because the row's own order is only alphabetical and a person who moved to a new address would be sent the old; it is the first signer's, the rest are offered for the email box) and the conversation the document will carry. It then makes the draft through forms' own create with the conversation in the body, and everything after
is forms': the email is previewed, and **nothing is emailed until the operator presses Send there**. **Nothing is emailed into the conversation**: forms already emails the signed copy to every party, and the space adds no message.
A channel names no one (meet's contract has a member count and no members), so its signers are for the person to name and the document still belongs to the channel.

Send **refuses to make a document while the conversation it was opened from has not been read**: a document made then would carry no link and show in no conversation, which is the one failure that looks like success.

## The card is forms' summary, drawn

A card is `PersonDocument` (`src/documents.ts`): title, state, counts and one time, the same shape People lists. It has **no field** for a signer's name, an address, a link, an answer or a file's name, so no change to the page can
show one, and a document holding a private answer is drawn exactly as any other, with its title and state. This is how the contract already reads "shows only its title and state" (`forms-for-space.ts`): the summary is the
same for every envelope, and forms' tests pin that a read never touches the tables that hold an answer.

A card sits in the history **at the time it last moved** (completed, else sent, else made), so a document that completes comes back further down as the **same card** saying the signed copy is back. It follows the history's cutoff
like a message (`blocksOf`): a card older than the oldest message shown stays behind "Earlier messages" with what it came after. Today's **Signed and back** opens the conversation a document came from (the row is found by the same stored id), and opens it in Forms when there is no conversation or its row is not in the main list. A document draft is a card too ("Draft, not sent"), so a draft left unfinished is found where it was started.
The documents are read with the conversation (`/api/conversation`), as a part of their own: forms not answering leaves the history as it is with one line saying so, as a part that does not answer does everywhere here.

## The order of the two deploys, and the space with an old forms

Forms deploys first and the space is applied after; each order is safe and the space works with an old forms. The design
points that make it safe are here: `documentsIn` missing from an old forms is a call that throws, which `reach` turns into "could not be reached" (the line above the history); forms' summaries without `conversation` are read as none (the guard takes the
field as optional); and Send, which cannot otherwise tell that an old forms ignored the conversation, looks at the envelope forms made and says the draft is **not linked** (`conversation_app` absent from the answer) instead of moving on as if it were.

## Tests

`packages/forms/test/space-reads.test.ts`: the ref is stored in the envelope's columns only (**in no event: every event is sealed into the PDF each signer receives**, so the finished document and its certificate are tested not to carry it) and shown on the operator's reads; a bad one is refused before anything is stored; `documentsIn` finds the conversation's documents by any ref and no one else's;
a private answer never reaches a summary; no sign-in is refused. `test/documents-in-conversation.test.ts`: the card in its conversation and nowhere else, by time, completed, forms failing, an old forms, Send's reads (the address in use) and their refusals; `test/today.test.ts`: Signed and back opens the conversation.
`test/send-from-conversation.test.tsx`: the Send screen filled in, linked, and honest with an old forms. `e2e/documents-in-conversation.test.ts`: the browser session over forms' real test server (`SPACE_FORMS_URL`, local only, makes
the stand-in's `documentsIn` ask forms' operator API); `e2e/documents-fixtures.test.ts`: the cards at both widths with the fixtures.
