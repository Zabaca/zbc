import { isBareAddress } from '../gmail/mime'
import type { IdentityKind } from '../types'

/**
 * What an address is, and its one spelling.
 *
 * An identity is unique per (kind, address), so two spellings of the same
 * address would be two contacts who are one person, and nothing would say so.
 * Everything that makes an identity goes through here, whether it came from a
 * draft Claude wrote, a person typing, or an Outbox entry carried across.
 *
 * Three kinds, decided by shape alone:
 *   - `email`: one `@` with something either side and a dot after it. The bare
 *     address, lowercased. A display name around it ("Tessa <t@x.example>") is
 *     stripped, because the Outbox's address field has held both.
 *   - `sms`: seven to fifteen digits, with the usual punctuation. Stored as
 *     `+` and digits, and a ten-digit number is read as a US number (+1), since
 *     every number the owner texts is one. Anything else is `manual`.
 *   - `manual`: whatever is left (a DM handle, a name). Trimmed, lowercased,
 *     whitespace collapsed. The inbox cannot send on it and never will without
 *     an adapter; it exists so the message can still be recorded.
 */

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/
const PHONE_SHAPE = /^\+?[\d\s().-]+$/
const BRACKETED = /<([^<>]+)>\s*$/

export interface Classified {
  kind: IdentityKind
  address: string
}

export function classifyAddress(raw: string): Classified | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null

  const bracketed = BRACKETED.exec(trimmed)?.[1]?.trim()
  const emailCandidate = (bracketed ?? trimmed).toLowerCase()
  if (EMAIL.test(emailCandidate)) return { kind: 'email', address: emailCandidate }

  if (PHONE_SHAPE.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, '')
    if (digits.length >= 7 && digits.length <= 15) {
      // A bare 10-digit number is North American; an 11-digit one starting 1 is
      // the same number with its country code. Anything longer or shorter, or
      // given with a `+`, is taken as written.
      if (!trimmed.startsWith('+') && digits.length === 10) return { kind: 'sms', address: `+1${digits}` }
      return { kind: 'sms', address: `+${digits}` }
    }
  }

  return { kind: 'manual', address: trimmed.toLowerCase().replace(/\s+/g, ' ') }
}

/**
 * The addresses an explicit Cc names (a draft's `cc`, ADR 0001 decision 35), each as the one spelling a send accepts (a bare, lower case address of printable ASCII), none twice; or the sentence that refuses
 * the whole list: anything that is not a list, and any entry that is not an email address (a name, a phone number, a handle, nothing). Asked by the store, which owns the rule, and by the router in front of it, so a draft
 * the store would refuse never reaches a store that has not yet been told about `cc`.
 */
export function parseCcList(raw: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'cc is a list of email addresses.' }
  const out: string[] = []
  for (const entry of raw) {
    const c = typeof entry === 'string' ? classifyAddress(entry) : null
    if (c?.kind !== 'email' || !isBareAddress(c.address)) {
      return {
        ok: false,
        error: `That is not an email address the inbox can copy: ${String(entry).slice(0, 80)}. Nothing was changed.`,
      }
    }
    if (!out.includes(c.address)) out.push(c.address)
  }
  return { ok: true, value: out }
}
