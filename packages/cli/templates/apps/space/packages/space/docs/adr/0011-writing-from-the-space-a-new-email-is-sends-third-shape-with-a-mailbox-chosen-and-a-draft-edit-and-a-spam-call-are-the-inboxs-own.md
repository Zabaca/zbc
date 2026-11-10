# Writing from the space: a new email is `send`'s third shape with a mailbox chosen, and a draft edit and a spam call are the inbox's own

Status: accepted. Builds on
[0004](0004-a-conversation-is-one-history-per-person-and-every-send-carries-a-key-made-once.md) (every send carries a key made once) and on the
contract in `packages/workspace` (`inbox-for-space.ts`, `asking.ts`). The inbox's own screens and its own address are being retired, so
everything the owner does there has to work in the space first. Three things still only existed in the inbox's page: a new email from scratch, a draft's words edited, and a
conversation called spam.

## A new email is `send`'s third shape, not a new method

`send` already had the shape `{ key, address, name?, subject, text }` (a new email to an address, the contact made if new), and the store already decides
a new email's mailbox when the draft is made. It gains two optional fields: `from` and `attachments`. It stays one method with one compose key, one claim, one
draft-then-send path and one set of refusals (an em dash, an address of ours, no subject, no words), so there is no second way for an email to go out that could drift from the first.

**`from` is a mailbox, never an address.** `{ kind: 'gmail' }`, or `{ kind: 'business', mailboxId }` where the id is one the inbox lists (`mailboxes`). The sender is that mailbox's own
address, which the inbox reads from its own table; an id that is none of ours is `bad-request` before a draft or a contact is made, so nothing can be sent from an address that was only typed.
Absent, it is the inbox's rule as before: the mailbox the contact last wrote to (a customer hears from the business mailbox they wrote to, a client from the owner's Gmail), Gmail when none. The space's From box offers
**Automatic** (that rule) beside the explicit choices; it cannot see through the rule, so it offers files only for an explicitly chosen business mailbox.

**Files go from a business mailbox only** (Cloudflare sends them). A new email with files from Gmail, chosen explicitly, is `bad-request` before anything is made; with no choice and a Gmail result, the Mailroom's
own refusal stands and the draft is discarded and the key released, as for a reply. The limits are the contract's (`INBOX_MOST_FILES`, `INBOX_MOST_FILE_BYTES`), written once.

The choice rides on the draft as `DraftInput.sendFrom`, set only by the space's entrypoint after it has verified the owner. The inbox's routes (`POST /api/drafts`) build their input field by field and do not
carry it, so a request body, Claude's script included, cannot choose a mailbox that way. **Claude never sends here:** a service token is refused by the layer's check, and Claude's sending switch is neither read nor changed.

The email a person sends is filed **read and closed** (the inbox files anything its owner sends that way), so after Send the page opens the person's conversation by its address, where it is in the history; it is not in the main list.

**An older inbox must not be trusted to refuse what it does not know.** A `SpaceInbox` from before this change ignores an unknown `from` and `attachments`: it would send the email from the mailbox the contact last wrote to and drop the files, and answer success. A contract that adds optional
fields to a write therefore cannot rely on refusal. The inbox advertises what it can do in an answer the space already reads (`capabilities` on `mailboxes`, which the New email box needs anyway; `INBOX_CAPABILITIES` in the contract), and the space sends a new email that picks a mailbox or carries files only after it has read the capability there, otherwise it
refuses in words and sends nothing. An inbox that cannot be asked is not taken to be able. The same covers an inbox rolled back under a newer space. Methods that do not exist (`editDraft`, `setSpam`) fail on their own ("could not be reached"), so they need no capability.

**A refused new email leaves no contact.** Making a draft to a stranger makes a contact. The contact is noted on the compose key, and discarding the draft of a refused send removes it again unless something has come to hold it (a message, a conversation, a Client, a note).

## A draft edit is the inbox's own, at a revision

`editDraft(assertion, { draftId, rev, subject?, text? })` is `updateDraft` as the owner, with its revision guard: the revision the person was shown is required, and a draft changed since is `conflict` with nothing
saved. The editor edits what the inbox's card edits: the subject, the words and, on a reply, copy everyone (named in the save only when it changed). The card then shows the draft's new subject, who it copies, why it was drafted and its words beside the person's, says who changed it, and offers **Keep mine** (their words stay, now over the revision on screen) or **Use the new words**; until one is chosen Save is not offered, so nothing is
replaced unseen (the inbox's own `DraftConflict`). It carries no compose key: it sets values and names a revision, so a repeat is a `conflict`, never twice applied. It sends nothing: **Send as it stands** waits while the editor is open and
names the revision then shown. An em dash is saved as the inbox's card saves it and the send refuses it in the inbox's words. The draft chat with the assistant is unchanged.

## A spam call is the inbox's own, and says where it left the thread

`setSpam(assertion, { conversationId, spam })` is `setSpam` as the owner: stored on the conversation, deciding over every rule but a Client's people, changing nothing in Gmail, sticking against a later message. A boolean is required, so an empty
request can never mean either. The answer carries where the conversation stands afterwards (`bulk`) and the inbox's "why it is here" lines (`reasons`), read from the inbox's own page of it, so a call that moved nothing visible (a Client's person) says so
instead of claiming it moved. The button is the inbox's: **Mark as spam** over an email thread, **Move to the Inbox** over one in Bulk, none on a text or a note, and none on an Inbox thread of a Client's person.
The button is drawn exactly where the inbox's page draws it, and the inbox says where (`canMarkSpam` on the thread), because the page's rule reads every contact on the conversation and the space sees only the person. The unit is the thread, as in the inbox: a message's thread is what moves.

## What was not done

No Save as draft for a new email (Claude is the drafter; the owner's new email is sent when the owner presses Send), no Cc, no scheduled send, and no new-email shortcut from People. A new email to a person the inbox has never heard of makes a contact named by the name
written around the address, else by the address.
