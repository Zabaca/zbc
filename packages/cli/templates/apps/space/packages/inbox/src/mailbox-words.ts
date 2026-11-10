/**
 * What the inbox says when a person is refused for a mailbox that is not theirs (the inbox's ADR 0004): a person sends only from the mailboxes they are on. Unlike the
 * sentences of owner-words.ts these name nobody: they say nothing of who runs the install or who else is on a mailbox, which is not the person's to learn. Nothing is sent and the draft is left as it was.
 */

/** A send of a draft or a thread in a mailbox the sender is not on. */
export const notOnThatMailbox = (): string => 'You are not on the mailbox this would go out from, so nothing was sent.'

/** A new email by a person who is on no mailbox it could go out from. Nothing is drafted. */
export const noMailboxToSendFrom = (): string =>
  'You are not on a mailbox a new email can go out from. Nothing was drafted.'
