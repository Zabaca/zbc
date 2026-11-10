/**
 * Mail whose declared charset is wrong, read as what it is. The common case is a sender (Craigslist's relay, many bulk senders) that writes UTF-8 and declares
 * `us-ascii`, `iso-8859-1` or `windows-1252`: the WHATWG Encoding Standard reads all of those labels as windows-1252, so an apostrophe's three bytes become
 * "â€™" ("can’t" shows as "canâ€™t"). Two pure functions, no I/O.
 *
 * - `decodeBody` is for bytes we hold (Gmail's parts): it honours the declared charset, except that for the windows-1252 family it reads the bytes as UTF-8 when they
 *   are valid UTF-8, which text that is really Latin-1 almost never is (an accented letter followed by the wrong kind of byte is not a UTF-8 sequence).
 * - `repairMojibake` is for text already decoded by something we do not control (postal-mime on a Cloudflare arrival) and for mail stored before this fix: it turns the
 *   windows-1252 characters back into their bytes and reads those as UTF-8, and changes nothing unless that succeeds, so ordinary text, real Latin-1 text and text in
 *   any other script come back as they were. It runs on the way to the screen and on parse; it never rewrites a stored row.
 */

/** Every label the Encoding Standard decodes as windows-1252 (a label it does not know, such as `us` or `iso646-us`, falls back to UTF-8 in `decodeBody` anyway), which is what a sender that wrote UTF-8 and declared one of them gets. */
const SINGLE_BYTE_LATIN = new Set([
  'ansi_x3.4-1968',
  'ascii',
  'cp1252',
  'cp819',
  'csisolatin1',
  'ibm819',
  'iso-8859-1',
  'iso-ir-100',
  'iso8859-1',
  'iso88591',
  'iso_8859-1',
  'iso_8859-1:1987',
  'l1',
  'latin1',
  'us-ascii',
  'windows-1252',
  'x-cp1252',
])

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/** Bytes as text in the charset the part declared (UTF-8 when it names none or a label the runtime does not know), or as UTF-8 when it declared a Latin one and the bytes are UTF-8. */
export function decodeBody(bytes: Uint8Array, declared: string): string {
  const label = declared.trim().toLowerCase().replace(/^"|"$/g, '')
  if (SINGLE_BYTE_LATIN.has(label)) {
    try {
      return strictUtf8.decode(bytes)
    } catch {
      // Not UTF-8: it really is the declared charset.
    }
  }
  try {
    return new TextDecoder(label || 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** The byte windows-1252 gives each character it can spell above 0x7F, built once from the runtime's own table so it cannot drift from what a decoder produced. */
let byteOfChar: Map<string, number> | undefined
function windows1252Bytes(): Map<string, number> {
  if (byteOfChar) return byteOfChar
  const decoder = new TextDecoder('windows-1252')
  const map = new Map<string, number>()
  for (let b = 0x80; b <= 0xff; b++) map.set(decoder.decode(Uint8Array.of(b)), b)
  byteOfChar = map
  return map
}

/** A UTF-8 lead byte (Â to ô) followed by a continuation byte, as windows-1252 spells them: the signature of UTF-8 read as windows-1252. */
const SIGNATURE = /[Â-ô][\u0080-¿ŒœŠšŸŽžƒˆ˜\u2013\u2014‘-‚“-„†-•…‰‹›€™]/

/** The text with UTF-8 that was read as windows-1252 put right; the same text when it is not that, or only some of it is. */
export function repairMojibake(text: string): string {
  if (!SIGNATURE.test(text)) return text
  const table = windows1252Bytes()
  const bytes = new Uint8Array(text.length)
  let n = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) as number
    if (code < 0x80) bytes[n++] = code
    else {
      const b = table.get(ch)
      // A character windows-1252 cannot spell (any other script, an emoji): this text was not read as windows-1252, leave it.
      if (b === undefined) return text
      bytes[n++] = b
    }
  }
  try {
    return strictUtf8.decode(bytes.subarray(0, n))
  } catch {
    return text
  }
}
