import type { EmailSender } from './cloudflare/send'
import { type DevFile, devFiles } from './dev-attachments'
import type { GmailApi, GoogleAuth } from './gmail/google'
import type { GmailMessage, ParsedMessage } from './gmail/types'
import type { PushPort } from './notify/deliver'
import { inboxOwnerOf } from './owner'
import type { MailStore } from './store/mail'
import type { InboxSql } from './store/schema'
import type { SpaceStore } from './store/space'
import { AGENT_PREFIX, ASSISTANT_ACTOR, type MessageRow } from './types'
import { bundledInstall } from './workspace'

/** The dev seed's owner is the install's: the seeded mail is the owner's own. */
const { email: OWNER_EMAIL, mailName: OWNER_NAME } = inboxOwnerOf(bundledInstall)

/**
 * EVERYTHING HERE IS FOR `vite dev` AND NOTHING ELSE. durable.ts imports this file (statically for
 * DEV_GOOGLE, dynamically for the seed) but every USE of it sits under `import.meta.env.DEV`, a build-time
 * constant that is false in everything `vite build` produces (the same guard the dev identity and the dev
 * Client directory have). The bundler therefore drops the uses and, with them, this module, which is
 * checked two ways: test/worker-exports.test.ts reads durable.ts and requires a DEV guard at each use, and
 * the built Worker holds none of this file's text (grep dist for `dev-seed` after `bun run build`).
 *
 * It exists so a worktree, which has no Google and none of Tessa's mail, can show the app with
 * something in it: `POST /__dev/seed` fills the local store with SYNTHETIC conversations (every
 * sender address is on a `.example` or `.test` domain, every name is made up), and a stand-in Google lets
 * opening, Close and Reopen work against that store. It reads nothing and sends nothing anywhere.
 */

/**
 * A push service that is not one: it answers every notification 201 and logs which message went to which device,
 * never calling Google's (or anyone's) push service. In dev a browser can turn notifications on (its subscription is a
 * real one at Google's push service), and nothing the dev server does may reach that address.
 */
export const DEV_PUSH: PushPort = {
  send: async (endpoint) => {
    console.log(
      `dev push: a notification to ${new URL(endpoint).hostname} was not sent (dev never calls a push service)`,
    )
    return { status: 201 }
  },
}

/**
 * Cloudflare's sending binding, as something that is not one: it accepts every message, logs that it did not send it, and
 * answers an id, so a reply on a Cloudflare conversation can be tried in dev. It never reaches Cloudflare.
 */
export const DEV_EMAIL: EmailSender = {
  send: async (message) => {
    console.log(`dev email: a message from ${message.from} to ${message.to} was not sent (dev never sends)`)
    return { messageId: `dev-${Date.now()}@dev.invalid` }
  },
}

/**
 * A Google that is not one: it holds no mail and accepts every change a person makes, so that read,
 * Close and Reopen and a send reach the store the way they would with Gmail's yes. It never touches
 * a network. Without it a conversation with a thread cannot be changed in dev at all (the Mailroom
 * refuses with "Gmail sign-in is not set up").
 */
export const DEV_GOOGLE: GoogleAuth = {
  exchangeCode: async () => {
    throw new Error('There is no Google in dev, so nothing can be connected.')
  },
  accessToken: async () => {
    throw new Error('There is no Google in dev, so there is no access token.')
  },
  revoke: async () => true,
  gmail: (): GmailApi => {
    let sent = 0
    return {
      getProfile: async () => ({ emailAddress: OWNER_EMAIL, historyId: '500' }),
      listMessageIds: async () => ({ ids: [], next: null }),
      // A seeded message with files is read back as Gmail would give it (the picture route asks); every other is gone.
      getMessage: async (id) => devGmailMessage(id),
      getAttachment: async (messageId, attachmentId) => {
        const [, index] = attachmentId.split(':')
        return attached()[messageId]?.[Number(index)]?.bytes ?? null
      },
      listHistory: async () => ({ history: [], nextPageToken: null, historyId: '500' }),
      // "Gmail has no such thread": the Mailroom then applies the change here, as it does for a thread Gmail lost.
      getThreadLabels: async () => null,
      watch: async () => ({ historyId: '500', expiration: new Date(Date.now() + 7 * DAY).toISOString() }),
      stop: async () => {},
      changeThread: async () => {},
      sendMessage: async (_raw, threadId) => {
        sent += 1
        return {
          id: `dev-sent-${Date.now()}-${sent}`,
          threadId: threadId ?? `dev-thread-${Date.now()}-${sent}`,
          labels: ['SENT'],
        }
      },
    }
  },
}

/**
 * The files on the seeded messages that have any, by Gmail id. Fixed ids (and not the counter's) because the stand-in
 * Google above must answer for them without sharing state with the seed: the Durable Object may run either in a
 * different isolate from the page's request.
 */
const attached = (): Record<string, readonly DevFile[]> => {
  const files = devFiles()
  return {
    'dev-att-marta': [files.png],
    'dev-att-rhea': [files.jpeg, files.gif, files.svg, files.pdf, files.htmlAsPng],
  }
}

/** What the stored attachment list says about seeded files: name, size and the type declared. */
const infoOf = (files: readonly DevFile[]) =>
  files.map((f) => ({ name: f.name, size: f.bytes.length, mimeType: f.mimeType }))

/** The seeded message `id` as `messages.get?format=full` would give it, or null when it has no files (the others are not there). */
function devGmailMessage(id: string): GmailMessage | null {
  const files = attached()[id]
  if (!files) return null
  return {
    id,
    threadId: id,
    payload: {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { size: 0, data: '' } },
        ...files.map((f, i) => ({
          mimeType: f.mimeType,
          filename: f.name,
          body: { size: f.bytes.length, attachmentId: `${id}:${i}` },
        })),
      ],
    },
  }
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const AGENT = `${AGENT_PREFIX}dev-seed`

let counter = 0

/** A message as Gmail's parser leaves it, with only what a case needs said. */
function message(at: number, over: Partial<ParsedMessage> & Pick<ParsedMessage, 'threadId'>): ParsedMessage {
  counter += 1
  const from = over.from ?? { name: 'Someone', address: 'someone@example.test' }
  const to = over.to ?? [{ name: OWNER_NAME, address: OWNER_EMAIL }]
  const header = (p: { name: string; address: string }) => (p.name ? `${p.name} <${p.address}>` : p.address)
  return {
    gmailId: `dev-g${counter}`,
    rfcMessageId: `<dev-${counter}@${from.address.split('@')[1]}>`,
    inReplyTo: null,
    from,
    to,
    cc: [],
    fromHeader: header(from),
    toHeader: to.map(header).join(', '),
    ccHeader: '',
    replyToHeader: '',
    subject: 'Hello',
    snippet: '',
    body: '',
    bodyTruncated: false,
    attachments: [],
    labels: ['INBOX'],
    receivedAt: new Date(at).toISOString(),
    senderDate: new Date(at).toISOString(),
    listUnsubscribe: false,
    ...over,
  }
}

/** Greedy word wrap at `width`, as a sender's client writes the plain-text copy of what it composed (see reflow.ts). */
function wrapped(paragraph: string, width = 76): string {
  const lines: string[] = []
  let line = ''
  for (const word of paragraph.split(' ')) {
    if (line !== '' && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else line = line === '' ? word : `${line} ${word}`
  }
  lines.push(line)
  return lines.join('\n')
}

const tessa = { name: OWNER_NAME, address: OWNER_EMAIL }
const mine = (at: number, threadId: string, to: { name: string; address: string }, subject: string, body: string) =>
  message(at, { threadId, from: tessa, to: [to], subject, body, snippet: body.slice(0, 100), labels: ['SENT'] })

function must<T>(r: { ok: true; value: T } | { ok: false; error: string }, what: string): T {
  if (!r.ok) throw new Error(`dev seed: ${what}: ${r.error}`)
  return r.value
}

/**
 * Fill an empty store: a connected, live mailbox and synthetic conversations covering what the
 * workspace shows. Unread, Bulk, closed, a Claude send with its instruction, a Claude draft and
 * a Tessa draft (and a second draft on one conversation, and a Reply-To that is not the sender), a draft on
 * no conversation, a Client suggested by sign-in address and another by domain, two contacts with one
 * name, an unsubscribe-named contact and a no-reply sender, a leads@ mailbox that is a person, an all-Bulk hello@ sender and a
 * Bulk billing@ mailbox under a Client (a person), a send Gmail never confirmed, and Ridgeway's Cloudflare mailbox
 * with people writing in (one judged by Clef as a customer, one not judged), a closed one, an unsubscribe-header newsletter and
 * promotion, and a message Clef scored as spam. Times are
 * relative to `now`, so "today" and "this week" are true.
 */
export function seedDevInbox(store: SpaceStore, sql: InboxSql, now = Date.now()): void {
  const ago = (ms: number) => now - ms
  const mailbox = store.connectMailbox(
    { address: OWNER_EMAIL, refreshToken: 'dev-not-a-token', scopes: ['dev'], historyId: '500', query: 'dev' },
    OWNER_EMAIL,
  )

  const delphine = { name: 'Delphine Barlow', address: 'delphine@castmic.example' }
  const marta = { name: 'Marta Vidal', address: 'marta@tamarackprint.test' }
  const nils = { name: 'Nils Varga', address: 'nils@tamarackprint.test' }
  const martaYahoo = { name: 'Marta Vidal', address: 'marta.vidal@yahoo.example' }
  const olive = { name: 'Olive Owner', address: 'owner@example-machines.test' }
  const rhea = { name: 'Rhea Lang', address: 'rhea@brightpath.test' }
  const sam = { name: 'Sam Counsel', address: 'sam@samplelegal.test' }
  const pat = { name: 'Pat Partner', address: 'pat@samplelegal.test' }
  const bright = { name: 'Dr. Bright', address: 'doc@brightwater.test' }
  const gareth = { name: 'Gareth Kovic', address: 'gareth@travelco.example' }
  const bao = { name: 'Bao Tran', address: 'bao@invoices.example' }
  const unsub = {
    name: 'unsubscribe+9f8e7d6c5b4a3210@bounces.customer.io',
    address: 'unsubscribe+9f8e7d6c5b4a3210@bounces.customer.io',
  }
  const quickbooks = { name: 'QuickBooks', address: 'noreply@quickbooks.example' }
  const paddle = { name: 'Paddle Receipts', address: 'no-reply@paddle.example' }
  const github = { name: 'GitHub', address: 'notifications@github.example' }
  // The cases the rule for automated senders must get right: a leads@ mailbox people answer from (a person), a
  // hello@ mailbox that only ever sent Bulk (automated, by that and not by its name), and a billing@ mailbox whose
  // mail is Bulk but which sits under a Client (a person, always).
  const leads = { name: 'leads@pinecrest.example', address: 'leads@pinecrest.example' }
  const orbit = { name: 'Orbit Team', address: 'hello@orbit.example' }
  const machinesBilling = { name: 'Example Machines Billing', address: 'billing@example-machines.test' }

  const inbound = (
    at: number,
    threadId: string,
    from: { name: string; address: string },
    subject: string,
    body: string,
    over: Partial<ParsedMessage> = {},
  ) => message(at, { threadId, from, subject, body, snippet: body.slice(0, 100), ...over })

  const unreadLabels = ['INBOX', 'UNREAD']
  store.applyJobStep({
    mailboxId: mailbox.id,
    kind: 'fill',
    cursorAfter: '500',
    messages: [
      // The Inbox, newest first as the list will show it.
      inbound(
        ago(2 * HOUR),
        't-delphine',
        delphine,
        'Guest spot - Tessa',
        'Hi Tessa, we would love to have you on the show next month. Would a 30 minute conversation about small business websites work for you? Any Tuesday morning is open on our side.',
        { labels: unreadLabels },
      ),
      inbound(
        ago(3 * DAY),
        't-marta',
        marta,
        'Re: Changes to the site after our call',
        'Hi Tessa, thank you for meeting yesterday. Could you take the spring sale banner off the home page for us? I attached a picture of the page.',
        { gmailId: 'dev-att-marta', attachments: infoOf(attached()['dev-att-marta'] ?? []) },
      ),
      mine(
        ago(3 * DAY - HOUR),
        't-marta',
        marta,
        'Re: Changes to the site after our call',
        "Hi Marta,\n\nWill do. The banner comes down this afternoon.\n\nBest,\nTessa",
      ),
      inbound(
        ago(1 * DAY),
        't-marta',
        marta,
        'Re: Changes to the site after our call',
        // Ends with the email it answers quoted, as Gmail writes it, so the conversation view has a quote to fold.
        [
          'Thanks! Also, the phone number at the top of the page is the old one. The new one is 626-555-0147.',
          '',
          'Marta',
          '',
          'On Mon, Mar 2, 2026 at 3:40 PM Tessa Marlow <tessa@northfield.example> wrote:',
          '',
          '> Hi Marta,',
          '>',
          "> Will do. The banner comes down this afternoon.",
          '>',
          '> Best,',
          '> Tessa',
        ].join('\n'),
      ),
      // A body the sender's client hard-wrapped at 76 characters, with a list, an address and a signature that are not
      // wraps, so the conversation shows what the display-only reflow joins and what it leaves.
      inbound(
        ago(4 * HOUR),
        't-rhea',
        rhea,
        'Re: Pages for review',
        [
          'Hi Tessa,',
          '',
          wrapped(
            'Thanks for sending the first round of the pages. I went through them twice and most of it is exactly what we wanted, especially the new header and the way the services are laid out one under the other.',
          ),
          '',
          wrapped(
            "And when a photo is swapped for a new one, should the old one be deleted for good, or kept in a folder? I would rather keep the old wording in case the client asks for it back next month.",
          ),
          '',
          'Before Friday I still need:',
          '- The final logo files',
          '- Photos of the storefront',
          '- The opening hours',
          '',
          'Please ship the proofs to:',
          'Rhea Lang',
          'Brightpath Dental',
          '1234 Colorado Blvd, Suite 200',
          'Springfield, CA 91101',
          '',
          'Thanks,',
          'Rhea',
          '',
          '-- ',
          'Rhea Lang, Office Manager, Brightpath Dental, a member of the California Dental Association since 1998',
          'Tel 626-555-0163',
        ].join('\n'),
        { labels: unreadLabels, gmailId: 'dev-att-rhea', attachments: infoOf(attached()['dev-att-rhea'] ?? []) },
      ),
      inbound(
        ago(9 * HOUR),
        't-olive',
        olive,
        'Question about my plan',
        'Hello, I signed up last week but I am not sure my payment went through. Can you check on it?',
        // Asks for replies elsewhere, so a reply to it shows the Reply-To sentence before Send.
        { labels: unreadLabels, replyToHeader: 'Olive Owner <office@example-machines.test>' },
      ),
      inbound(
        ago(2 * DAY),
        't-sam',
        sam,
        'Agreement signed',
        'Hi Tessa, we signed the agreement this morning. What happens next?',
      ),
      inbound(
        ago(2 * DAY + 2 * HOUR),
        't-pat',
        pat,
        'Logo files',
        'Hi, Sam asked me to send the logo files. They are linked in the shared folder.',
      ),
      inbound(
        ago(15 * DAY),
        't-gareth',
        gareth,
        'Invitation: Tessa Marlow @ Wed Oct 7, 2026',
        'Gareth Kovic has invited you to a call on Wednesday October 7 at 10:15am. Join with the link below.',
        { labels: unreadLabels },
      ),
      inbound(
        ago(4 * DAY),
        't-yahoo',
        martaYahoo,
        'Invoice question',
        'Hi Tessa, quick question about last month: was the invoice for the full amount or the deposit?',
      ),
      inbound(
        ago(26 * HOUR),
        't-nils',
        nils,
        'Domain renewal',
        'The domain renews next month. Please keep it on the same card.',
      ),
      inbound(ago(5 * DAY), 't-bright', bright, 'Re: New customer form', 'Can the form ask for a phone number too?'),
      // Bulk: a newsletter's unsubscribe address, a promotion, a receipt, a notification.
      inbound(ago(5 * HOUR), 't-news', unsub, 'Your weekly digest is ready', 'Here is what happened this week.', {
        labels: [...unreadLabels, 'CATEGORY_UPDATES'],
        listUnsubscribe: true,
      }),
      inbound(ago(3 * HOUR), 't-qb', quickbooks, 'Your invoice is ready', 'Invoice 1042 is ready to view online.', {
        labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
      }),
      inbound(ago(30 * HOUR), 't-paddle', paddle, 'Payment receipt', 'Thanks for your payment of $40.00.', {
        labels: ['INBOX', 'CATEGORY_UPDATES'],
      }),
      inbound(
        ago(6 * DAY),
        't-gh',
        github,
        '[GitHub] A third-party application was added',
        'A new app can reach your account.',
        {
          labels: ['INBOX', 'CATEGORY_UPDATES'],
          listUnsubscribe: true,
        },
      ),
      inbound(
        ago(7 * HOUR),
        't-lead',
        leads,
        'New website lead: roof repair',
        'A visitor asked for a quote on a roof repair in Springfield. Phone 626-555-0188.',
      ),
      inbound(ago(20 * HOUR), 't-orbit', orbit, 'Product news for October', 'See what is new at Orbit.', {
        labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
        listUnsubscribe: true,
      }),
      inbound(ago(34 * HOUR), 't-orbit-2', orbit, 'Your Orbit trial ends soon', 'Three days left on your trial.', {
        labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
        listUnsubscribe: true,
      }),
      inbound(ago(10 * DAY), 't-mb', machinesBilling, 'Statement for September', 'Your statement is attached.', {
        labels: ['INBOX', 'CATEGORY_UPDATES'],
        listUnsubscribe: true,
      }),
      // Closed: they are read now, and archived below.
      inbound(
        ago(8 * DAY),
        't-bao',
        bao,
        'Re: New invoice 0009',
        'Please see the attached invoice. Let me know if anything looks off.',
      ),
      inbound(
        ago(11 * DAY),
        't-flight',
        gareth,
        'Flight delayed - meeting reschedule request',
        'My flight is delayed. Can we move our meeting to Thursday?',
      ),
      inbound(ago(40 * DAY), 't-old', bao, 'Welcome aboard', 'Glad to be working together.'),
    ],
    labels: [],
    job: null,
  })
  store.setWatch(mailbox.id, new Date(now + 7 * DAY).toISOString())
  store.recordPush(mailbox.id)
  store.recordSyncSuccess(mailbox.id, null)

  const idOf = (threadId: string): string => {
    const row = sql.exec('SELECT id FROM conversation WHERE gmail_thread_id = ?1', threadId).toArray()[0]
    if (!row) throw new Error(`dev seed: no conversation for ${threadId}`)
    return String(row.id)
  }

  for (const thread of ['t-bao', 't-flight', 't-old']) {
    must(store.applyConversationChange(idOf(thread), 'close', OWNER_EMAIL), `close ${thread}`)
  }

  // Clients: one person linked, so a conversation shows a solid badge and another is suggested by domain.
  const contactOf = (address: string): string => {
    const found = store.listContacts().find((c) => c.identities.some((i) => i.address === address))
    if (!found) throw new Error(`dev seed: no contact for ${address}`)
    return found.id
  }
  must(store.assignClient(contactOf(sam.address), 2, OWNER_EMAIL), 'assign Sam')
  must(store.assignClient(contactOf(nils.address), 3, OWNER_EMAIL), 'assign Nils')
  must(store.assignClient(contactOf(bright.address), 4, OWNER_EMAIL), 'assign Dr. Bright')
  must(store.assignClient(contactOf(machinesBilling.address), 1, OWNER_EMAIL), 'assign Example Machines Billing')

  // Drafts: Claude's on a conversation, Tessa's on another, and two that sit on no conversation.
  must(
    store.createDraft(
      {
        conversationId: idOf('t-delphine'),
        body: 'Hi Delphine,\n\nThanks for the invitation. I would be glad to join. Tuesday mornings work for me, so any Tuesday next month is fine. Send over a few dates and a link, and I will confirm.\n\nBest,\nTessa',
        why: 'He asked whether a Tuesday works and offered any of them.',
      },
      AGENT,
    ),
    'draft on Delphine',
  )
  must(
    store.createDraft(
      {
        conversationId: idOf('t-sam'),
        body: 'Hi Sam,\n\nThank you. Next I will send the first draft of the pages within two business days.\n\nTessa',
      },
      OWNER_EMAIL,
    ),
    'draft on Sam',
  )
  // A second draft on the same conversation, so "1 more draft" has something behind it.
  must(
    store.createDraft(
      {
        conversationId: idOf('t-sam'),
        body: 'Hi Sam,\n\nCongratulations on signing. I will send the schedule for the first two weeks tomorrow.\n\nTessa',
        why: 'A shorter reply that only gives the timing.',
      },
      AGENT,
    ),
    'second draft on Sam',
  )
  must(
    store.createDraft(
      {
        address: 'dana@studio.example',
        name: 'Dana Whitfield',
        subject: 'Checking in on the new site',
        body: 'Hi Dana,\n\nThe new site has been up for a fortnight now. Anything you want adjusted?\n\nBest,\nTessa',
        why: 'Two weeks after launch is when the first small changes come in.',
      },
      AGENT,
    ),
    'new email draft',
  )
  must(
    store.createDraft(
      { address: '626-555-0142', name: 'Marcus', body: 'Hi Marcus, your page changes are live.' },
      OWNER_EMAIL,
    ),
    'text draft',
  )

  // A Gmail draft the assistant wrote when Tessa asked for one in the chat (decision 23), with the chat: made as the chat makes
  // it (empty, in his name, then filled by the assistant), on the person's Reply-To, signed as Tessa at Northfield Works, and no price in it.
  const asked = must(
    store.createDraft({ conversationId: idOf('t-olive'), body: '' }, OWNER_EMAIL, { empty: true }),
    'empty draft on Olive',
  )
  const written = must(
    store.updateDraft(
      asked.id,
      {
        rev: asked.rev,
        body: 'Hi Olive,\n\nThanks for writing. I will look at your payment today and let you know by this evening whether it went through.\n\nTessa\nNorthfield',
        why: 'Asked for a reply that says I will check; it states no amount or date it was not given.',
      },
      ASSISTANT_ACTOR,
    ),
    'assistant words on Olive',
  )
  sql.exec(
    `INSERT INTO draft_chat (draft_id, at, by, instruction, note, revised, rev_before, rev_after)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    asked.id,
    new Date(now - 6 * 60_000).toISOString(),
    OWNER_EMAIL,
    'Write a reply, say I will check on her payment today',
    'Wrote a short reply that says you will check today. I did not name an amount or a time, since none was in her message.',
    1,
    asked.rev,
    written.rev,
  )

  // Claude's sends need the switch on at the time, and the shipped state is off, so it is flipped
  // for the seeding and flipped back.
  must(store.setClaudeSending(true, OWNER_EMAIL), 'switch on')
  const send = (draft: MessageRow, instruction: { text: string; where: string; at: string }, confirm: boolean) => {
    const conversation =
      draft.conversationId === null ? null : must(store.getConversation(draft.conversationId), 'conversation')
    const plan = must(
      store.planSend(draft.id, { rev: draft.rev, through: conversation?.through ?? null, instruction }, AGENT),
      'plan',
    )
    // The seeded store holds Gmail conversations only.
    if (plan.transport !== 'gmail') throw new Error('dev seed: a Gmail plan was expected')
    must(store.claimSend(plan, AGENT), 'claim')
    if (confirm) {
      must(
        store.fileSentMessage(
          plan,
          { id: `dev-claude-${draft.id}`, threadId: plan.threadId ?? '', labels: ['SENT'] },
          AGENT,
        ),
        'file',
      )
    }
  }
  // Tessa's words are dated when the send is made: an instruction given before a message arrived does not cover it.
  const saidNow = () => new Date().toISOString()
  const reply = must(
    store.createDraft(
      {
        conversationId: idOf('t-marta'),
        body: 'Hi Marta,\n\nThe spring sale banner is off the home page now, and the phone number at the top is the new one.\n\nBest,\nTessa',
        why: 'She asked for both changes in her last two messages.',
      },
      AGENT,
    ),
    'draft for Marta',
  )
  send(reply, { text: 'send the reply to Marta', where: 'session main (dev seed)', at: saidNow() }, true)

  const stuck = must(
    store.createDraft(
      {
        conversationId: idOf('t-bright'),
        body: 'Hi Dr. Bright,\n\nYes, the form can ask for a phone number too. I have added it.\n\nBest,\nTessa',
        why: 'He asked whether the form can take a phone number.',
      },
      AGENT,
    ),
    'draft for Dr. Bright',
  )
  // Claimed and never confirmed: Gmail "did not say", so it stays as a stuck card until Tessa says which way it went.
  send(stuck, { text: 'yes, send it to Dr. Bright', where: 'session main (dev seed)', at: saidNow() }, false)
  must(store.setClaudeSending(false, OWNER_EMAIL), 'switch off')
  seedRidgeway(store, sql, now)
}

/**
 * A reply arriving on a seeded conversation, as a push would deliver it: for trying the page's
 * "a new message arrived" path (Close and read are refused over a message nobody was shown, and
 * the conversation reloads to show it) by hand. `thread` is one of the seed's Gmail thread ids,
 * for example `t-delphine`.
 */
export function arriveDevMessage(store: MailStore, thread: string, now = Date.now()): string {
  const mailbox = store.gmailMailboxes()[0] ?? null
  if (mailbox === null) return 'Seed first: POST /__dev/seed.'
  const senders: Record<string, { name: string; address: string }> = {
    't-delphine': { name: 'Delphine Barlow', address: 'delphine@castmic.example' },
    't-olive': { name: 'Olive Owner', address: 'owner@example-machines.test' },
    't-sam': { name: 'Sam Counsel', address: 'sam@samplelegal.test' },
    't-marta': { name: 'Marta Vidal', address: 'marta@tamarackprint.test' },
  }
  const from = senders[thread]
  if (!from) return `No such seeded thread. Try one of: ${Object.keys(senders).join(', ')}.`
  store.applyHistoryPage({
    mailboxId: mailbox.id,
    messages: [
      message(now, {
        threadId: thread,
        from,
        subject: 'Re: (new)',
        body: 'One more thing, sent while you were reading.',
        snippet: 'One more thing, sent while you were reading.',
        labels: ['INBOX', 'UNREAD'],
      }),
    ],
    deltas: [],
    cursor: null,
    notify: true,
  })
  return 'Arrived.'
}

/**
 * Ridgeway's mailbox, as Cloudflare's entrance would have filled it: a person asking about a price (unread, with a
 * draft the assistant wrote when asked, with the chat Tessa has had about it and and nothing of the knowledge base, which is the knowledge app's), another
 * unread one, a new inquiry nothing judged, one that is closed, two with an unsubscribe header and one Clef scored as spam. What Clef
 * said is written through the store as the entrance would, and the chat turns straight into their table, because no model runs in dev
 * (no Workers AI binding and no key); the queue and the screens read them as they would. Every name is made up and every
 * address is on a `.example` domain.
 */
function seedRidgeway(store: SpaceStore, sql: InboxSql, now: number): void {
  const mailbox = store.cloudflareMailbox({ address: 'info@ridgewaycycles.example', name: 'Ridgeway', assistant: true })
  const ours = (address: string) => address.endsWith('@ridgewaycycles.example')
  const us = { name: '', address: 'info@ridgewaycycles.example' }
  let n = 0
  const file = (
    agoMs: number,
    from: { name: string; address: string },
    subject: string,
    body: string,
    over: {
      inReplyTo?: string
      clef?: { junk: number; category: string }
      listUnsubscribe?: boolean
      closed?: boolean
    } = {},
  ): string => {
    n += 1
    const id = `<ridgeway-dev-${n}@${from.address.split('@')[1]}>`
    const header = (p: { name: string; address: string }) => (p.name ? `${p.name} <${p.address}>` : p.address)
    const filed = store.fileArrival(
      mailbox.id,
      {
        messageId: id,
        inReplyTo: over.inReplyTo ?? null,
        references: over.inReplyTo ? [over.inReplyTo] : [],
        from,
        to: [us],
        cc: [],
        fromHeader: header(from),
        toHeader: header(us),
        ccHeader: '',
        replyToHeader: '',
        subject,
        body,
        bodyTruncated: false,
        attachments: [],
        senderDate: new Date(now - agoMs).toISOString(),
        listUnsubscribe: over.listUnsubscribe ?? false,
      },
      {
        rawKey: `in/dev-ridgeway-${n}`,
        arrivalKey: id,
        receivedAt: new Date(now - agoMs).toISOString(),
        isOurs: ours,
      },
    )
    if (!filed.stored) throw new Error(`dev seed: Ridgeway message ${n} was not stored`)
    if (over.clef) store.recordJudgment(filed.messageId, { ...over.clef, model: '@cf/cloudflare/clef' })
    if (over.closed) must(store.applyConversationChange(filed.conversationId, 'close', OWNER_EMAIL), 'close Ridgeway')
    return filed.conversationId
  }

  const priced = file(
    35 * 60 * 1000,
    { name: 'Marisol Vega', address: 'marisol.vega@mailbox.example' },
    'How much is the winter service plan?',
    'Hello, I saw your page about the winter service plan for commuter and cargo bikes. What does it cost each month, and is the first visit included? I would like to start in November.',
    { clef: { junk: 0.03, category: 'customer' } },
  )
  file(
    3 * HOUR,
    { name: 'Teodoro Ibarra', address: 'teo.ibarra@mailbox.example' },
    'Need to move my Thursday visit',
    'Hi, something came up at work and I cannot make Thursday at 10. Is there anything open on Friday morning?',
    { clef: { junk: 0.06, category: 'customer' } },
  )
  file(
    5 * HOUR,
    { name: 'Wren Calloway', address: 'wren.calloway@mailbox.example' },
    'Do you service e-bikes?',
    'Quick question before I book: do you work on e-bikes with a mid-drive motor, or only on regular bikes?',
  )
  file(
    2 * DAY,
    { name: 'Priya Natarajan', address: 'priya.n@mailbox.example' },
    'Thank you for the bike fit',
    'Just wanted to say thank you. After the fitting, a long ride did not hurt my knees for the first time.',
    { clef: { junk: 0.04, category: 'customer' }, closed: true },
  )
  file(
    4 * HOUR,
    { name: 'Reachly Growth', address: 'growth@reachly.example' },
    'Get 3x more customers from Google, guaranteed',
    'We help shops like yours rank first on Google Maps. Book a free 15 minute audit this week.',
    { listUnsubscribe: true },
  )
  file(
    1 * DAY,
    { name: 'Cycling Trade Weekly', address: 'editor@ctweekly.example' },
    'This week: tubeless sealant, winter tires and a recall',
    'Five things worth knowing about, plus a shop tip. Unsubscribe at any time.',
    { listUnsubscribe: true },
  )
  file(
    6 * HOUR,
    { name: 'Prize Desk', address: 'claims@prize-desk.example' },
    'You have been selected for a 500 dollar reward',
    'Click the link below to claim your reward before it expires tonight.',
    { clef: { junk: 0.97, category: 'scam_phishing' } },
  )

  // The assistant's draft on the person who asked about the price (Tessa asked for it in the chat), with the chat: one turn that
  // changed the draft and one question that did not.
  const drafted = must(
    store.createDraft(
      {
        conversationId: priced,
        body: 'Hi Marisol,\n\nThank you for writing, and for your interest in the winter service plan. I will send the current plan pricing and what the first visit includes in a separate message today. If you would like to start in November, we can hold a first visit for you now.\n\nTessa\nRidgeway Cycles',
        why: 'She asked the monthly price and whether the first visit is included; the knowledge base has no program price, so it names none.',
      },
      ASSISTANT_ACTOR,
    ),
    'assistant draft on Marisol',
  )
  const shorter = must(
    store.updateDraft(
      drafted.id,
      {
        rev: drafted.rev,
        body: 'Hi Marisol,\n\nThanks for writing. I will send the plan pricing and what the first visit includes today, and we can hold a November visit for you now.\n\nTessa\nRidgeway Cycles',
      },
      ASSISTANT_ACTOR,
    ),
    'assistant revision on Marisol',
  )
  const turn = (
    minutesAgo: number,
    instruction: string,
    note: string,
    revised: boolean,
    before: number,
    after: number | null,
  ) =>
    sql.exec(
      `INSERT INTO draft_chat (draft_id, at, by, instruction, note, revised, rev_before, rev_after)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      drafted.id,
      new Date(now - minutesAgo * 60_000).toISOString(),
      OWNER_EMAIL,
      instruction,
      note,
      revised ? 1 : 0,
      before,
      after,
    )
  turn(
    22,
    'Shorter, and say we can hold a November visit',
    'Cut the opening and the extra sentence, and added that we can hold a visit in November.',
    true,
    drafted.rev,
    shorter.rev,
  )
  turn(
    9,
    'Why did you not give her the price?',
    'The knowledge base has no price for the plan, only for the tune-up, and I never state a price it does not hold. If you add one in the Knowledge tab I will use it.',
    false,
    shorter.rev,
    null,
  )
}
