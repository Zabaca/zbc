import { classifyAddress } from '../store/address'

/**
 * The Cloudflare mailboxes the deploy config declares (`INBOX_MAILBOXES` in the Worker's settings): an address, the name
 * its conversations are marked with, and whether the spam check runs on it to begin with (the key keeps the name the switch began with, `assistant`). Pure, so what is accepted is a table test.
 *
 * ── WHY IT IS CONFIG AND NOT SOMETHING THE PAGE ADDS ─────────────────────
 * A mailbox is where customers' mail lands, so adding one is a change somebody reviews and deploys together with the
 * routing rule that points at it. The store records the row the first time mail arrives for a declared address.
 *
 * ── THE ADDRESS FIRST, THEN THE DOMAIN'S ONE MAILBOX ─────────────────────
 * A message is filed in the mailbox declared at its envelope recipient's exact address. Failing that, where its
 * domain has ONE declared mailbox, in that one: Email Routing's catch-all hands over mail for ANY address on the
 * domain, so a message to `anything@northfield.example` is filed in `hello@northfield.example`. A domain may have
 * several mailboxes (each reached by a literal routing rule of its own, `leads@` and a person's own address, say);
 * then mail to any other address on it is refused, since "which one" would be a guess. Mail for a domain no mailbox
 * is declared on is refused (entrance.ts), so routing another domain at this Worker by mistake cannot make the
 * inbox a catch-all for it.
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
    if (mailboxes.some((m) => m.address === classified.address)) {
      return { ok: false, error: `INBOX_MAILBOXES lists ${classified.address} twice.` }
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

/** The declared mailbox at an envelope recipient's exact address, else the ONE declared on its domain, or null (the entrance refuses it). */
export function mailboxFor(mailboxes: readonly DeclaredMailbox[], recipient: string): DeclaredMailbox | null {
  const address = recipient.trim().toLowerCase()
  const exact = mailboxes.find((m) => m.address === address)
  if (exact) return exact
  const domain = address.split('@')[1]
  const onDomain = domain ? mailboxes.filter((m) => m.domain === domain) : []
  return onDomain.length === 1 ? (onDomain[0] as DeclaredMailbox) : null
}
