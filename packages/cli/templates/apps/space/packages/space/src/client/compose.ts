// One message being written, from the first keystroke to the answer: its key, its text, what became of it. Pure, so the rules that keep a
// message from going out twice, or being offered again when the space cannot tell whether it went, are checked on their own.
//
// THE KEY. Every compose carries one key, made when the compose begins and kept until the message has been sent (or the person has seen
// it did not and starts another). The apps remember a key that sent something and answer a second use with the first's result
// (`Repeated`); a refusal or a failure forgets it, so pressing Send again with the same key sends. The key is made HERE, once, and never
// again for the same message: a double press, a retry after a refusal and a repeat all carry the same one.
//
// OUTCOME UNKNOWN. When the space loses track of a write (the connection dropped, nothing came back in time, the Worker itself failed after
// it may have sent), the message may have gone. The compose then offers no Send at all: the person is told where to check, and starts another.

import { sniffPicture } from '@space/inbox/src/telegram/wire'
import { INBOX_CAPTION_MAX, INBOX_MOST_FILE_BYTES, INBOX_MOST_FILES, INBOX_PICTURE_MAX_BYTES, INBOX_PICTURE_TYPES, type InboxFrom, REFUSAL_REASONS } from '@space/workspace'
import type { WriteOutcome } from '../conversation'
import { isRecord } from '../guards'

/** A key the apps take: 32 hex digits, which is what `crypto.randomUUID()` is without its dashes (workspace `COMPOSE_KEY`: 16 to 128 of letters, digits, _ and -). */
export const mintKey = (random: () => string = () => crypto.randomUUID()): string => random().replace(/-/g, '')

/** The character the inbox will not send: it reads as machine-written. Written as an escape, once, for every screen that warns of it. */
export const EM_DASH = '\u2014'

export type Phase = 'writing' | 'sending' | 'unknown'

/** What the compose says about how its last send went: `ok` (it went), `warn` (it may have, or it is still going) or `error` (it did not). */
export interface Notice {
  tone: 'ok' | 'warn' | 'error'
  text: string
}

export interface Compose {
  key: string
  text: string
  phase: Phase
  notice: Notice | null
  /** The files chosen to go with an email reply from a business mailbox's thread. Absent is none. Finished with when the message is, as the words are. */
  files?: readonly File[]
  /** The ONE picture chosen to go with a Telegram reply, as a Telegram photo with the words as its caption. Absent is none. Finished with when the message is, as the words are. */
  picture?: ChosenPicture
}

/** How a reply goes: an email in a thread, or a direct message or channel post. Also where to look when the space cannot tell: the inbox's Sent, or the conversation itself. */
export type Way = 'email' | 'chat'

export const newCompose = (mint: () => string = mintKey, notice: Notice | null = null): Compose => ({ key: mint(), text: '', phase: 'writing', notice })

/** The files chosen, none when none were. */
export const filesOf = (c: Compose): readonly File[] => c.files ?? []

/** Choose files (they add to those chosen) or take one out. Only a compose that can be written in changes: one waiting for an answer, or one that cannot be sent again, keeps what it has. */
export const attached = (c: Compose, more: readonly File[]): Compose => (c.phase === 'writing' ? { ...c, files: [...filesOf(c), ...more] } : c)
export const detached = (c: Compose, index: number): Compose => (c.phase === 'writing' ? { ...c, files: filesOf(c).filter((_, n) => n !== index) } : c)

/** Why a set of files cannot go in one message, in words, or null when they can. The inbox's limits (the contract's), said first so the person can fix them before Send. */
export function whyNotFiles(files: readonly Pick<File, 'size' | 'name'>[]): string | null {
  if (files.length > INBOX_MOST_FILES) return `A message carries at most ${INBOX_MOST_FILES} files.`
  const empty = files.find((f) => f.size === 0)
  if (empty) return `${empty.name} is empty.`
  if (files.reduce((n, f) => n + f.size, 0) > INBOX_MOST_FILE_BYTES) return `The files come to more than ${INBOX_MOST_FILE_BYTES / (1024 * 1024)} MB together.`
  return null
}

// ── One picture on a Telegram reply ─────────────────────────────────────────────────────────────
//
// A Telegram chat's reply box takes ONE picture, a PNG or a JPEG, at most 10 MB, with the words typed as its caption (at most 1,024 characters). Chosen with the Attach picture button or pasted from the clipboard,
// shown small with Take out before anything is sent. The limits are said before Send and checked again by the inbox, each by the bytes where it holds them: here the size is known at once and the first bytes are read
// when the picture is chosen, so a file that is not a PNG or a JPEG (whatever its name or type say) is refused in words and Send stays off.

/** What the picker offers: the two kinds the inbox sends as a Telegram photo. The bytes still decide. */
export const PICTURE_ACCEPT = INBOX_PICTURE_TYPES.join(',')

// A picture is told from anything else by the inbox's own `sniffPicture` (packages/inbox/src/telegram/wire.ts: zero dependencies, so the page holds the one function and not a copy of it).

/** The picture chosen for a reply, and what is known of whether it can go: `null` fine, a sentence if not, `'checking'` while its first bytes are being read. */
export interface ChosenPicture {
  file: File
  problem: string | null | 'checking'
}

/** The picture chosen, or none. */
export const pictureOf = (c: Compose): ChosenPicture | undefined => c.picture

/** Why a picture of this size cannot go, in words, or null: the size is known at once. */
export function whyNotSize(file: Pick<File, 'size' | 'name'>): string | null {
  if (file.size === 0) return `${file.name} is empty.`
  if (file.size > INBOX_PICTURE_MAX_BYTES) return `${file.name} is over ${INBOX_PICTURE_MAX_BYTES / (1024 * 1024)} MB, the most Telegram takes in a picture.`
  return null
}

/** Why the words under a picture cannot go, or null: at most 1,024 characters, and never split into a second message. */
export const whyNotCaption = (text: string): string | null =>
  text.length > INBOX_CAPTION_MAX ? `Words under a picture are at most ${INBOX_CAPTION_MAX} characters (these are ${text.length}). Shorten them, or send them as their own message.` : null

/** Choose a picture (only a compose that can be written in takes it, and only when none is chosen: Take out the first to change it). Its size is judged at once; its first bytes are read next (`pictureChecked`). */
export const withPicture = (c: Compose, file: File): Compose =>
  c.phase !== 'writing' || c.picture !== undefined ? c : { ...c, picture: { file, problem: whyNotSize(file) ?? 'checking' } }

/** The first bytes of the chosen picture have been read: it is one or it is not. A picture taken out or replaced meanwhile is not touched. */
export const pictureChecked = (c: Compose, file: File, isPicture: boolean): Compose =>
  c.picture === undefined || c.picture.file !== file || c.picture.problem !== 'checking'
    ? c
    : { ...c, picture: { file, problem: isPicture ? null : `${file.name} is not a PNG or a JPEG, so Telegram would not take it as a picture.` } }

/**
 * The picture on the clipboard of a paste, when the paste IS a picture: a PNG or a JPEG file and no plain words. Any paste with plain words is the browser's own (a spreadsheet's cells carry both a picture and their
 * words, and must paste as words), and so is a paste with no picture. Null otherwise.
 */
export function pastedPicture(data: Pick<DataTransfer, 'files' | 'getData'> | null): File | null {
  if (data === null || data.getData('text/plain') !== '') return null
  return Array.from(data.files).find((f) => (INBOX_PICTURE_TYPES as readonly string[]).includes(f.type)) ?? null
}

/**
 * Choose a picture for a compose and read its first bytes: the picture is on at once (judged by its size), and a moment later it is known to be a PNG or a JPEG, or it is refused in words. A second picture while one is
 * chosen changes nothing but the notice (the box says one picture per message).
 */
export function choosePicture(file: File, update: (change: (c: Compose) => Compose) => void): void {
  update((c) =>
    c.phase === 'writing' && c.picture !== undefined
      ? { ...c, notice: { tone: 'warn', text: 'A message carries one picture. Take the first out to use another.' } }
      : { ...withPicture(c, file), ...(c.phase === 'writing' && { notice: null }) },
  )
  void file
    .slice(0, 16)
    .arrayBuffer()
    .then((buffer) => update((c) => pictureChecked(c, file, sniffPicture(new Uint8Array(buffer)) !== null)))
    .catch(() => update((c) => pictureChecked(c, file, false)))
}

/** Take the picture out again. */
export const withoutPicture = (c: Compose): Compose => {
  if (c.phase !== 'writing' || c.picture === undefined) return c
  const { picture: _gone, ...rest } = c
  return rest
}

/** Why the compose cannot be sent because of its picture, in words, or null (also null for no picture). */
export function whyNotPicture(c: Compose): string | null {
  const p = c.picture
  if (p === undefined) return null
  if (p.problem !== null && p.problem !== 'checking') return p.problem
  return whyNotCaption(c.text)
}

/** Whether a message can be sent: some words (or a picture, which speaks for itself), files and a picture within the limits, and nothing waiting on an answer. */
export const canSend = (c: Compose): boolean =>
  c.phase === 'writing' &&
  (c.text.trim() !== '' || c.picture !== undefined) &&
  whyNotFiles(filesOf(c)) === null &&
  (c.picture === undefined || (c.picture.problem === null && whyNotCaption(c.text) === null))

/** Typing. Only a compose that can be written in takes it; one waiting for an answer, or one that cannot be sent again, does not change. */
export const typed = (c: Compose, text: string): Compose => (c.phase === 'writing' ? { ...c, text } : c)

/** Send is pressed: the compose waits for the answer. A second press while it waits changes nothing, so the same message is not asked twice. */
export const begin = (c: Compose): Compose => (canSend(c) ? { ...c, phase: 'sending', notice: null } : c)

/** What a send that is not an email send names, for the notice. */
const WHERE: Record<Way, string> = { email: 'Check Sent in your mail', chat: 'Check the conversation' }

/**
 * The words of an outcome, and whether the compose is finished with its message (`next`) or has it back to send again (`again`) or can do neither (`stuck`). `via` says the message goes on Telegram, where
 * `sending` is not a doubt but the ordinary answer: the inbox has claimed the message and the Telegram bridge sends it within seconds, so the page says so and the conversation shows it when Telegram has it.
 */
export function describe(outcome: WriteOutcome, what: Way, via?: 'telegram'): { notice: Notice; then: 'next' | 'again' | 'stuck' } {
  const telegram = via === 'telegram'
  switch (outcome.result) {
    case 'done':
      return outcome.status === 'sent'
        ? { notice: { tone: 'ok', text: 'Sent.' }, then: 'next' }
        : telegram
          ? { notice: { tone: 'ok', text: 'Sending on Telegram. It shows in the conversation when Telegram has it.' }, then: 'next' }
          : { notice: { tone: 'warn', text: 'Gmail did not say whether this went out. Check Sent in your mail before writing it again.' }, then: 'next' }
    case 'repeated':
      return {
        notice:
          outcome.earlier === 'sent'
            ? { tone: 'ok', text: 'That was already sent the first time. Nothing new went out.' }
            : outcome.earlier === 'sending'
              ? telegram
                ? { tone: 'warn', text: 'That is already on its way to Telegram. Nothing new went out.' }
                : { tone: 'warn', text: 'That was already sent once, and Gmail did not say whether it went out. Check Sent in your mail. Nothing new went out.' }
              : { tone: 'warn', text: 'That is still being sent. Nothing new went out.' },
        then: 'next',
      }
    case 'refused':
      // The app's own words, kept: "a new message arrived, read it first". The text stays and the key stays, so pressing Send again sends.
      return { notice: { tone: 'error', text: outcome.message }, then: 'again' }
    case 'failed':
      return { notice: { tone: 'error', text: `Nothing was sent. ${outcome.message}` }, then: 'again' }
    case 'outcome-unknown':
      return {
        notice: { tone: 'error', text: `The space lost track of this message and cannot tell whether it went out. ${telegram ? 'Check Telegram' : WHERE[what]} before writing it again. It will not be sent a second time from here.` },
        then: 'stuck',
      }
  }
}

/**
 * The compose after the answer. A message that went (or that the app says went before) is finished: a new compose with a new key, carrying the
 * notice. A refusal or a failure gives the message back, key and text unchanged. An unknown outcome leaves it as it was, with no way to send.
 */
export function settle(c: Compose, outcome: WriteOutcome, what: Way, mint: () => string = mintKey, via?: 'telegram'): Compose {
  const { notice, then } = describe(outcome, what, via)
  if (then === 'next') return newCompose(mint, notice)
  if (then === 'again') return { ...c, phase: 'writing', notice }
  return { ...c, phase: 'unknown', notice }
}

/** The person has read where to check and is done with the message that could not be sent again: a new compose, a new key. */
export const dismissed = (mint: () => string = mintKey): Compose => newCompose(mint)

// ── What the page asks the Worker, and what it makes of the answer ──────────────────────────────────────────────────────

export type ReplyTarget =
  | { via: 'email'; conversationId: string; through: number; copyEveryone: boolean }
  | { via: 'chat'; conversationId: number }
  /** Someone meet lists with no message yet: meet opens the direct message with them as it posts. */
  | { via: 'chat'; personId: string }
  | { via: 'draft'; draftId: string; rev: number; through: number | null }
  /** A new email to an address: its subject, the name for a contact it makes, and the mailbox it goes out from (absent: the inbox's own rule). */
  | { via: 'new'; address: string; subject: string; name?: string; from?: InboxFrom }

export interface Request {
  url: '/api/email' | '/api/chat'
  body: Record<string, unknown>
}

/** The request for a send: an email in the thread the person chose (to everyone on it when it is shared), a post, or a draft as it stands. */
export function requestFor(target: ReplyTarget, key: string, text: string): Request {
  switch (target.via) {
    case 'email':
      return { url: '/api/email', body: { key, conversationId: target.conversationId, through: target.through, text, ...(target.copyEveryone && { copyEveryone: true }) } }
    case 'chat':
      return { url: '/api/chat', body: { key, ...('personId' in target ? { personId: target.personId } : { conversationId: target.conversationId }), text } }
    case 'draft':
      return { url: '/api/email', body: { key, draftId: target.draftId, rev: target.rev, through: target.through } }
    case 'new':
      return { url: '/api/email', body: { key, address: target.address, subject: target.subject, text, ...(target.name !== undefined && { name: target.name }), ...(target.from !== undefined && { from: target.from }) } }
  }
}

const REASONS = new Set<string>(REFUSAL_REASONS)

/** Whether a body is one of the Worker's write outcomes. A body that is not is never half read: it is an unknown outcome. */
export function isOutcome(v: unknown): v is WriteOutcome {
  if (!isRecord(v) || typeof v.result !== 'string') return false
  switch (v.result) {
    case 'done':
      return v.status === 'sent' || v.status === 'sending'
    case 'repeated':
      return v.earlier === 'in-progress' || v.earlier === 'sent' || v.earlier === 'sending'
    case 'refused':
      return typeof v.reason === 'string' && REASONS.has(v.reason) && typeof v.message === 'string'
    case 'failed':
    case 'outcome-unknown':
      return typeof v.message === 'string'
    default:
      return false
  }
}

/**
 * What the page makes of the Worker's response to a write.
 *
 * - The sign-in ended (a 401, or Access's redirect, which a page that follows none sees as opaque): nothing was sent, and the words say to sign in.
 * - A 4xx from the Worker: it would not take the request, so nothing was sent.
 * - A 200 with an outcome: that outcome.
 * - ANYTHING ELSE (the connection dropped, a 5xx, a 200 that is not an outcome): the Worker may have sent before it failed. UNKNOWN, no second try.
 */
export function outcomeFromResponse(res: { status: number; type?: string; body: unknown } | 'network'): WriteOutcome {
  if (res === 'network') return { result: 'outcome-unknown', message: 'The connection to the space dropped.' }
  if (res.type === 'opaqueredirect' || res.status === 401) return { result: 'refused', reason: 'not-signed-in', message: 'Your sign-in may have ended. Reload the page to sign in again.' }
  if (res.status >= 400 && res.status < 500) {
    const why = isRecord(res.body) && typeof res.body.error === 'string' ? res.body.error : 'The space would not take that.'
    return { result: 'failed', message: why }
  }
  if (res.status === 200 && isOutcome(res.body)) return res.body
  return { result: 'outcome-unknown', message: 'The space did not answer clearly.' }
}
