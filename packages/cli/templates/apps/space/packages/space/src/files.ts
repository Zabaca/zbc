// Files on mail: giving one back to the person who is
// signed in, and reading a reply that carries files.
//
// ── A FILE IS NEVER A PUBLIC ADDRESS ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// A file a stranger sent to a business mailbox has no address of its own. The page asks THIS Worker, `GET /api/attachment?m=<message>&n=<place>`, which is behind
// the same sign-in as everything else here (the Worker checks it on every request, before any route), and this Worker asks the inbox's entrypoint with the
// assertion it received; the inbox verifies it again and admits its owner alone. Nothing here names a person, nothing is cached (`no-store`), and nothing is kept.
// A file is named by the message's id and its place in the message's list, both of which the inbox checks as the shapes they are and looks up; a caller can
// ask only for what the inbox lists.
//
// ── WHAT A BROWSER MAY DO WITH IT ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The inbox decides what a file is allowed to be: a picture it has checked by its first bytes is `inline` and is served as the type those bytes name; anything
// else is a download, `application/octet-stream`, saved and never shown. This Worker adds what it must on top of that, whatever the inbox said: `nosniff`, a policy
// that lets the file do nothing in the space's origin (`default-src 'none'; sandbox`), `no-store`, and the file name cleaned for the header again with the workspace's rule, the one the inbox uses (a name
// is a stranger's text). A file the inbox calls inline is served inline only when its type is one of the four picture types (or the one sound and three video types of a Telegram file), so an inbox that was wrong or
// compromised cannot make the space serve HTML as a page.

import { contentDisposition, type FileRange, INBOX_MOST_FILE_BYTES, INBOX_MOST_FILES, type InboxFile, type InboxFileOut, plainFilename, type Reached } from '@space/workspace'
import { isRecord } from './guards'
import type { Asking } from './list'
import { notConnected, reach } from './reach'

/** What a message id and a place look like (the inbox's own are uuids; this keeps a path-shaped string out of the question). */
const MESSAGE_ID = /^[A-Za-z0-9-]{1,64}$/

export type FileQuery = { messageId: string; index: number; how: 'view' | 'download' }

/** `?m=<message id>&n=<place>&how=view|download`, or null when it is not a question the inbox could be asked. `how` is `view` unless it says `download`. */
export function parseFileQuery(q: { m?: string | undefined; n?: string | undefined; how?: string | undefined }): FileQuery | null {
  if (q.m === undefined || !MESSAGE_ID.test(q.m)) return null
  if (q.n === undefined || !/^\d{1,3}$/.test(q.n)) return null
  if (q.how !== undefined && q.how !== 'view' && q.how !== 'download') return null
  return { messageId: q.m, index: Number(q.n), how: q.how ?? 'view' }
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/** A file as the inbox hands it: the plain facts, and, when it is only a part, a part that agrees with its own bytes and with the length of the whole (a part that does not is a fault, never served). */
const isFileOut = (v: unknown): v is InboxFileOut => {
  if (!(isRecord(v) && typeof v.name === 'string' && typeof v.type === 'string' && typeof v.inline === 'boolean' && v.bytes instanceof Uint8Array)) return false
  if (v.total !== undefined && !isCount(v.total)) return false
  if (v.unsatisfiable !== undefined) return v.unsatisfiable === true && v.total !== undefined && v.part === undefined
  if (v.part === undefined) return true
  const part = v.part
  return v.total !== undefined && isRecord(part) && isCount(part.first) && isCount(part.last) && part.first <= part.last && part.last < v.total && v.bytes.length === part.last - part.first + 1
}

export type Opened = { ok: true; file: InboxFileOut } | { ok: false; status: 400 | 403 | 404 | 502 | 503; message: string }

/**
 * How long a file is waited for: 15 seconds, not the 4 of a list's read (`ANSWER_WITHIN_MS`), which is sized for a list of a few hundred rows. A file is read out of the
 * inbox's raw-mail bucket and, for mail that arrived, the whole message is parsed to find it, one read at a time (Mailroom.readKept), so a conversation with several
 * pictures has the later ones waiting their turn; and the answer carries up to 10 MB across the binding (a Telegram video comes a part at a time, `INBOX_FILE_PART_BYTES`, each part its own call with this
 * limit). 15 seconds covers that with room, and still ends well before a browser gives up on an image. A test sets `answerWithinMs` to shorten it; production never does.
 */
export const FILE_WITHIN_MS = 15_000

/**
 * Ask the inbox for one file, as a read: up to FILE_WITHIN_MS, and anything but the file is said in words with a status the page can act on. `range` is the part wanted (a viewed voice note or video, or the next part
 * of a file read on); the inbox ignores it for any other file.
 */
export async function openFile(ask: Asking, q: FileQuery, range?: FileRange): Promise<Opened> {
  const { inbox } = ask.apps
  if (!inbox) return { ok: false, status: 503, message: notConnected('Email').message }
  const got: Reached<InboxFileOut> = await reach('Email', () => (range ? inbox.attachment(ask.signedIn, q.messageId, q.index, q.how, range) : inbox.attachment(ask.signedIn, q.messageId, q.index, q.how)), isFileOut, ask.answerWithinMs ?? FILE_WITHIN_MS)
  if (got.ok) return { ok: true, file: got.value }
  if (got.kind === 'refused') {
    switch (got.reason) {
      case 'not-admitted':
      case 'not-signed-in':
        return { ok: false, status: 403, message: 'This is not open to you.' }
      case 'not-found':
        return { ok: false, status: 404, message: 'There is no such file.' }
      default:
        // bad-request, conflict, limit: the inbox will not give it that way, in its own words.
        return { ok: false, status: 400, message: got.message }
    }
  }
  // A fault the inbox knew of is a bad gateway; silence, a timeout or an answer that could not be read is the inbox being unavailable.
  return { ok: false, status: got.reason === 'broken' ? 502 : 503, message: got.message }
}

/** A view of bytes as a body: the bytes are never copied. */
const asBody = (bytes: Uint8Array): BodyInit => bytes as unknown as BodyInit

const PICTURES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** A voice note from Telegram (Opus in an Ogg file), the one kind of sound the inbox plays: served inline, as the type its first bytes named. */
const SOUNDS = new Set(['audio/ogg'])
/** A video from Telegram (an MP4, a QuickTime movie or a WebM), the one kind of video the inbox plays: served inline, as the type its first bytes named, and in ranges like a sound (Safari will not play a video it is given whole). */
const VIDEOS = new Set(['video/mp4', 'video/quicktime', 'video/webm'])

/**
 * The rest of a file the inbox handed over a part at a time, as one stream: the first part, then `more(from)` for each next one until the file's length is reached. A part that does not follow on exactly (a refusal,
 * a part from elsewhere in the file, an empty one, a file whose length changed) ends the stream in an error, so a download that cannot be finished is cut short and never a file with a hole in it. Only one part is
 * held at a time.
 */
function partsOf(first: InboxFileOut, total: number, more: (from: number) => Promise<InboxFileOut | null>): ReadableStream<Uint8Array> {
  let next = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next === 0) {
        next = (first.part?.last ?? -1) + 1
        controller.enqueue(first.bytes)
      } else {
        const got = await more(next).catch(() => null)
        if (!got || got.unsatisfiable || !got.part || got.part.first !== next || got.total !== total) {
          controller.error(new Error('the file could not be read to its end'))
          return
        }
        next = got.part.last + 1
        controller.enqueue(got.bytes)
      }
      if (next >= total) controller.close()
    },
  })
}

/**
 * The response that gives a file back: the headers above, whatever the inbox said. `range` is the request's byte range (already parsed), honoured for a sound or a video only: the inbox then answers just that part
 * (`file.part`, at most `INBOX_FILE_PART_BYTES`, so `bytes=0-` over a long video is answered with its first part, which a browser takes as it asks for the next), or `unsatisfiable` (416). A file the inbox hands over in
 * parts although no range was asked for (a Telegram video over `INBOX_FILE_WHOLE_BYTES`, being saved, or fetched by a request with several ranges) is answered whole, whatever its size: the first part is held and
 * `more(from)` asks for each next one as the response is read.
 */
export function fileResponse(file: InboxFileOut, range?: FileRange | null, more?: (from: number) => Promise<InboxFileOut | null>): Response {
  const picture = file.inline && PICTURES.has(file.type)
  const sound = file.inline && SOUNDS.has(file.type)
  const video = file.inline && VIDEOS.has(file.type)
  const shown = picture || sound || video
  const total = file.total ?? file.bytes.length
  const headers = (length: number): Record<string, string> => ({
    'content-type': shown ? file.type : 'application/octet-stream',
    'content-length': String(length),
    ...((sound || video) && { 'accept-ranges': 'bytes' }),
    'content-disposition': contentDisposition(shown ? 'inline' : 'attachment', file.name),
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'",
    'cache-control': 'private, no-store',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex',
  })
  if (file.unsatisfiable) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}`, 'cache-control': 'private, no-store' } })
  const part = file.part
  if (part !== undefined && range && (sound || video)) {
    return new Response(asBody(file.bytes), { status: 206, headers: { ...headers(file.bytes.length), 'content-range': `bytes ${part.first}-${part.last}/${total}` } })
  }
  if (part !== undefined) {
    // Whole, in parts. It must start at the start, and there must be a way to ask for the rest.
    if (part.first !== 0 || !more) return new Response('The file could not be read.', { status: 502, headers: { 'cache-control': 'private, no-store' } })
    return new Response(part.last + 1 >= total ? asBody(file.bytes) : partsOf(file, total, more), { status: 200, headers: headers(total) })
  }
  return new Response(asBody(file.bytes), { status: 200, headers: headers(file.bytes.length) })
}

// ── A reply with files ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The most a reply with files may weigh on the wire: the files' own limit as a form, the words and a margin. */
export const FORM_MAX = INBOX_MOST_FILE_BYTES + 2 * 1024 * 1024

/**
 * The files of a reply, read from the form the page posts (`file` parts). Counted and weighed here, so a reply past the limit is refused before the inbox is
 * asked anything. An empty file is refused by name. The inbox cleans the names and types again; nothing here is trusted by it.
 */
export async function readFiles(form: FormData): Promise<{ ok: true; files: InboxFile[] } | { ok: false; message: string }> {
  const files: InboxFile[] = []
  let total = 0
  for (const [name, entry] of form.entries()) {
    const value: unknown = entry
    if (name !== 'file') continue
    if (!(value instanceof File)) return { ok: false, message: 'A file is a file.' }
    if (files.length >= INBOX_MOST_FILES) return { ok: false, message: `A message carries at most ${INBOX_MOST_FILES} files.` }
    if (value.size === 0) return { ok: false, message: `${plainFilename(String(value.name ?? ''))} is empty.` }
    total += value.size
    if (total > INBOX_MOST_FILE_BYTES) return { ok: false, message: `The files come to more than ${INBOX_MOST_FILE_BYTES / (1024 * 1024)} MB together.` }
    files.push({ name: value.name, type: value.type, bytes: new Uint8Array(await value.arrayBuffer()) })
  }
  return { ok: true, files }
}
