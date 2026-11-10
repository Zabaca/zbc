// A new email from scratch: the rules of the box that are not drawing. Pure, so each is a table test with no browser.
//
// THE SENDER IS A MAILBOX, NEVER AN ADDRESS TYPED. The person chooses where it goes out from: one of the owner's Gmail accounts, or one of the business mailboxes the inbox lists (a shared sales or support mailbox, say),
// and the inbox sends as that mailbox's own address. Left on "Automatic" it is the inbox's own rule (the mailbox the person last wrote to: a customer hears from the shared mailbox, a client from the owner),
// which the box cannot see, so it offers no files then: files go only from a business mailbox, and a mailbox is chosen for them.
//
// A MAILBOX ON THE MAIL SERVER is a business mailbox to the inbox (`InboxFrom` says `business`) but is its own choice here, `jmap:<id>`: it is offered while the server takes the
// space's key, and it takes no files (the inbox refuses them in words, so the box does not offer them).
import { type InboxFrom, type InboxJmap, type InboxMailbox, NEW_EMAIL_CAPABILITY, normalizeAddress } from '@space/workspace'
import { type Compose, filesOf, whyNotFiles } from './compose'

/** The choice in the From box: the inbox's own rule, a Gmail account by its id, or a business mailbox by its id. */
export type FromChoice = 'auto' | `gmail:${string}` | `business:${string}` | `jmap:${string}`

export const AUTOMATIC: FromChoice = 'auto'

/** What the choice means to the inbox: nothing (its own rule), a Gmail account, or a business mailbox. */
export function fromOf(choice: FromChoice): InboxFrom | undefined {
  if (choice === 'auto') return undefined
  if (choice.startsWith('gmail:')) return { kind: 'gmail', mailboxId: choice.slice('gmail:'.length) }
  if (choice.startsWith('jmap:')) return { kind: 'business', mailboxId: choice.slice('jmap:'.length) }
  return { kind: 'business', mailboxId: choice.slice('business:'.length) }
}

export interface FromOption {
  value: FromChoice
  label: string
}

/** What the box reads of the inbox's `mailboxes` answer: each Gmail account (its id, label, address and whether it works), the business mailboxes, and what the inbox says it can do. */
export interface MailboxChoices {
  gmailAccounts: readonly { id: string; name: string; address: string; connected: boolean; state: string; sendsByDefault?: boolean }[]
  mailboxes: readonly InboxMailbox[]
  /** The mailboxes on the mail server, when the inbox has any (ABSENT from an inbox that predates them). */
  jmap?: readonly Pick<InboxJmap, 'id' | 'name' | 'address' | 'declared' | 'state'>[]
  capabilities?: readonly string[]
}

/** Whether the inbox says it honours a new email's chosen mailbox and files. One that does not (an older one) would ignore both without a word, so nothing is offered that depends on them. */
export const canChoose = (mailboxes: MailboxChoices | null): boolean => mailboxes?.capabilities?.includes(NEW_EMAIL_CAPABILITY) === true

/**
 * The From box's choices from what the inbox says it has: Automatic first, then each Gmail account that works, then each business mailbox, each named with its address. Only Automatic from an
 * inbox that does not say it can honour a choice.
 */
export function fromOptions(mailboxes: MailboxChoices | null): FromOption[] {
  const out: FromOption[] = [{ value: AUTOMATIC, label: 'Automatic: where they last wrote to, else your own Gmail' }]
  if (!canChoose(mailboxes)) return out
  // An account whose sign-in has lapsed cannot send, so it is not offered; Settings says to connect it again.
  for (const g of mailboxes?.gmailAccounts ?? []) {
    if (g.connected && g.state !== 'lapsed') out.push({ value: `gmail:${g.id}`, label: `${g.name} Gmail (${g.address})` })
  }
  for (const m of mailboxes?.mailboxes ?? []) out.push({ value: `business:${m.id}`, label: `${m.name} (${m.address})` })
  // A mailbox on the mail server can send while the server takes the space's key; one it refused, or that is no longer declared, cannot, so it is not offered (Settings says why).
  for (const m of mailboxes?.jmap ?? []) {
    if (m.declared && m.state !== 'refused' && m.state !== 'no-credential' && m.state !== 'undeclared') out.push({ value: `jmap:${m.id}`, label: `${m.name} (${m.address})` })
  }
  return out
}

/** Whether files may go with this choice: from a business mailbox only (Cloudflare sends them; Gmail sends none from here, and neither does a mailbox on the mail server). */
export const filesAllowed = (choice: FromChoice): boolean => choice.startsWith('business:')

/** What is in the box: who, what about, the words and the files are the compose's; the rest are here. */
export interface NewEmail {
  to: string
  subject: string
  from: FromChoice
}

/** The address the box names, or null while it is none. "Dana <dana@x.example>" is dana@x.example. */
export const addressOf = (to: string): string | null => normalizeAddress(to)

/** Why the email cannot be sent yet, in words, or null when it can. The inbox's own refusals (an em dash, an address of ours) are its to make, in its words, when Send is pressed. */
export function whyNotNew(email: NewEmail, c: Compose): string | null {
  if (addressOf(email.to) === null) return email.to.trim() === '' ? 'Say who it is to.' : 'That is not an email address.'
  if (email.subject.trim() === '') return 'Add a subject.'
  if (c.text.trim() === '') return 'Write something to say.'
  const files = filesOf(c)
  if (files.length > 0 && !filesAllowed(email.from)) return 'Files go from a business mailbox only: choose one in From, or take the files out.'
  return whyNotFiles(files)
}

export const canSendNew = (email: NewEmail, c: Compose): boolean => c.phase === 'writing' && whyNotNew(email, c) === null

/** The name written around the address ("Dana Reyes <dana@x.example>"), for a contact the inbox makes if the address is new; null for a bare address. */
export function nameIn(to: string): string | null {
  const m = /^(.*?)<[^<>]+>\s*$/.exec(to.trim())
  const name = (m?.[1] ?? '').replace(/^["'\s]+|["'\s]+$/g, '').trim()
  return name === '' ? null : name
}
