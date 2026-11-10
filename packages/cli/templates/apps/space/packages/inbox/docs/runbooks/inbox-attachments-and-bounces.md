# Attachments shown and sent, and bounces shown, for the Cloudflare mailboxes: what the deploy changes and what to check after it

The files and delivery reports of the inbox's business mailboxes (`inbox-cloudflare-mailbox.md`). The decision is ADR 0001, decision 25.

## What it gives a person, for the Cloudflare mailboxes only

1. A file that came with a message shows on it: a picture as a thumbnail, any other file as a chip that saves it.
2. A reply from a business mailbox can carry files (an Attach button in the reply box; ten files and 15 MB at most).
3. A reply that Cloudflare says did not arrive says so on that reply, in red, with the receiving server's reason: "Bounced: it did not reach someone@example.org (550 5.1.1 User unknown)". A reply that arrived says "Delivered to ..." quietly.

**What does not change:** Gmail (its pictures show as they did and its other files open in Gmail; the inbox sends no files through Gmail; a bounce arrives as mail), Claude's script, the drafts path, the notification sender, the company layer.

## What the deploy changes

- **One migration (index 13, store version 14), `delivery_event`.** A new table, one row per report Cloudflare publishes about a message the inbox sent. It touches no existing table. **It is one-way**: a Worker with fewer migrations than the store refuses it ("a version from the future"), so rolling the code back alone does not work after the first request. Rolling back is either a restore to the bookmark taken before the deploy (below), or a build of the old code that still carries both this migration and the one before it (`INBOX_MIGRATIONS` as it is on this version), which leaves the table in place unused. The migration cannot be avoided: a report can arrive before the reply it is about is filed, so the reports need a store of their own. **The inbox deploys only from the main line, in list order, never from a branch worktree**: a build whose list lacks an entry the live store already has would run that entry's column additions again against the live store and take the inbox down.
- **A queue consumer.** The Worker's default export has `queue()` and the Worker's settings name the queue it consumes (`queues.consumers`: batches of up to 10 or 5 seconds, three tries, no dead-letter queue). The queue and the event subscriptions are an infra instance of the **separate `queue` module** (`inbox-delivery` in the invented install's naming), not of the cloudflare module: that module only runs `wrangler deploy`, and wrangler attaches a consumer to a queue that must already exist, so something has to make the queue first (as the `r2` module does for the bucket). The space's instance imports it, so an apply of the space makes the queue first. The install file names the queue once, and the kit makes both the instance and the Worker's consumer from that name (renaming it leaves the consumer attached to a queue nothing fills). The subscriptions are one per sending domain, each for all six kinds of report (delivered, deferred, bounced, failed, rejected, complained).
- **Sending carries files.** The `send_email` binding's `attachments` (Cloudflare's structured form: `content`, `filename`, `type`, `disposition`) are filled from the files chosen. Each file is also kept as its own object beside the copy of the sent request, `out/<message id>/<n>` in the raw-mail bucket, so the sent message can give it back.
- **Files come back from the kept copy.** For mail that arrived, the file is read out of the raw copy (`in/<hash>`) again when it is asked for; nothing is stored of it. **A message whose raw copy is over 10 MB cannot have its files opened** (see Memory below): it still arrives, is kept whole and is listed, but each file is shown by name only, and its tooltip says "This message is too large for the inbox to open its files. The whole message is kept."; there is no thumbnail and nothing to save, and an old link is refused in the same words. The whole message is still in the bucket for the owner to read. A file in a message the inbox SENT is its own object and is always given back. Only the owner is given one, through the space (the part's `attachment`, behind the space's sign-in). A picture is shown only after its first bytes say PNG, JPEG, GIF or WebP, as the type they name; everything else is a download served as `application/octet-stream` with `nosniff` and a policy that lets it do nothing in the page. Nothing is a public address, and Claude's token is refused a file from a Cloudflare mailbox.
- **No new secret, var, binding, route, hostname or Access application.**
- **Not changed:** the entrance, the raw copy of every arriving message, the spam check, the assistant, the compose keys.

## The queue, and what it costs

**Which product:** Cloudflare Queues, with Email Sending's **event subscriptions** (a Queues feature: Cloudflare products publish events to a queue you own). It is Cloudflare's own way to learn that a message bounced: the binding's `send()` returns only an id, so there is no other way to see a later bounce. Cloudflare's pages to read: `/email-service/platform/event-subscriptions` and `/email-service/reference/event-subscriptions` (events, payloads), `/queues/platform/pricing` and `/queues/event-subscriptions/manage-event-subscriptions`.

**What it costs, from those pages:**

| Item | Cloudflare's statement | At small volume |
|---|---|---|
| Queues operations | Included on Workers Paid: 1,000,000 a month, then $0.40 per million. An operation is a write, a read or a delete of up to 64 KB; "in most cases, it takes 3 operations to deliver a message"; a retry is one more read. No egress or bandwidth charge. | Each report is about 3 operations. A reply to one person is one report (two with a delay). Replies of a few mailboxes are tens a month: a few hundred operations against a million included. **$0.** |
| Event subscriptions | No charge of their own on the pages read. | **$0**, as far as the pages say. Unverified beyond them: the first bill is the proof. |
| The consumer | Part of the space's Worker (no Worker of its own). | **$0** extra. |
| Workers Paid itself | $5 a month; the sending binding needs it. | **$0** extra. |
| R2 (the sent files) | 10 GB-month free then $0.015 per GB-month; 1 million writes free then $4.50 per million; egress free. | A few small files a month. **$0.** |

**The thing that could move the number:** a subscription is per sending DOMAIN, so it also carries every other message sent from that domain (a site's own mail, a form). The inbox drops what is not from a declared mailbox's address, but Cloudflare still counts the delivery into the queue. At 10,000 such messages a month that is 30,000 operations, 3% of the allowance. To watch it: the Queues page for the delivery queue shows messages per day.

**Plan note:** Queues also has a free tier (10,000 operations a day) with a retention of 24 hours. Workers Paid retains an undelivered message 4 days, so a Worker that was down for a deploy still gets its reports.

**To decide at deploy time:** whether to apply the queue instance at all. Without it the Worker would be deployed without the queue it names, which `wrangler deploy` refuses; so "no queue" means the consumer stanza is removed from the Worker's settings first (the page then shows files and sends files, and says nothing of bounces).

## Before the apply

1. **A bookmark.** Settings, Restore (or `bun scripts/inbox.ts bookmark`): write down the current bookmark and the time. The migration is one-way, so this is the way back (`inbox-cloudflare-mailbox.md`, "Backups of the store, and restoring it").
2. **The counts:** `bun scripts/inbox.ts mailbox`, `mailboxes` and `drafts`. Write them down in the same sitting.
3. **The deploy token's scopes.** The token needs Queues Edit: it lists queues, creates and deletes a queue, and lists event subscriptions. What is first proven at the real apply is *creating* an event subscription; if that step is refused for a permission, widening the deploy token is the operator's decision.
4. **Order with other migrations:** this build adds index 13 after the one before it. Deploy it from the main line after it is merged. The inbox's tests pin the list's length.

## Apply

`bunx @zabaca/zbc apply <env> space` (the named instance; it applies the queue instance first, which makes the queue and the subscriptions, then builds and deploys the Worker). Never a no-argument apply.

## What to check after the deploy

1. **Counts unchanged.** The same `mailbox`, `mailboxes` and `drafts` readings as before. The migration added an empty table and nothing else.
2. **The queue and its subscriptions are there.** `bunx wrangler queues info <queue>` shows the space's Worker as the consumer; `bunx wrangler queues subscription list <queue>` shows one subscription per sending domain, each with the six events. **If the event names are listed with a prefix (`cf.email.sending.message.bounced`) and the apply wrote the short ones, or the reverse,** the queue instance's `events` take the other form and it is applied again; the queue module says why the short form was written first.
3. **Mail still arrives, and nothing else moved.** A message to a business mailbox shows under it within a minute; Claude's script reads and drafts; the space's doors are shut from outside.
4. **The Worker is a consumer.** `bunx wrangler tail <space worker> --format pretty` while check 6 runs: a line `delivery reports: 1 handed over, 1 kept, 0 repeated, 0 not ours, 0 matching no sent message` appears within a minute of the send. Read it like this: nothing appears, the subscription or the queue is the trouble (check 2); `not ours` is above 0 and `kept` 0, the report's sender is not one of the declared mailboxes' addresses; `matching no sent message` is above 0 a minute after the send was filed, **Cloudflare's report names a different id from the one the binding returned**, which is the one assumption in this build that nothing could prove (below).
5. **A file shows and saves (no send needed).** From the owner's own address, email a business mailbox a small picture (a screenshot) and a PDF. In the space the message shows the picture as a thumbnail and the PDF as a chip. Clicking the picture opens it full size in a new tab; clicking the chip saves the PDF, and it opens.
   - **Claude's token gets nothing either:** the script has no command for a file, so check with a request: the message's attachment address with Claude's service token returns 403 ("Only a person opens a file that arrived in a Cloudflare mailbox"), and with the owner's session returns the picture.
   - **The same address, signed out:** copy the picture's address (right click, Copy image address), paste it in a private window: it asks for the sign-in code and shows no file.
6. **The real send (the owner's instruction; a real email goes out from the mailbox; Claude never runs this).** In the conversation from check 5, in the space, write "Thank you, got both. Test of attachments.", attach a small PDF (Attach files) and press Send. This goes **from the business mailbox's address to the owner's own address** (the one that wrote), with the PDF attached. Expected, in this order:
   1. The reply box says "Sent." and the message appears on the right with the PDF's chip under it.
   2. In the owner's own mail it arrives from `<Name> <the mailbox address>` with the PDF attached, and the PDF opens. In the message's headers, Message-ID is Cloudflare's own and `Authentication-Results` shows SPF, DKIM and DMARC passing (the first thing to look at if it lands in spam).
   3. Within about a minute, under the sent message in the space: "Delivered to <the owner's address>". (If it never appears, check 4's line says which of the three it is.)
   4. Click the sent message's PDF chip in the space: it saves the same file back (the kept copy, `out/<id>/0`).
   - **If Cloudflare refuses the attachments:** the reply box says so in Cloudflare's words (the codes the inbox maps are `E_TOO_MANY_ATTACHMENTS`, `E_CONTENT_TOO_LARGE`, `E_VALIDATION_ERROR`), nothing is sent and the draft is still a draft. The same send without the file is the control.
7. **A bounce.** This one needs a recipient address that rejects mail: write to the mailbox from an address that exists now and will not later (a throwaway address at a free mail provider, deleted afterwards, or one already closed), reply from the space and wait. Expected under the reply, in red, a minute or so after a hard bounce: "Bounced: it did not reach ... (550 5.1.1 ...)". If you would rather not, this check waits for the first real bounce and nothing else depends on it; the tests prove the code path (`test/files-and-reports.test.ts` in the inbox, `test/files.test.ts` and `files-view.test.tsx` in the space) and not Cloudflare's side of it.

## What was assumed and could not be tried

- **That the id the binding returns is the id the reports name.** The inbox files a sent message under the id `send()` returns and matches a report by `payload.messageId` with or without angle brackets. Cloudflare's pages show a report's `messageId` and the binding's `messageId` and do not say they are the same string. Check 4 reads it.
- **The event names a subscription takes** (`message.bounced` or the prefixed form): wrangler's flag takes the short form in the examples read; the REST body was read from wrangler's own client and not run (check 2).
- **That a subscription on the zone's apex covers mail sent through the binding.** Each zone onboards the apex as its sending domain, and the docs say a subscription is scoped to "the zone apex or a verified sending subdomain".
- **That `attachments` takes a `Uint8Array` as `content`.** Cloudflare's page lists `string | ArrayBuffer | ArrayBufferView`. Check 6 is the proof; if it refuses, the fix is one line in `bindingSender` (base64 text).
- **Memory.** Opening a file of a message that arrived parses the whole message in the Durable Object, which is the whole inbox in a 128 MB heap. A parse was measured in Bun at roughly 120 MB for a 22 MB message of four phone photos (about 5.5 times the message). So the inbox opens a file only from a message whose raw copy is **10 MB or less** (about 55 MB for one parse), takes the reads **one at a time** on a chain of their own (not behind syncs), and checks the stored object's size before it reads a byte. The 10 MB and the one-at-a-time are tested against fakes; the heap in the real runtime is not measured, so the first big message opened is the check.

## Rollback

- **The code alone does not roll back** (the migration is one-way). To undo the deploy: Settings, Restore, to the bookmark taken before it (two steps; the second acts), then redeploy the build that was live before (it opens a store at the earlier version). **If the store is NOT restored**, the undo build must be one that keeps both migrations (this one at index 13 and the one before it at index 12) in `INBOX_MIGRATIONS`: old code, same list. Never a checkout that drops an entry the live store already has. Mail that arrived between the deploy and the restore is gone from the store but its raw copy stays in the bucket (`in/<hash>`, nothing deletes it), so a restore is better done soon after the deploy than late. Sent mail is not lost either way (it is the recipient's, and `out/<id>` holds what was sent).
- **Only the bounces off:** remove `queues` from the Worker's settings and deploy. Files still show and send; reports stop arriving and the table stays as it is.
- **The queue and subscriptions:** `bunx @zabaca/zbc destroy <env> <queue instance>` removes the subscriptions and leaves the queue (it may hold messages); delete the queue by hand when empty.

## Where the code is

`src/delivery.ts` (reading a report; one note per recipient), `src/cloudflare/arrivals.ts` (`keepDeliveryEvents`), `src/cloudflare/send.ts` (`cleanFiles`, `buildOutgoing`), `src/gmail/mailroom.ts` (`readAttachment`, `readKept`, `sendViaCloudflare`), `src/space.ts` (`attachment`, the reply's files), `src/store/store.ts` (`keepDeliveryEvent`, `withDelivery`), all in the inbox package. The contract is the company layer's `src/inbox-for-space.ts`; the queue module is the install's `queue` module (`modules/queue/`) and its instance file.
