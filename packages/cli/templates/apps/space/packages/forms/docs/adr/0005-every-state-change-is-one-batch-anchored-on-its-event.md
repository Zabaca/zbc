# Every state change is one batch, and every statement in it hangs on its event

Status: accepted.

Every transition is guarded in the database, so two signers finishing at once complete the envelope once, and
every state change writes exactly one event. D1 gives one tool for this: a batch is one transaction. The problem is
making each statement of a change depend on the state the change expected, when some of those statements move that state on.

**The rule.** A change is `appendEvents(db, envelope, events, { changes, whenStatus, whenRecipient })` in `src/events.ts`.
The events are inserted first, each `INSERT ... SELECT ... WHERE` the envelope still has one of the statuses the change expects
(and, for a signer's own step, the recipient is still in the expected state). Every other statement of the change is built from
the first event's sequence number and hash (`Guarded.onEvent`, `src/signing/support.ts`) and runs only `WHERE EXISTS` that event row.
So the guard is tested once, in one place, and a statement that flips the envelope's status or the recipient's cannot hide the
state another statement was guarded by, which an order of statements would have had to be careful about. The loser of a race
inserts no event, so none of its statements changes anything, and `appended.applied` is false: the caller says the step already
happened and sends no mail.

**What it covers.** Send, remind, cancel, correct a recipient, the form path's prepare, a signer's open, consent, adoption,
finish and decline, the move to sealing and to completed, and expiry. Saving a field value as a signer goes is a draft and
writes no event; it carries the envelope-status guard and requires the recipient to still be `consented` (`Guarded.onState`).

**Races it has to survive, each tested.** Two signers finishing at once (one `sealing`, one `completed`); one signer pressing
Finish twice (one `signed`); many writers for the same place in a chain (the sequence trigger refuses all but one, which
retries from the new tail); one instruction used by two requests (a primary key in `instruction_uses`). The e2e suite repeats
them in workerd over real D1, where the triggers are D1's own.

**Cost.** A change's statements are built inside a function that is called again if the sequence number was taken, so it
must be free of side effects other than building statements; mail ids are collected there and sent after the batch lands.
A statement that needs a value computed with `await` (an encrypted token, a hash) computes it before the batch.

**Also conditioned on the log.** An agent's send is recorded against the draft as it stood, so `appendEvents` takes `whenTail`:
the write lands only if the log still ends at the sequence number read before the draft's fingerprint was taken. A draft edit
is an event, so an edit between the check and the batch stops the send (and `send` says so), with nothing emailed.

**What the PDF prints.** The certificate and the attached `events.json` end at the `sealing` event, and the chain link printed
in the document is that event's hash. The `completed` event records the finished file's own hash, so it cannot be inside the file;
a tombstone keeps the chain's final hash, which is later in the same chain. A purge writes no event, because it deletes the events
in the same batch; the tombstone is the record.
