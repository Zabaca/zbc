import { classifyAddress } from '../store/address'

/**
 * The Cloudflare mailboxes the deploy config declares (`INBOX_MAILBOXES` in the Worker's settings): an address, the name
 * its conversations are marked with, and whether the spam check runs on it to begin with (the key keeps the name the switch began with, `assistant`). Pure, so what is accepted is a table test.
 *
 * ── WHY IT IS CONFIG AND NOT SOMETHING THE PAGE ADDS ─────────────────────
 * A mailbox is where customers' mail lands, so adding one is a change somebody reviews and deploys together with the
 * routing rule that points at it. The store records the row the first time mail arrives for a declared address.
 *
 * ── ONE MAILBOX PER DOMAIN, AND THE DOMAIN IS WHAT IS ACCEPTED ───────────
 * Email Routing's catch-all hands over mail for ANY address on the domain, so the mailbox is the domain's: a message
 * to `anything@northfield.example` is filed in `hello@northfield.example`. Mail for a domain no mailbox is declared
 * on is refused (entrance.ts), so routing another domain at this Worker by mistake cannot make the inbox a catch-all
 * for it. Two mailboxes on one domain would make "which one" a guess, so that is refused here.
 *
 * ── IT FAILS CLOSED ──────────────────────────────────────────────────────
 * A declaration that is not valid declares nothing (every arrival is refused), and the reason is said once, so a typo
 * in the config is a refusal that is loud rather than mail filed in the wrong place.
 */
export interface DeclaredMailbox {
  /** Lower case, bare. */
  address: string
  /** What the mailbox's conversations are marked with. */
  name: string
  /** Lower case: the part after the @. */
  domain: string
  /**
   * Whether the spam check (the spam classifier, src/cloudflare/spam-check.ts) runs on this mailbox until the owner switches it. Named `assistant`
   * since the switch began as the assistant's. Absent in the declaration is off, so a mailbox declared without it receives mail
   * and nothing more: every message is in the Inbox and notifies.
   */
  assistant?: boolean
}

export type Declaration = { ok: true; mailboxes: DeclaredMailbox[] } | { ok: false; error: string }

/** The value as wrangler delivers it: an array in the config, or the same array as JSON text (a var set from outside). Unset is none. */
export function parseDeclared(value: unknown, ownerEmail: string): Declaration {
  let list: unknown = value
  if (typeof value === 'string') {
    if (value.trim() === '') return { ok: true, mailboxes: [] }
    try {
      list = JSON.parse(value)
    } catch {
      return { ok: false, error: 'INBOX_MAILBOXES is not JSON.' }
    }
  }
  if (list === undefined || list === null) return { ok: true, mailboxes: [] }
  if (!Array.isArray(list)) return { ok: false, error: 'INBOX_MAILBOXES is a list of { address, name, assistant? }.' }

  const mailboxes: DeclaredMailbox[] = []
  for (const [n, entry] of list.entries()) {
    const given = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
    const classified = typeof given.address === 'string' ? classifyAddress(given.address) : null
    const name = typeof given.name === 'string' ? given.name.trim() : ''
    if (classified?.kind !== 'email') {
      return { ok: false, error: `INBOX_MAILBOXES entry ${n} has no email address.` }
    }
    if (name === '') return { ok: false, error: `INBOX_MAILBOXES entry ${n} (${classified.address}) has no name.` }
    if (classified.address === ownerEmail) {
      return { ok: false, error: `${ownerEmail} is the Gmail mailbox; it is not declared here.` }
    }
    const domain = classified.address.split('@')[1] as string
    if (mailboxes.some((m) => m.domain === domain)) {
      return { ok: false, error: `INBOX_MAILBOXES has two mailboxes on ${domain}; a domain's mail has one mailbox.` }
    }
    if (given.assistant !== undefined && typeof given.assistant !== 'boolean') {
      return {
        ok: false,
        error: `INBOX_MAILBOXES entry ${n} (${classified.address}) has an assistant (the spam check's switch) that is not true or false.`,
      }
    }
    mailboxes.push({ address: classified.address, name, domain, ...(given.assistant === true && { assistant: true }) })
  }
  return { ok: true, mailboxes }
}

/** The declared mailbox whose domain an envelope recipient is on, or null (the entrance refuses it). */
export function mailboxFor(mailboxes: readonly DeclaredMailbox[], recipient: string): DeclaredMailbox | null {
  const domain = recipient.trim().toLowerCase().split('@')[1]
  return (domain && mailboxes.find((m) => m.domain === domain)) || null
}
