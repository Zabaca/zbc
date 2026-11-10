// What the phone's two sides share: how a typed number is read and judged, the 911 address, and the shapes that cross
// the wire. Pure; imported by the Worker, the phone core and the browser (docs/adr/0004).

import { LINE } from './phone-line'

export const MINUTE = 60_000

/** Why a call was refused. The page shows `message`; `reason` is for tests and the log. */
export type Reason = 'format' | 'country' | 'territory' | 'premium' | 'cap' | 'setup' | 'not-allowed' | 'unavailable' | 'cell' | 'ring' | 'owner'

export const MESSAGES: Record<Reason, string> = {
  format: 'That does not look like a US phone number.',
  country: 'meet calls US numbers only.',
  territory: 'Calls to Canada, the Caribbean and US territories are not allowed from meet.',
  premium: 'Premium-rate and special numbers are not allowed from meet.',
  cap: "This month's phone minutes are used up. They start again on the 1st.",
  setup: 'Set up your 911 address before you call.',
  'not-allowed': 'The phone is for the company’s own people.',
  unavailable: 'The phone is not set up yet.',
  cell: 'That cell number cannot be used: it must be a US number that is not the line’s own number.',
  owner: "The line's settings are the line owner's to change.",
  ring: `Ring for a whole number of seconds, from ${LINE.inbound.ringSecondsMin} to ${LINE.inbound.ringSecondsMax}.`,
}

/**
 * 911 is dialed as 911 and 933 is Telnyx's test line (it answers with the address on file and dispatches nobody). Both
 * pass every check: nothing in meet may stand between a person and 911.
 */
export const EMERGENCY = '911'
export const EMERGENCY_TEST = '933'

// Area codes that share +1 with the US but are not the US: Canada, then the Caribbean countries and the US territories.
// They look like US numbers and bill at other rates, which is what makes them the usual toll-fraud destinations.
const CANADA = new Set(
  '204 226 236 249 250 257 263 289 306 343 354 365 367 368 382 403 416 418 431 437 438 450 468 474 506 514 519 548 579 581 584 587 604 613 639 647 672 683 705 709 742 753 778 780 782 807 819 825 867 873 879 902 905 942'.split(' '),
)
const CARIBBEAN = new Set(
  '242 246 264 268 284 345 441 473 649 658 664 721 758 767 784 809 829 849 868 869 876'.split(' '),
)
const TERRITORIES = new Set('340 670 671 684 787 939'.split(' '))
// Premium and special services: pay-per-call (900, 976), personal numbering (5xx) and the 700 service.
const PREMIUM = new Set(['900', '976', '700', '500', '521', '522', '523', '524', '525', '526', '527', '528', '529', '533', '544', '566', '577', '588'])

export interface Destination {
  kind: 'us' | 'emergency' | 'test'
  /** What Telnyx is given: +1NXXNXXXXXX, or 911 or 933. */
  e164: string
  /** What people read: (626) 555-0100, 911. */
  display: string
}

export type Parsed = { ok: true; dest: Destination } | { ok: false; reason: Reason; message: string }

const no = (reason: Reason): Parsed => ({ ok: false, reason, message: MESSAGES[reason] })

/** "(626) 555-0100" for ten digits, as far as they go while typing. */
export function formatUs(digits: string): string {
  const d = digits.replace(/\D/g, '').slice(0, 10)
  if (d.length <= 3) return d
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

/**
 * A typed or pasted number, judged. Any common US format works: spaces, dashes, dots, brackets, a leading 1 or +1.
 * Not a US number, a number in Canada or the Caribbean (+1 but dearer, and the scam routes), a premium line, and
 * anything that does not parse are refused, each with its own reason. 911 and 933 are recognised first.
 */
export function parseDestination(raw: unknown): Parsed {
  if (typeof raw !== 'string') return no('format')
  // A SIP address may come with a display name and angle brackets: only what is inside them is the address.
  const text = (/<([^>]*)>/.exec(raw)?.[1] ?? raw).trim()
  if (text.length === 0 || text.length > 80) return no('format')
  // Telnyx may name the destination as a SIP or tel URI (`sip:911@sip.telnyx.com`, `tel:+16265550123`): the user part is the number.
  const user = /^(?:sips?|tel):/i.test(text) ? text.replace(/^(?:sips?|tel):/i, '').replace(/[@;>].*$/, '') : text
  if (user.length === 0 || user.length > 40) return no('format')
  // Digits, and the punctuation people paste. Letters ("1-800-FLOWERS") are not guessed at.
  if (!/^\+?[\d\s().-]+$/.test(user)) return no('format')
  const plus = user.startsWith('+')
  const digits = user.replace(/\D/g, '')
  // 911 and 933 in every form a person or Telnyx might give them: 911, 1911, +1911, with a SIP or tel prefix.
  const code = digits === '1911' || digits === '1933' ? digits.slice(1) : plus ? '' : digits
  if (code === EMERGENCY) return { ok: true, dest: { kind: 'emergency', e164: EMERGENCY, display: EMERGENCY } }
  if (code === EMERGENCY_TEST) return { ok: true, dest: { kind: 'test', e164: EMERGENCY_TEST, display: EMERGENCY_TEST } }
  // International forms: +<other country>, or the 011 and 00 exit prefixes.
  if ((plus && !digits.startsWith('1')) || digits.startsWith('011') || digits.startsWith('00')) return no('country')
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (!/^[2-9]\d\d[2-9]\d{6}$/.test(national)) return no('format')
  const area = national.slice(0, 3)
  // N11 is a service code (211, 411, 911), never an area code: 911 followed by seven digits is not a number to dial.
  if (area.endsWith('11')) return no('format')
  if (CANADA.has(area) || CARIBBEAN.has(area) || TERRITORIES.has(area)) return no('territory')
  if (PREMIUM.has(area)) return no('premium')
  // Premium and service exchanges inside an ordinary area code: 976 (pay-per-call) and N11 (311, 411, 911 ...), which are never a
  // line anyone owns. A 10-digit number here is refused as the premium line it would be, not read as 911 or as a service code.
  const exchange = national.slice(3, 6)
  if (exchange === '976' || exchange.endsWith('11')) return no('premium')
  return { ok: true, dest: { kind: 'us', e164: `+1${national}`, display: formatUs(national) } }
}

/** A number as people read it in the log: the same judgment, without the refusal. */
export function displayNumber(e164: string): string {
  const p = parseDestination(e164)
  return p.ok ? p.dest.display : e164
}

/** True for 911 and 933, the two that bypass every rule. */
export const isEmergency = (d: Destination): boolean => d.kind !== 'us'

// --- The 911 address -------------------------------------------------------

export interface E911Address {
  street: string
  /** Apartment, suite, floor: optional. */
  extended: string
  city: string
  /** Two letters, upper case. */
  state: string
  zip: string
}

const STATES = new Set(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '),
)

const oneLine = (v: unknown, max: number): string =>
  typeof v === 'string'
    ? v
        // the control characters themselves are what is being removed
        .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : ''

/** An address as typed, cleaned and checked for shape. Telnyx validates that it exists; this stops nonsense first. */
export function cleanAddress(raw: unknown): { ok: true; address: E911Address } | { ok: false; message: string } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const address: E911Address = {
    street: oneLine(r.street, 100),
    extended: oneLine(r.extended, 60),
    city: oneLine(r.city, 100),
    state: oneLine(r.state, 2).toUpperCase(),
    zip: oneLine(r.zip, 10),
  }
  if (!address.street) return { ok: false, message: 'Enter the street address.' }
  if (!address.city) return { ok: false, message: 'Enter the city.' }
  if (!STATES.has(address.state)) return { ok: false, message: 'Enter the two-letter state, such as CA.' }
  if (!/^\d{5}(-\d{4})?$/.test(address.zip)) return { ok: false, message: 'Enter the 5-digit ZIP code.' }
  return { ok: true, address }
}

export const addressLine = (a: E911Address): string =>
  `${a.street}${a.extended ? `, ${a.extended}` : ''}, ${a.city}, ${a.state} ${a.zip}`

// --- What crosses the wire -------------------------------------------------

/** The text of the notice a person acknowledges before their first call (47 CFR 9.11: said plainly, kept when acknowledged). */
export const NOTICE_911 =
  '911 from meet may not work if your internet or power is out, if the address you gave is not where you are, or if you have moved and not updated it. A cell phone is the better phone for an emergency.'

/** The ring time's range, in words, for the form beside the field. */
export const LINE_RING_RANGE = `Between ${LINE.inbound.ringSecondsMin} and ${LINE.inbound.ringSecondsMax} seconds.`

/** What the line does with a call nobody picks up at once: the cell that rings next (or none) and how long meet rings first. */
export interface LineSettings {
  /** E.164, or null: with none, an unanswered call goes from meet straight to voicemail. */
  cell: string | null
  cellDisplay: string | null
  /** How long every phone of the company's people rings before the cell. */
  ringSeconds: number
}

export interface PhoneStatus {
  /** False hides the phone entirely: not configured, or not someone with the dial pad. */
  available: boolean
  /** Which phone the page runs: Telnyx's, or the stand-in a localhost run uses. */
  sdk: 'telnyx' | 'fake'
  /** The line's number, E.164, and as people read it. */
  line: string
  lineDisplay: string
  /** The caller name a call out carries: the company's, as carriers show it (phone-line.ts `lineWords`). */
  callerName: string
  /** An opaque id the page puts on a call so a 911 call can be matched to its person. */
  who: string
  acked: boolean
  address: E911Address | null
  /** Whether Telnyx holds the current address. A call out waits for it. */
  registered: boolean
  /** The person is somewhere other than their address says: ask them to check it. */
  addressCheck: boolean
  /** Can place calls other than 911. */
  ready: boolean
  minutes: { used: number; cap: number }
  notice: string
  settings: LineSettings
  /** The line's owner may change the cell and the ring time; everyone else with the phone sees them and cannot. */
  canEditLine: boolean
}

/**
 * How a call ended. The first six are calls out; the last five are calls in: `ringing` while it is still being worked,
 * then `answered` (a person of the company took it in meet), `forwarded` (the cell took it), `voicemail` (a message was left) or
 * `missed` (nobody, and no message).
 */
export type CallOutcome =
  | 'dialing'
  | 'refused'
  | 'failed'
  | 'abandoned'
  | 'not-answered'
  | 'completed'
  | 'ringing'
  | 'answered'
  | 'forwarded'
  | 'voicemail'
  | 'missed'

/** What a message from "Phone" in the Phone conversation carries beside its text (workspace-model.ts WMessage.phone). */
export type PhoneMessage =
  | { kind: 'voicemail'; id: number; number: string; display: string; seconds: number }
  | { kind: 'missed'; number: string; display: string }
  /** Someone dialed 911 from meet: a notice for every person of the company, kept (it is not deleted from the page). */
  | { kind: 'emergency' }

export interface CallLogRow {
  id: number
  at: number
  /** Calls out: the number called. Calls in: the number that called ('' when it was withheld). */
  direction: 'out' | 'in'
  number: string
  display: string
  outcome: CallOutcome
  reason: string | null
  minutes: number
  emergency: boolean
  /** A call in that was taken, by whom (a name), when a person of the company took it. */
  answeredBy: string | null
}

/** What the page sends with a call so Telnyx's webhook can match it to the approval. Both names are tried: headers and client state. */
export const HEADER_TICKET = 'X-Meet-Ticket'
export const HEADER_WHO = 'X-Meet-Who'

/** A call's client state as the page makes it (base64 of this JSON) and as the Worker reads it back. */
export const clientStateOf = (ticket: string | null, who: string): string => btoa(JSON.stringify({ t: ticket, w: who }))

/** The keys on a phone's keypad, and the ones a call can send as tones (all twelve). */
export const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const
export const KEY_LETTERS: Record<string, string> = { '2': 'ABC', '3': 'DEF', '4': 'GHI', '5': 'JKL', '6': 'MNO', '7': 'PQRS', '8': 'TUV', '9': 'WXYZ', '0': '+' }
