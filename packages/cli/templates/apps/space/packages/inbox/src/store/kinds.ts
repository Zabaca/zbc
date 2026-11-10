/**
 * The kinds of mailbox the store holds, and the few QUESTIONS the code asks of a kind, each named once. A fourth kind (JMAP, on the install's own mail server) joined Gmail, Cloudflare and Telegram, and the
 * rule for adding one is: decide per question, never add the kind to every condition that mentions another.
 *
 * - **The server's labels are the truth** (Gmail and JMAP): a conversation is read and open by the labels its messages carry, which the server gives and the inbox only mirrors; a change a person makes is made on
 *   the server first. Cloudflare's and Telegram's conversations have no server behind them, and the inbox's own stamps are the whole state.
 * - **Our own addresses are the mailbox's and its domain** (Cloudflare and JMAP): the mailbox's address and every address on its domain are ours (never a recipient, never copied, never an outside participant); Gmail's own
 *   addresses are the owner's and every mailbox's.
 * - **Email at all** (Gmail, Cloudflare, JMAP): the kinds a draft can be written for, a spam call made on and an address sent from; Telegram's chats are none of these.
 * - **Where the server's ids are kept**: Gmail's in `gmail_id` and `gmail_thread_id`, JMAP's in `jmap_id` and `jmap_thread_id` (migration 18). Gmail's columns keep meaning Gmail.
 */

import { GMAIL_ACTOR, JMAP_ACTOR } from '../types'

export type MailboxKind = 'gmail' | 'cloudflare' | 'telegram' | 'jmap'

export const isMailboxKind = (v: unknown): v is MailboxKind =>
  v === 'gmail' || v === 'cloudflare' || v === 'telegram' || v === 'jmap'

/** Read and open come from the labels a server gives (Gmail, JMAP), not from the inbox's own stamps. */
export const labelsAreTruth = (kind: MailboxKind | null): boolean => kind === 'gmail' || kind === 'jmap'

/** The mailbox's address and its whole domain are ours (Cloudflare, JMAP). */
export const domainIsOurs = (kind: MailboxKind | null): boolean => kind === 'cloudflare' || kind === 'jmap'

/** The columns a mailbox's server ids are kept in. A closed table, so a name here is safe to put in SQL. */
export interface IdColumns {
  message: 'gmail_id' | 'jmap_id'
  thread: 'gmail_thread_id' | 'jmap_thread_id'
}
export const idColumns = (kind: MailboxKind | null): IdColumns =>
  kind === 'jmap'
    ? { message: 'jmap_id', thread: 'jmap_thread_id' }
    : { message: 'gmail_id', thread: 'gmail_thread_id' }

/** A message the server holds (it has a server id of either kind): the SQL for a query over `message` aliased as `alias`. */
export const heldOnServer = (alias = ''): string => {
  const p = alias === '' ? '' : `${alias}.`
  return `(${p}gmail_id IS NOT NULL OR ${p}jmap_id IS NOT NULL)`
}

/** The mailboxes mail is written from and judged in: everything but Telegram. */
export const EMAIL_KINDS = ['gmail', 'cloudflare', 'jmap'] as const
export const isEmailKind = (kind: string | null): boolean =>
  kind !== null && (EMAIL_KINDS as readonly string[]).includes(kind)

/** Who a change the server told the inbox of is stamped as: the JMAP mailbox's, or Gmail's. */
export const serverActorOf = (kind: MailboxKind | null): string => (kind === 'jmap' ? JMAP_ACTOR : GMAIL_ACTOR)

/** Where the words say a mailbox's mail is held ("no thread in Gmail", "no thread on the mail server"). */
export const whereHeldWords = (kind: MailboxKind | null): string =>
  kind === 'jmap' ? 'on the mail server' : 'in Gmail'

/** A message the mailbox sent is filed in a folder of its own on the server (JMAP's Sent), not in a label that Close and Reopen could take off. */
export const sentIsAFolder = (kind: MailboxKind | null): boolean => kind === 'jmap'
