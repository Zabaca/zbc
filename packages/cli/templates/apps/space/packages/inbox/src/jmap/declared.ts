import { classifyAddress } from '../store/address'

/**
 * The JMAP mailboxes the deploy config declares (`INBOX_JMAP_MAILBOXES` in the Worker's settings (kit/worker-settings.ts)): a mailbox on the company's own mail server that the space reads and sends through. Pure, so what is accepted is a table
 * test. Each entry says four things and nothing secret:
 *
 *   address  the mailbox's address (lower case, bare), the one its sends come from
 *   name     what its conversations are marked with (the pill)
 *   door     the address of the server's JMAP door: https, a hostname and nothing after it (set up in the mail server's operator runbook)
 *   secret   the NAME of the Worker secret that holds the mailbox's key (never the key): the secret is pushed to the Worker from sops by the space's instance
 *
 * ── WHY IT IS CONFIG AND NOT SOMETHING THE PAGE ADDS ─────────────────────
 * As the Cloudflare mailboxes' declaration is (src/cloudflare/declared.ts): a mailbox is a client's mail, so adding one is a reviewed change deployed with the key that opens it. The store records the row on the first alarm
 * after a deploy, and starts its fill.
 *
 * ── IT FAILS CLOSED ──────────────────────────────────────────────────────
 * A declaration that is not valid declares NONE, and says why once (nothing is synced or sent for a mailbox whose declaration cannot be trusted). A mailbox taken out of the declaration keeps its row and its mail, is not
 * synced, and says so.
 */
export interface DeclaredJmap {
  address: string
  name: string
  /** `https://host`, no trailing slash, no path. */
  door: string
  /** The Worker secret that holds the key, an upper-case name. */
  secret: string
}

export type JmapDeclaration = { ok: true; mailboxes: DeclaredJmap[] } | { ok: false; error: string }

const SECRET_NAME = /^[A-Z][A-Z0-9_]{2,63}$/

/** The value as wrangler delivers it: an array in the config, or the same array as JSON text (a var set from outside). Unset is none. */
export function parseJmapDeclared(value: unknown, ownerEmail: string): JmapDeclaration {
  let list: unknown = value
  if (typeof value === 'string') {
    if (value.trim() === '') return { ok: true, mailboxes: [] }
    try {
      list = JSON.parse(value)
    } catch {
      return { ok: false, error: 'INBOX_JMAP_MAILBOXES is not JSON.' }
    }
  }
  if (list === undefined || list === null) return { ok: true, mailboxes: [] }
  if (!Array.isArray(list))
    return { ok: false, error: 'INBOX_JMAP_MAILBOXES is a list of { address, name, door, secret }.' }

  const mailboxes: DeclaredJmap[] = []
  for (const [n, entry] of list.entries()) {
    const made = entryOf(entry, n, mailboxes, ownerEmail)
    if ('error' in made) return { ok: false, error: made.error }
    mailboxes.push(made)
  }
  return { ok: true, mailboxes }
}

/** The https address of a door, with a hostname and nothing after it; null for anything else. */
function doorOf(given: unknown): string | null {
  let door: URL
  try {
    door = new URL(typeof given === 'string' ? given : '')
  } catch {
    return null
  }
  const bare = door.pathname === '/' || door.pathname === ''
  const plain = door.username === '' && door.password === '' && door.search === '' && door.hash === ''
  return door.protocol === 'https:' && bare && plain ? `https://${door.host}` : null
}

/** One entry of the list, or what is wrong with it. `earlier` are the entries before it (an address or a pill is declared once). */
function entryOf(
  entry: unknown,
  n: number,
  earlier: DeclaredJmap[],
  ownerEmail: string,
): DeclaredJmap | { error: string } {
  const given = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
  const classified = typeof given.address === 'string' ? classifyAddress(given.address) : null
  const name = typeof given.name === 'string' ? given.name.trim() : ''
  if (classified?.kind !== 'email') return { error: `INBOX_JMAP_MAILBOXES entry ${n} has no email address.` }
  const address = classified.address
  if (name === '') return { error: `INBOX_JMAP_MAILBOXES entry ${n} (${address}) has no name.` }
  if (address === ownerEmail) return { error: `${ownerEmail} is the Gmail mailbox; it is not declared here.` }
  if (earlier.some((m) => m.address === address)) return { error: `INBOX_JMAP_MAILBOXES declares ${address} twice.` }
  if (earlier.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
    return { error: `INBOX_JMAP_MAILBOXES gives two mailboxes the name ${name}; a pill must tell them apart.` }
  }
  const door = doorOf(given.door)
  if (door === null) {
    return {
      error: `INBOX_JMAP_MAILBOXES entry ${n} (${address}) has a door that is not an https address with a hostname and nothing after it.`,
    }
  }
  if (typeof given.secret !== 'string' || !SECRET_NAME.test(given.secret)) {
    return {
      error: `INBOX_JMAP_MAILBOXES entry ${n} (${address}) names a secret that is not an upper-case name (the name of the Worker secret that holds the key, never the key).`,
    }
  }
  return { address, name, door, secret: given.secret }
}
