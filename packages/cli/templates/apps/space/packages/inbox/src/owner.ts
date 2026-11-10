/**
 * The inbox's one owner: the install's owner (`Install.owner()`, the first owner the declaration lists), read once and handed to every part of the inbox that
 * compares an actor with the owner, makes a sender's name, makes a message id or says the owner's name in a sentence. The owner is who the owner-only acts are (connecting Gmail, Claude's switch, restore, the
 * operator's three, the Clients and the contacts' writes) and whose Claude's script is; everything else the inbox does is any person's, for the mailboxes they are on (the inbox's ADR 0004: `team` is the people who can be on one).
 *
 * Nothing here is one company's: an install is its declaration, whose owner is, for the bundled one, tessa@northfield.example, "Tessa", mailed as "Tessa Marlow".
 * What the inbox's refusals and labels say about the owner is owner-words.ts: functions of `name`.
 */
import { type Install, mailNameOf } from '@space/workspace'
import type { MailboxKind } from './store/kinds'

export interface InboxOwner {
  /** The owner's address: what the stores compare an actor with, the account a draft with no mailbox goes out from, and the actor every owner-only write records. */
  email: string
  /** What the refusals and labels call the owner ("Tessa"). */
  name: string
  /** The name the owner's mail carries in its From line ("Tessa Marlow"). */
  mailName: string
  /** The domain of the owner's address, which a message's own Message-ID is made under. */
  domain: string
  /** The company's name, which a notification's title says ("Northfield Works Space" in the bundled install). */
  company: string
  /** What the install's business mailboxes (the ones fed by Cloudflare Email Routing) are called in a sentence that names them: for example "Northfield" in the bundled install, in the declaration's order. */
  mailboxNames: string[]
  /** The space's address with no trailing slash, which the push service is told to contact about the inbox's requests (VAPID's subject; never the owner's email). */
  spaceOrigin: string
  /** Every person of the install by their work address, lower case, the owner first: who can be on a mailbox, and whose a device is by who added it (`deviceOwnerOf`, src/queue.ts). */
  team: string[]
}

/** The install's owner as the inbox needs them. */
export function inboxOwnerOf(install: Install): InboxOwner {
  const person = install.owner()
  return {
    email: person.address,
    name: person.name,
    mailName: mailNameOf(person),
    domain: person.address.split('@')[1] as string,
    company: install.company.name,
    mailboxNames: install.cloudflareMailboxes().map((m) => m.short ?? m.name),
    spaceOrigin: install.url().replace(/\/+$/, ''),
    team: [person.address, ...install.people.map((p) => p.address).filter((a) => a !== person.address)].map((a) =>
      a.trim().toLowerCase(),
    ),
  }
}

/**
 * Who is on each mailbox the install says the people of (`PeopleSource.peopleOf`, src/store/people.ts): a declared business mailbox (Cloudflare's or the mail server's) by its declaration's `people`, else the owner alone; the
 * Telegram mailbox the owner's; and nothing for a Gmail account, which is its connector's, or for an address the declaration does not name (the store then leaves the list it has).
 */
export function mailboxPeopleOf(install: Install): (kind: MailboxKind, address: string) => readonly string[] | null {
  const owner = install.owner().address
  return (kind, address) => (kind === 'telegram' ? [owner] : kind === 'gmail' ? null : install.mailboxPeople(address))
}
