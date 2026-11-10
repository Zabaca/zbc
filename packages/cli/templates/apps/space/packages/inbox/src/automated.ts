import { domainOf, FREE_MAIL_DOMAINS } from './clients'
import type { IdentityKind, SenderJudgment } from './types'

/**
 * Whether a contact is a person or an automated sender, and why. A pure rule, applied by the store when it
 * answers and NEVER STORED (like a Suggestion): nothing is marked by hand, so a misfire is fixed by changing the
 * rule here, and the screen offers only the two hand fixes that are honest (see `senderHint`).
 *
 * In order, the first that applies decides, its `rule` is recorded and its reason is the sentence the screen shows:
 *   1. `client`: the contact is under a Client: a PERSON, always. A Client's people are never Bulk either
 *      (src/queue.ts). This is an exemption, not a correction.
 *   2. `name`: its name is a machine-made address (see `isMachineAddressName`): AUTOMATED.
 *   3. `no-reply`: every address it has is a no-reply kind of mailbox (noreply, donotreply, notifications,
 *      mailer-daemon, postmaster): AUTOMATED. A contact with a phone number or a handle is a person, and so is one
 *      with any other mailbox.
 *   3b. `bot`: one of its identities is a Telegram bot (Telegram says which a user is; the Telegram bridge records it): AUTOMATED, so a bot's chat is filed in Bulk.
 *   3c. `channel`: one of its identities stands for a Telegram channel: AUTOMATED, so a channel's conversation is filed in Bulk by the one Bulk rule (a group is not: its row is under
 *      its members' messages, and People leaves the group's contact out by what it is, not by this rule).
 *   4. `bulk`: it has conversations and every one of them is Bulk: AUTOMATED, unless one of its addresses is a
 *      free-mail address (see `isFreeMailAddress`). A person's only conversation can land in Bulk, and
 *      a newsletter or a receipt does not come from a person's free-mail address. A rule-4 exemption only: rules 2 and 3 still
 *      apply to such a contact (a name that is a machine-made address, or only no-reply mailboxes).
 *   5. `none`: otherwise a PERSON.
 *
 * What is NOT a reason on its own: hello@, help@, support@, leads@ or billing@. People answer from those, and a
 * Client's own leads@ address is exactly such a mailbox. Nor is the LENGTH of an address used as a name: a person
 * written down as a long dotted name at a free-mail domain is a person.
 */

export interface SenderFacts {
  name: string
  clientId: number | null
  identities: { kind: IdentityKind; address: string; bot?: boolean; chat?: 'group' | 'channel' }[]
  /** The conversations the contact is on, and how many of those are Bulk (src/queue.ts `isBulk`). */
  conversations: number
  bulkConversations: number
}

/** A name that is one address: no spaces, one @ with something either side. */
const ADDRESS_AS_NAME = /^[^\s@]+@[^\s@]+$/

/** Words in a domain that only unsubscribe and bounce handlers use: unsubscribe2.customer.io, unsub.beehiiv.com, bounces.x.example. */
const MACHINE_DOMAIN = /unsub|bounce/

/** In a local part, a handler's own word: unsubscribe+..., bounce-... */
const MACHINE_LOCAL_WORD = /unsub|bounce/

/**
 * Whether the part before the @ is made by a program and not typed by a person: a run of 12 or more hex digits,
 * a piece (split at . _ + = -) of 12 or more characters with four or more digits, a piece of 16 or more with any
 * digit (base32 and random tokens), or eight or more digits in all. `owen.hale.cabinets` has no digit and
 * `leads` is short, so neither is token-like.
 */
export function isTokenLike(local: string): boolean {
  const lower = local.toLowerCase()
  if ((lower.match(/\d/g) ?? []).length >= 8) return true
  return lower.split(/[._+=-]/).some((piece) => {
    const digits = (piece.match(/\d/g) ?? []).length
    return /^[a-f0-9]{12,}$/.test(piece) || (piece.length >= 12 && digits >= 4) || (piece.length >= 16 && digits >= 1)
  })
}

/**
 * A name that is an address a program made: what a newsletter's unsubscribe or bounce handler is named. It is an
 * address AND either its domain is a handler's (unsub, unsubscribe, bounce anywhere in it), or its local part
 * says so or is a token. A short address, an ordinary address of a person and every name somebody typed are not.
 */
export function isMachineAddressName(name: string): boolean {
  if (!ADDRESS_AS_NAME.test(name)) return false
  const at = name.lastIndexOf('@')
  const local = name.slice(0, at)
  const domain = name.slice(at + 1).toLowerCase()
  return MACHINE_DOMAIN.test(domain) || MACHINE_LOCAL_WORD.test(local.toLowerCase()) || isTokenLike(local)
}

/** The mailboxes nobody reads, as written once the case, dots, dashes, underscores and a +tag are set aside. */
export const NO_REPLY_MAILBOXES = ['noreply', 'donotreply', 'notifications', 'mailerdaemon', 'postmaster']

/** Whether the part before the @ is a no-reply kind of mailbox: `No-Reply`, `do_not_reply` and `noreply+abc` are. */
export function isNoReplyAddress(address: string): boolean {
  const at = address.lastIndexOf('@')
  if (at <= 0) return false
  const local = (address.slice(0, at).toLowerCase().split('+')[0] ?? '').replace(/[-_.]/g, '')
  return NO_REPLY_MAILBOXES.includes(local)
}

/** Whether an address is at a free-mail domain (FREE_MAIL_DOMAINS, the whole domain, any case): `Ab@Gmail.com` is, `x@mail.gmail.com` is not. */
export function isFreeMailAddress(address: string): boolean {
  return FREE_MAIL_DOMAINS.includes(domainOf(address))
}

export function judgeSender(facts: SenderFacts): SenderJudgment {
  if (facts.clientId !== null)
    return { automated: false, rule: 'client', reason: 'Under a Client, so always a person.' }
  if (isMachineAddressName(facts.name)) {
    return { automated: true, rule: 'name', reason: 'Named by a machine-made address, such as an unsubscribe address.' }
  }

  const [first] = facts.identities
  if (first && facts.identities.every((i) => i.kind === 'email' && isNoReplyAddress(i.address))) {
    return {
      automated: true,
      rule: 'no-reply',
      reason:
        facts.identities.length === 1
          ? `Its only address, ${first.address}, is a no-reply mailbox.`
          : `Every address it has is a no-reply mailbox, such as ${first.address}.`,
    }
  }

  if (facts.identities.some((i) => i.chat === 'channel')) {
    return { automated: true, rule: 'channel', reason: 'A Telegram channel: broadcasts, filed in Bulk.' }
  }

  if (facts.identities.some((i) => i.bot === true)) {
    return { automated: true, rule: 'bot', reason: 'A Telegram bot.' }
  }

  const hasFreeMailAddress = facts.identities.some((i) => i.kind === 'email' && isFreeMailAddress(i.address))
  if (!hasFreeMailAddress && facts.conversations > 0 && facts.bulkConversations === facts.conversations) {
    return {
      automated: true,
      rule: 'bulk',
      reason:
        facts.conversations === 1
          ? 'Its only conversation is Bulk (a newsletter, receipt or notification).'
          : `All ${facts.conversations} of its conversations are Bulk (newsletters, receipts, notifications).`,
    }
  }

  return { automated: false, rule: 'none', reason: 'Not under a Client, and no rule for automated senders applies.' }
}

/**
 * What a person may do about a call they think is wrong, by the rule that made it, and nothing more: nothing is
 * stored, so there is no "mark as a person". The name rule is undone by renaming (the contact is then judged by
 * its addresses and mail), and a contact the inbox suggests a Client for may be linked to it, which is a person
 * by rule 1. For the no-reply and Bulk rules with no Client in sight the rule is what is wrong, and nothing is
 * offered. Null for a person.
 */
export function senderHint(sender: SenderJudgment, clientSuggested: boolean): string | null {
  if (!sender.automated) return null
  const offers: string[] = []
  if (sender.rule === 'name')
    offers.push('Rename it and the name stops counting; it is then judged by its addresses and mail.')
  if (clientSuggested) offers.push('If it belongs to the Client suggested below, Link it to its Client.')
  return offers.length === 0 ? null : offers.join(' ')
}
