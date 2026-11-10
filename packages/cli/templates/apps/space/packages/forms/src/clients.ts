/**
 * What a client business may be called and how: the checks on a client's fields, in one place. A client's name
 * lands in the sender's display name of every signing email ("<Client> via <service name>"), in a PDF's header and in
 * the certificate of completion, so it is held to the usual rule for a display name in a mail header: no control
 * characters of any kind, and none of `< > " \ , ; : @ ( )`, which
 * either need quoting to be represented faithfully or let a name present as another sender. An apostrophe and an
 * ampersand are allowed ("Joe's Plumbing", "Marlow & Co"): the strictest form of that rule refuses the apostrophe, but this app hands
 * Cloudflare a name and an address as separate fields, never a composed header, and a small business with an
 * apostrophe in its name is the usual case here.
 */
import { CLIENT_NAME_MAX } from '@space/workspace'
import { WRITABLE, badRequest } from './store'
import { DEFAULT_RETENTION_YEARS } from './settings'

const HEADER_CONTROL = /[\u0000-\u001f\u007f-\u009f]/
/** The characters a display name may not carry (the usual list, less the apostrophe). */
const DISPLAY_NAME = /^[^<>"\\,;:@()\u0000-\u001f\u007f-\u009f]+$/
const ADDRESS = /^[^@\s,<>()"';:\\]+@[^@\s,<>()"';:\\]+\.[^@\s,<>()"';:\\]+$/
const SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/
const COLOR = /^#[0-9a-fA-F]{6}$/

export const isHeaderSafe = (s: string) => !HEADER_CONTROL.test(s)

export function text(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || v.trim() === '') throw badRequest(`${what} is required`)
  const s = v.trim()
  // In characters (code points), as the Clients part and a database CHECK on length() count them: a name of 80 emoji is 160 UTF-16 units and is 80 long.
  if (Array.from(s).length > max) throw badRequest(`${what} is too long (at most ${max} characters)`)
  if (!isHeaderSafe(s)) throw badRequest(`${what} may not contain control characters`)
  return s
}

export function displayName(v: unknown): string {
  const s = text(v, 'Display name', CLIENT_NAME_MAX)
  if (!DISPLAY_NAME.test(s)) throw badRequest('Display name may not contain < > " \\ , ; : @ ( ) because it is shown as the sender of signing mail')
  return s
}

export function address(v: unknown, what: string): string {
  const s = text(v, what, 254).toLowerCase()
  if (!ADDRESS.test(s)) throw badRequest(`${what} must be an email address`)
  return s
}

function zone(v: unknown): string {
  const s = text(v, 'Time zone', 64)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s })
  } catch {
    throw badRequest(`Time zone ${s} is not a known zone (for example America/Los_Angeles)`)
  }
  return s
}

export function slug(v: unknown): string {
  if (typeof v !== 'string' || !SLUG.test(v)) throw badRequest('Slug must be 2 to 40 characters: lowercase letters, digits and hyphens, starting with a letter or digit')
  return v
}

/** The number of the Client a row is the signing settings of: a whole number from 1, named in the body. */
export function clientNumber(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw badRequest('client_number is required: the number of the Client these are the signing settings of')
  return v
}

/** The sentence for a request that names a name: it is the Client's, and is changed on the Client's page in Settings. */
export const NAME_IS_THE_CLIENTS = "A client's name and legal name are the Client's own: change them on the Client's page in Settings, and Forms follows."

/**
 * The signing settings an operator may set on a client, validated and normalized; with `partial` only the keys present. A NAME IS NOT ONE OF THEM: a row's display name and legal name are a copy of its Client's, so a body that names one
 * is refused with the sentence above. On create `slug` and `client_number` are also allowed and are read by the route, not returned here (the number is checked against the Clients part).
 */
export function clientFields(body: Record<string, unknown>, partial: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  // Unknown keys are refused, not dropped: a body naming `id`, `logo_key` or a typo should say so.
  if ('display_name' in body || 'legal_name' in body) throw badRequest(NAME_IS_THE_CLIENTS)
  const allowed = [...WRITABLE.clients, ...(partial ? [] : ['slug', 'client_number'])]
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw badRequest(`${k} cannot be set here (allowed: ${allowed.join(', ')})`)
  const has = (k: string) => k in body
  const need = (k: string) => {
    if (!partial && !has(k) && !['accent_color', 'copy_addresses', 'time_zone', 'retention_years'].includes(k)) throw badRequest(`${k} is required`)
    return has(k)
  }
  if (need('reply_to')) out.reply_to = address(body.reply_to, 'Reply-to address')
  if (has('accent_color')) {
    if (typeof body.accent_color !== 'string' || !COLOR.test(body.accent_color)) throw badRequest('Accent color must look like #1f4e79')
    out.accent_color = body.accent_color.toLowerCase()
  }
  if (has('copy_addresses')) {
    const list = body.copy_addresses
    if (!Array.isArray(list) || list.length > 10) throw badRequest('Copy addresses must be a list of at most 10 email addresses')
    out.copy_addresses = [...new Set(list.map((a) => address(a, 'Copy address')))]
  }
  if (has('time_zone')) out.time_zone = zone(body.time_zone)
  if (has('retention_years')) {
    const n = body.retention_years
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 50) throw badRequest('Retention must be a whole number of years, 1 to 50')
    out.retention_years = n
  }
  if (!partial) out.retention_years ??= DEFAULT_RETENTION_YEARS
  return out
}

/** A logo is a PNG or a JPEG, checked by its first bytes and not by what the request claims. */
export function logoType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  return null
}
