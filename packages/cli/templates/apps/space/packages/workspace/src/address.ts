// The one spelling of an email address that the inbox, meet, forms and the space compare on.
//
// Conversations joins a person across three stores by address (one row per person, joined by lowercase email
// address across the inbox's contacts, the team and meet's people), and forms finds a person's documents the same way. If
// each side spelled an address its own way, one person would be two rows. So every side goes through this function, on the
// way out of its own store and on the way in from the space, and nothing compares a raw address.
//
// THE SPELLING OF EVERY ADDRESS AN APP PUTS IN AN ANSWER. Whatever an entrypoint returns as an address (an inbox contact's, a meet
// person's, a team person's) went through this function first, and every address it is given it reads through it again, so the
// space never has to normalise and never sees two spellings. **Each part proves it with a test**: an answer built from
// a stored "Ines Duarte <Ines@X.example.com>" carries "ines@x.example.com".
//
// It is the inbox's rule (`classifyAddress` in packages/inbox/src/store/address.ts: a bare address, lowercased, a display name
// around it stripped) with meet's length limit (`normalizeEmail`, 254). Nothing is folded beyond case: no dots dropped from a
// Gmail name, no `+tag` removed, because two spellings that a mail host happens to treat as one are still two addresses to
// every store here, and the join is exactly as strong as the stores' own uniqueness.

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/
const BRACKETED = /<([^<>]+)>\s*$/

/** The longest address kept: RFC 5321's path limit, as meet's `normalizeEmail` has it. */
export const ADDRESS_MAX = 254

/**
 * The bare lowercase address `raw` names, or null when it names no email address (a phone number, a handle, a name, nothing).
 * "Ines <I@X.example.com>" and " i@x.example.com " are both "i@x.example.com". Never throws, whatever it is given.
 */
export function normalizeAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const candidate = (BRACKETED.exec(trimmed)?.[1] ?? trimmed).trim().toLowerCase()
  return candidate.length <= ADDRESS_MAX && EMAIL.test(candidate) ? candidate : null
}
