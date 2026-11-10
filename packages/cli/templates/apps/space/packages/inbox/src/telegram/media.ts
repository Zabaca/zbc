/**
 * Photos, voice notes, pictures sent as files and videos from Telegram (ADR 0001 decision 32, including its follow-up that added images and videos).
 *
 * ── WHAT IS COPIED, AND WHAT IS NOT ──────────────────────────────────────
 * A photo, a voice note, an image sent as a file (png, jpeg, webp or heic; never a gif) and a video, at most `telegramFileMax(kind)` (10 MB; 50 MB for a video), in a one-to-one chat or a group. They are copied into the raw-mail
 * bucket (`tg/<message id>`, a key of their own, so nothing that reads `in/` or `out/` ever meets one) and shown to the owner alone, as a Cloudflare mailbox's files are: a picture as a thumbnail (a heic one is
 * saved, not shown: no browser but Safari draws it), a voice note as a player, a video as a player. Everything else a message can carry (a document, a sticker, a GIF, audio that is not a voice note) is named with its kind and
 * size and left in Telegram, and so is every file in a channel (Bulk is not worth the storage) and every file over the limit, which says so in words. A location, a contact and a poll have no file and are only the bracketed words of the message.
 *
 * ── THE MESSAGE FIRST, THE FILE AFTER ────────────────────────────────────
 * A push stores the message with the file named (`message.attachments`, `tg.copy: 'owed'`) in the same transaction as the words, and writes one `setting` row `telegram-media-owed:<message id>`. The bridge is
 * offered that row by the work request, downloads the file and uploads it on the door's `media` call. A download that fails never touches the message: it stays, with the file named and a line that says
 * why it was not copied. No migration: the file's facts are in the `attachments` JSON the message already has, and its bytes are named by `raw_key`.
 *
 * ── THE BYTES ARE A STRANGER'S ───────────────────────────────────────────
 * The bridge's upload is accepted only for a file the space asked for (a row owed), at most `telegramFileMax(kind)`, and is put in the bucket under the message's own key, as a stream (it is never held whole: a Durable Object's RPC carries 32 MiB at most). A file is served only after its first bytes say what it is
 * (a picture of the four kinds, or an Ogg voice note) and as the type THEY name; anything else is a download, `application/octet-stream`, never shown. A file Telegram's sender deleted for everyone
 * is removed with the message (`telegram-media-drop:<key>` is written in the same transaction and swept after).
 *
 * This module holds the pure parts (the rule, the words, the sniff) and the class that keeps a file in the bucket; the store's half is in src/store/telegram.ts.
 */
import type { RawBucket } from '../cloudflare/arrivals'
import { fail, ok, type Result } from '../store/store'
import type { TelegramStore } from '../store/telegram'
import type { TelegramFile } from '../types'
import {
  isCopiedKind,
  type MediaResult,
  sniffPicture,
  type TelegramMedia,
  type TelegramMediaQuery,
  type TelegramPictureQuery,
  type TelegramPictureType,
  telegramFileMax,
} from './wire'

/** The `setting` rows that say the bridge is owed the bytes of a message's file: `telegram-media-owed:<message id>`, the value a small JSON object (`parseOwedMedia` in src/store/telegram.ts: the chat, the message and the kind). */
export const MEDIA_OWED_PREFIX = 'telegram-media-owed:'

/** The `setting` rows that say an object in the bucket is to be deleted (its message was deleted for everyone): `telegram-media-drop:<key>`. Swept by `TelegramMediaKeeper.sweepTelegramMedia`. */
export const MEDIA_DROP_PREFIX = 'telegram-media-drop:'

/** How long a file the bridge has not got is still asked for (a week), after which it is given up on as `failed` and the line says so. */
export const MEDIA_OWED_FOR_MS = 7 * 86_400_000

/** The object key of a message's file. Its own prefix: no mail ever has it. */
export const mediaKey = (messageId: string): string => `tg/${messageId}`

/** What a message's file is called where a file is listed. Words, never Telegram's own file name (a name is a stranger's text); the extension is only for a download's name. */
export const MEDIA_NAMES: Record<TelegramFile['kind'], string> = {
  photo: 'Photo.jpg',
  voice: 'Voice note.ogg',
  audio: 'Audio',
  video: 'Video',
  gif: 'GIF',
  sticker: 'Sticker',
  file: 'File',
  image: 'Image',
}

/** The extension a download of an image or video is named with, from the type the sender's app declared (a table of ours: nothing of the declared text reaches a name). */
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
}

/** The name of a file in a list of files: words, with the extension of its declared type when it is an image or a video. */
export function mediaName(media: TelegramMedia): string {
  const base = MEDIA_NAMES[media.kind]
  if (media.kind !== 'image' && media.kind !== 'video') return base
  const extension = media.mime === undefined ? undefined : EXTENSIONS[media.mime.toLowerCase()]
  return extension === undefined ? base : `${base}.${extension}`
}

/**
 * What becomes of a message's file at arrival: the facts the inbox keeps. `chatKind` is the chat the message is in. A photo or a voice note in a person's chat or a group whose size is unknown or within the limit
 * is owed to the bridge (`owed`); every other file stays in Telegram (`left`) for the reason in `why`. A bot's chat and a channel are Bulk and not worth the storage: their files are named only.
 */
export function planTelegramFile(media: TelegramMedia, chatKind: 'user' | 'bot' | 'group' | 'channel'): TelegramFile {
  const base = { kind: media.kind, ...(media.seconds !== undefined && { seconds: media.seconds }) }
  if (chatKind === 'channel') return { ...base, copy: 'left', why: 'channel' }
  if (chatKind === 'bot') return { ...base, copy: 'left', why: 'bot' }
  if (!isCopiedKind(media.kind)) return { ...base, copy: 'left', why: 'kind' }
  if (media.size !== undefined && media.size > telegramFileMax(media.kind))
    return { ...base, copy: 'left', why: 'too-large' }
  return { ...base, copy: 'owed' }
}

/** The `attachments` entry for a message's file, as the store keeps it. */
export const attachmentOf = (
  media: TelegramMedia,
  file: TelegramFile,
): { name: string; size: number; mimeType?: string; tg: TelegramFile } => ({
  name: mediaName(media),
  size: media.size ?? 0,
  ...(media.mime !== undefined && { mimeType: media.mime }),
  tg: file,
})

/**
 * The line under a file that is not shown, in the words the owner reads. Absent for a file that is kept. A file over the limit says so and says where it is; the same sentence for everything left in Telegram that
 * is not too large, because there is nothing to do about it here either.
 */
export function telegramFileNote(tg: TelegramFile): string | undefined {
  if (tg.copy === 'kept') return undefined
  if (tg.copy === 'owed') return 'Copying from Telegram.'
  switch (tg.why) {
    case 'too-large':
      return 'Too large to copy. Open it in Telegram.'
    case 'gone':
      return 'Telegram no longer has this file. Open the chat in Telegram.'
    case 'failed':
      return 'Could not be copied. Open it in Telegram.'
    default:
      return 'Not copied here. Open it in Telegram.'
  }
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
  bytes.length >= at + signature.length && signature.every((b, i) => bytes[at + i] === b)

/** A voice note by its first bytes: Telegram's are Opus in an Ogg file, which begins "OggS". The only audio type the inbox plays; anything else is saved, never played. */
export const sniffVoice = (bytes: Uint8Array): 'audio/ogg' | null =>
  startsWith(bytes, [0x4f, 0x67, 0x67, 0x53]) ? 'audio/ogg' : null

/**
 * A video by its first bytes: an MP4 or a QuickTime movie (a box named `ftyp` at byte 4; the brand `qt  ` is QuickTime's) or a WebM (an EBML header). The only video types the inbox plays; anything else is saved,
 * never played. Telegram's own videos are MP4; a screen recording sent as a file is often QuickTime.
 */
export function sniffVideo(bytes: Uint8Array): 'video/mp4' | 'video/quicktime' | 'video/webm' | null {
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4))
    return startsWith(bytes, [0x71, 0x74, 0x20, 0x20], 8) ? 'video/quicktime' : 'video/mp4'
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm'
  return null
}

/**
 * What the bridge asked the keeper to keep: the file as a stream and the length the door was told it has (`Content-Length`). The file is never held whole here: a Durable Object's RPC carries 32 MiB at most and a
 * video may be 50 MB, so the door hands the body on as the stream it arrived as, and the bucket takes it from there.
 */
export interface KeepInput extends TelegramMediaQuery {
  body: ReadableStream<Uint8Array>
  length: number
}

export interface KeeperPorts {
  store: TelegramStore
  bucket: RawBucket
  /**
   * The stream, held to exactly `length` bytes: more or fewer is an error that fails the write. R2 takes a stream only when it knows its length (`FixedLengthStream`), so the Durable Object passes that; the default
   * counts instead, which a test on Bun can run.
   */
  bounded?: (body: ReadableStream<Uint8Array>, length: number) => ReadableStream<Uint8Array>
}

/** The stream held to exactly `length` bytes by counting: it errors when it carries more or fewer. */
export function countedStream(body: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  let seen = 0
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength
        if (seen > length) throw new Error('the file is longer than it said')
        controller.enqueue(chunk)
      },
      flush() {
        if (seen !== length) throw new Error('the file is shorter than it said')
      },
    }),
  )
}

/** What a file the bridge brought is refused for, in words the bridge logs. */
const NOT_OWED = 'The space is not waiting for that file.'

/** The SHA-256 of some bytes, lowercase hex: a picture's fingerprint. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * A picture the owner sends, written to the bucket under the draft's own key, `tg/<draft id>`: the object first, the store told after (the claim names it on the draft in its own transaction). The caller
 * has already checked the bytes by their first bytes and their length, and deletes the object again with `dropPicture` when the claim fails. It is the one place a picture the inbox SENDS is written; the files
 * that ARRIVE are the keeper's. (The key is the draft's own, `tg/<draft id>`, which the sent message keeps.)
 */
export async function putPicture(bucket: RawBucket, draftId: string, bytes: Uint8Array): Promise<void> {
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  await bucket.put(mediaKey(draftId), body, { customMetadata: { draft: draftId } })
}

/** The bytes a draft's picture object holds now, or null when there is none or it cannot be read; read before a replacement overwrites them, so a replacement that fails can put them back. */
export async function readPictureObject(bucket: RawBucket, draftId: string): Promise<Uint8Array | null> {
  try {
    const object = await bucket.get(mediaKey(draftId))
    return object ? new Uint8Array(await object.arrayBuffer()) : null
  } catch (error) {
    console.error(
      'telegram picture: could not read the picture a replacement would overwrite',
      error instanceof Error ? error.message : error,
    )
    return null
  }
}

/** The object of a picture whose draft did not take it, deleted again. Best effort: a failure leaves an object nothing names, which costs a few kilobytes and is logged. */
export async function dropPicture(bucket: RawBucket, draftId: string): Promise<void> {
  try {
    await bucket.delete(mediaKey(draftId))
  } catch (error) {
    console.error(
      'telegram picture: could not delete an object nobody wants',
      error instanceof Error ? error.message : error,
    )
  }
}

/** A picture the door gives the bridge: its bytes and its type. */
export interface PictureOut {
  bytes: Uint8Array
  type: TelegramPictureType
}

/**
 * Keeps a file in the bucket. The bucket belongs to the Durable Object's env and not to the store, so this is the one place a Telegram file is written or deleted; the store only says what is owed
 * and what is to be dropped, in its own transaction.
 */
export class TelegramMediaKeeper {
  constructor(private readonly ports: KeeperPorts) {}

  /**
   * One file, for the message the store is waiting on. Refused when nothing is owed for that message (already kept, refused, never asked: a leaked bridge token cannot fill the bucket), when it is
   * empty, or when it is over the limit of its kind (then the store is told it will never be copied, so the line under the message says so and it is not asked for again). The object is written first and the
   * store told after; if the store no longer wants it (the message was deleted meanwhile) the object is deleted again. The body is a stream, read once, into the bucket.
   */
  async keepTelegramMedia(input: KeepInput): Promise<Result<MediaResult>> {
    const owed = this.ports.store.telegramMediaOwedFor(input.account, input.chatId, input.id)
    const refuse = async <T>(r: Result<T>): Promise<Result<T>> => {
      await input.body.cancel().catch(() => undefined)
      return r
    }
    if (!owed.ok) return refuse(owed)
    if (owed.value === null) return refuse(fail(409, NOT_OWED))
    if (input.length === 0) return refuse(fail(422, 'The file is empty.'))
    if (input.length > telegramFileMax(owed.value.kind)) {
      this.ports.store.refuseTelegramMedia(input.account, input.chatId, input.id, 'too-large')
      return refuse(fail(413, 'The file is larger than the inbox copies.'))
    }
    const key = mediaKey(owed.value.messageId)
    try {
      await this.ports.bucket.put(key, (this.ports.bounded ?? countedStream)(input.body, input.length), {
        customMetadata: { chat: input.chatId, id: String(input.id) },
      })
    } catch (error) {
      console.error('telegram media: the bucket would not take a file', error instanceof Error ? error.message : error)
      return fail(503, 'The inbox could not keep the file.')
    }
    const kept = this.ports.store.finishTelegramMedia(input.account, input.chatId, input.id, key, input.length)
    if (!kept.ok || !kept.value) {
      // Two uploads for one message can pass the check above together: the loser must not delete the copy the winner just kept (it is the same key).
      if (this.ports.store.telegramMediaKeyOf(owed.value.messageId) !== key) await this.drop(key)
      return kept.ok ? fail(409, NOT_OWED) : kept
    }
    return ok({ kept: true, size: input.length })
  }

  /**
   * The picture of a send the bridge is being offered, for the door's seventh call. The store says whether the send is owed, has a picture, was offered and may still be offered (`telegramPictureFor`); the bytes
   * are read here, only after the object is the length the draft names, and are checked again by their first bytes and their fingerprint before they leave. The bridge is the only caller, and Claude is never handed one.
   */
  async readTelegramPicture(query: TelegramPictureQuery): Promise<Result<PictureOut>> {
    const found = this.ports.store.telegramPictureFor(query)
    if (!found.ok) return found
    const { key, facts } = found.value
    try {
      const object = await this.ports.bucket.get(key)
      if (!object) return fail(404, 'The picture is not in the bucket.')
      if (object.size !== undefined && object.size !== facts.size)
        return fail(409, 'The picture is not the length the draft names.')
      const bytes = new Uint8Array(await object.arrayBuffer())
      if (bytes.length !== facts.size) return fail(409, 'The picture is not the length the draft names.')
      if (sniffPicture(bytes) !== facts.type) return fail(409, 'The picture is not the kind the draft names.')
      if ((await sha256Hex(bytes)) !== facts.sha256) return fail(409, 'The picture is not the one the draft names.')
      return ok({ bytes, type: facts.type })
    } catch (error) {
      console.error(
        'telegram picture: the bucket would not give a picture',
        error instanceof Error ? error.message : error,
      )
      return fail(502, 'The inbox could not read the picture.')
    }
  }

  /** Delete the objects the store says are to go (a message deleted for everyone). Each row is removed only after its object is; a failure leaves the row for the next sweep. Answers how many went. */
  async sweepTelegramMedia(): Promise<number> {
    let gone = 0
    for (const key of this.ports.store.telegramMediaToDrop()) {
      try {
        await this.ports.bucket.delete(key)
        this.ports.store.telegramMediaDropped(key)
        gone += 1
      } catch (error) {
        console.error('telegram media: could not delete a file', error instanceof Error ? error.message : error)
      }
    }
    return gone
  }

  private async drop(key: string): Promise<void> {
    try {
      await this.ports.bucket.delete(key)
    } catch (error) {
      console.error(
        'telegram media: could not delete a file nobody wants',
        error instanceof Error ? error.message : error,
      )
    }
  }
}
