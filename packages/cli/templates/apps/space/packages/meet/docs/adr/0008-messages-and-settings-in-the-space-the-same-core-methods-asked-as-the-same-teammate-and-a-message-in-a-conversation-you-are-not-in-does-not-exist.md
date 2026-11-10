# Messages and a person's own settings in the space: the same core methods asked as the same teammate, and a message in a conversation you are not in does not exist

Status: accepted. The second step of retiring `/start`. Builds on [0007](0007-channel-admin-in-the-space-the-same-rules-asked-as-the-same-teammate-one-email-once-per-key.md) (channel admin, the same shape) and [0003](0003-workspace-one-object-two-doors-live-sockets-emailed-codes.md). The space's side is [packages/space ADR 0013](../../../space/docs/adr/0013-messages-and-settings-in-the-space-chat-is-meets-answer-drawn-where-the-conversation-is.md); the contract is `packages/workspace/src/meet-for-space.ts` ("Messages and a person's own settings").

## What was decided

**Six more methods on `SpaceMeet`, each the core's own method called as the teammate who is asking** (`{ via: 'access', email }`, what the teammates' door builds), so `/start`'s rules and words are not written a second time:

| Method | The core's | What it adds |
|---|---|---|
| `peopleToMessage` | `openDm`'s rule, listed | active people the asker may open a direct message with now (any teammate, a guest who shares a channel, anyone with a direct message already), and whether that direct message has something in it |
| `editMessage` | `edit` | the scoping below |
| `deleteMessage` | `deleteMessage` | the scoping below |
| `me` | `meView` | the asker's own settings |
| `updateMe` | `updateMe` | a boolean `nudgesOff` or a refusal; a patch that changes nothing is refused |
| `acknowledgePrivacy` | `ackPrivacy` | the settings as they now stand |

**A first direct message is not a new write.** `post` already takes a `personId` and opens the direct message as it posts, once per compose key, and refuses before it writes (the text, the rate limit, a person the asker may not write to), so a refused first message opens no conversation and releases its key. `peopleToMessage` is only the list the space draws; the rule it lists by is `openDm`'s, and `post` is the one place it is applied.

**Scoping is tighter than the core, never looser.** The core's `edit` and `deleteMessage` answer "no such message" for a message that is not there and "no such conversation" for one in a conversation the asker is not in. The two words tell a teammate which message numbers exist in a private channel, and an owner could delete in a channel they were in only because the core asks `mine`, not because anything told them it was there. The space's methods answer one refusal, `not-found`, "There is no such message.", for a missing message, one in a conversation the asker is not in (the owner is no exception), an archived one, and one in the Phone conversation (a voicemail is deleted through the phone, which deletes its sound first). Everything past that gate is the core's, in its words: "You can edit only your own messages.", "A message cannot be empty. Delete it instead.", "A message is at most 2,000 characters.", "You can delete only your own messages."

**`nudgesOff` must be a boolean.** `updateMe` reads anything that is not `true` as "off", so a malformed body would quietly switch the nudge email back on. The space's method refuses it (`bad-request`) and the space's own parser refuses it before meet is asked.

**What the page may draw is meet's word.** Every `MeetMessage` carries `may: { edit, delete }`, from the rules `edit` and `deleteMessage` apply: your own is edited and deleted, the owner deletes another's, and **a huddle's announcement is a message like any other**, as it was at `/start` (its pane offered Edit and Delete on it). An earlier draft left huddle announcements out because the space draws one as its card; but once `/start` is gone nothing else could delete one, and the core allows it. A huddle's message whose card the space cannot draw (an older huddle, or one the person may not see) is drawn as the message, with its buttons; one drawn as a card has none to press. It is optional in the contract so an older meet is drawn without buttons. The core still refuses a press the page should not have offered.

**The writes carry no compose key, and say why.** Editing to the same words, setting a setting and acknowledging a note are the same once as twice; deleting twice is a refusal (`not-found`) the second time; none of them creates anything or sends anything. They are writes all the same: a fault after the object committed is **thrown across the binding, never answered `broken`**, so the space says "outcome unknown" and never reports a committed change as not done (`unknownIsThrown`, as `changeChannel`). No revision guard either: `/start` had none (a later edit wins), and an edit is the author's own message.

**No email.** The 15-minute nudge is meet's, on its own timer; `updateMe` only says whether it is wanted. The contract's test pins that no new method is named for an email, and the tests that none sends one.

## What was not decided here

The member list's **Message** button is still offered only where a direct message with something in it exists (the new "New message" in the list covers the first one). The privacy note's first-visit prompt (`/start` asked guests only) is not drawn in the space: a teammate reads it, and acknowledges it, in Settings, Chat.
