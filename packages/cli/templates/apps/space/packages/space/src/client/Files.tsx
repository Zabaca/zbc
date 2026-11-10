// Files on an email and what Cloudflare reported of it : the pieces the conversation draws under a
// message, and the Attach control in the composer. Pure drawing over the contract's shapes; nothing here fetches except the browser asking `/api/attachment` for a
// picture it is showing, which the Worker answers only to the signed-in person (files.ts).
import { useEffect, useRef, useState } from 'react'
import { DELIVERY_PROBLEMS, deliveryLine, INBOX_CAPTION_MAX, INBOX_PICTURE_MAX_BYTES, type InboxAttachment, type InboxDeliveryNote } from '@space/workspace'
import { type ChosenPicture, PICTURE_ACCEPT, whyNotFiles } from './compose'

/** Where the Worker gives a message's file: by the message and the file's place in its list. Same origin, behind the sign-in, never public. */
export const fileUrl = (messageId: string, index: number, how: 'view' | 'download', version?: number): string =>
  `/api/attachment?m=${encodeURIComponent(messageId)}&n=${index}&how=${how}${version === undefined ? '' : `&v=${version}`}`

/** A size a person reads: bytes under a kilobyte, kilobytes under a megabyte, else megabytes with one decimal. */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// A file whose size the inbox did not know (a photo still being copied) is named without one.
const label = (a: InboxAttachment): string => (a.size > 0 ? `${a.name} (${sizeWords(a.size)})` : a.name)

/** A length in seconds as a person reads it: 0:12, 3:05. */
export const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

/**
 * One file as a chip: a link that SAVES it when the inbox can give it (the Worker serves it as a download, never in a page), else its name alone. A file is never
 * opened in a tab here except a picture, which is an image on the page, so there is nothing a stranger's file can run.
 */
function FileChip({ messageId, index, file }: { messageId: string; index: number; file: InboxAttachment }) {
  if (!file.download) {
    // Named only, and the reason said: a message too large for the inbox to open a file from, or the owner's Gmail, where Gmail holds the only copy of every file but a
    // picture. (The answer does not carry the Gmail address of the message, so this is not a link to it; the inbox's own page has one.)
    const why = file.note ?? (file.tooLarge ? 'This message is too large for the inbox to open its files. The whole message is kept.' : 'Gmail holds this file. Open the message in Gmail to get it.')
    const kind = file.note !== undefined ? 'left' : file.tooLarge ? 'too-large' : 'name-only'
    // The inbox's own line, said where it can be read: a file left in Telegram says so and where it is, in the page and not only in a tooltip.
    if (file.note !== undefined) {
      return (
        <span className="file-left" data-testid="file" data-file={kind} title={`${label(file)}. ${why}`}>
          <span className="file-chip">{label(file)}</span>
          <span className="file-note" data-testid="file-note">
            {file.note}
          </span>
        </span>
      )
    }
    return (
      <span className="file-chip" data-testid="file" data-file={kind} title={`${label(file)}. ${why}`}>
        {label(file)}
      </span>
    )
  }
  return (
    <a className="file-chip" href={fileUrl(messageId, index, 'download')} download={file.name} data-testid="file" data-file="download" title={`${label(file)}. Save it.`}>
      {label(file)}
    </a>
  )
}

/** A picture: a thumbnail of fixed height (so the page does not jump as pictures arrive), a click opens it in a new tab. If the Worker will not give it, it becomes the chip it would have been. */
function Thumb({ messageId, index, file }: { messageId: string; index: number; file: InboxAttachment }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <FileChip messageId={messageId} index={index} file={file} />
  const url = fileUrl(messageId, index, 'view')
  return (
    <figure className="file-thumb" data-testid="file" data-file="picture">
      <a href={url} target="_blank" rel="noopener noreferrer" title={`${label(file)}. Open it full size.`}>
        <img src={url} alt={file.name} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      </a>
      <figcaption>{label(file)}</figcaption>
    </figure>
  )
}

/**
 * A voice note from Telegram the inbox has copied: a player over the file, asked of the Worker's own address like a picture, and a Save link beside it for a browser that cannot play Opus in Ogg. Nothing is fetched until
 * it is played (`preload="none"`), so a conversation of voice notes costs nothing to open.
 */
function VoiceNote({ messageId, index, file }: { messageId: string; index: number; file: InboxAttachment }) {
  const [failed, setFailed] = useState(false)
  const url = fileUrl(messageId, index, 'view')
  return (
    <figure className="file-voice" data-testid="file" data-file="voice">
      <figcaption>
        {file.seconds !== undefined ? `Voice note, ${clock(file.seconds)}` : 'Voice note'} ({sizeWords(file.size)})
      </figcaption>
      {/* biome-ignore lint/a11y/useMediaCaption: a voice note has no captions to give */}
      <audio controls preload="none" src={url} onError={() => setFailed(true)} data-testid="voice-player" />
      <a className="file-save" href={fileUrl(messageId, index, 'download')} download={file.name} data-testid="voice-save">
        Save
      </a>
      {failed && (
        <span className="file-note" role="status" data-testid="voice-failed">
          This browser could not play it here. Save it, or open it in Telegram.
        </span>
      )}
    </figure>
  )
}

/**
 * A video from Telegram the inbox has copied: an inline player over the file, asked of the Worker's own address in ranges, and a Save link beside it for a browser that cannot play its codec. Nothing is fetched until it is
 * played (`preload="none"`): the inbox reads a part of the file out of the bucket for each request (at most 8 MiB, so a video of 50 MB is played as the browser asks for it), so a conversation of videos costs nothing to open (and there is no first frame to show: Telegram's thumbnail is not copied).
 */
function VideoClip({ messageId, index, file }: { messageId: string; index: number; file: InboxAttachment }) {
  const [failed, setFailed] = useState(false)
  const url = fileUrl(messageId, index, 'view')
  return (
    <figure className="file-video" data-testid="file" data-file="video">
      <figcaption>
        {file.seconds !== undefined ? `Video, ${clock(file.seconds)}` : 'Video'} ({sizeWords(file.size)})
      </figcaption>
      {/* biome-ignore lint/a11y/useMediaCaption: a video from a chat has no captions to give */}
      <video controls playsInline preload="none" src={url} onError={() => setFailed(true)} data-testid="video-player" />
      <a className="file-save" href={fileUrl(messageId, index, 'download')} download={file.name} data-testid="video-save">
        Save
      </a>
      {failed && (
        <span className="file-note" role="status" data-testid="video-failed">
          This browser could not play it here. Save it, or open it in Telegram.
        </span>
      )}
    </figure>
  )
}

/** The files on a message, a picture as a thumbnail and the rest as chips. Nothing when there are none or the inbox predates files. */
export function MessageFiles({ messageId, files, mine }: { messageId: string; files: readonly InboxAttachment[] | undefined; mine: boolean }) {
  if (!files || files.length === 0) return null
  return (
    <ul className={`files${mine ? ' mine' : ''}`} data-testid="files" aria-label="Files on this email">
      {files.map((f, i) => (
        // The place in the message's list is the file's identity (the Worker names a file by it), and the list never reorders.
        // biome-ignore lint/suspicious/noArrayIndexKey: the index is the identity
        <li key={`${i}-${f.name}`}>{f.picture ? <Thumb messageId={messageId} index={i} file={f} /> : f.play ? <VoiceNote messageId={messageId} index={i} file={f} /> : f.video ? <VideoClip messageId={messageId} index={i} file={f} /> : <FileChip messageId={messageId} index={i} file={f} />}</li>
      ))}
    </ul>
  )
}

/**
 * What Cloudflare reported of a message sent from a business mailbox, one line per recipient it has reported on. A problem is said in the warning colour with
 * Cloudflare's reason and a role of alert, because it is the cue to call; a delivery is quiet; a delay is neither. It is what was reported, as text.
 */
export function DeliveryNotes({ notes, mine }: { notes: readonly InboxDeliveryNote[] | undefined; mine: boolean }) {
  if (!notes || notes.length === 0) return null
  return (
    <ul className={`delivery${mine ? ' mine' : ''}`} data-testid="delivery">
      {notes.map((n) => {
        const problem = DELIVERY_PROBLEMS.includes(n.state)
        return (
          <li key={`${n.recipient}-${n.state}`} data-state={n.state} className={problem ? 'problem' : ''} role={problem ? 'alert' : undefined}>
            {deliveryLine(n)}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The picture chosen for a Telegram reply or draft, small, from the file itself (a local preview: nothing is fetched or sent), named, with its size and Take out. The preview is revoked when the
 * picture goes or the component does. A picture that cannot go says why beside it.
 */
function PicturePreview({ picture, onTakeOut, disabled }: { picture: ChosenPicture; onTakeOut(): void; disabled: boolean }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    // Read from the file itself into a data URL: the page's policy allows images from itself and from `data:` and not `blob:`, and nothing is fetched or sent. Where a browser cannot read it the preview is left out,
    // and the name and size still say what is chosen.
    setUrl(null)
    if (typeof FileReader === 'undefined') return
    let live = true
    const reader = new FileReader()
    reader.onload = () => {
      if (live && typeof reader.result === 'string') setUrl(reader.result)
    }
    reader.readAsDataURL(picture.file)
    return () => {
      live = false
    }
  }, [picture.file])
  const problem = picture.problem !== null && picture.problem !== 'checking' ? picture.problem : null
  return (
    <span className="picture-chosen" data-testid="picture-chosen" data-state={problem ? 'bad' : picture.problem === 'checking' ? 'checking' : 'ok'}>
      {url !== null && !problem && <img src={url} alt="The picture chosen to send" className="picture-preview" data-testid="picture-preview" />}
      <span className="file-chip chosen" data-testid="picture-name">
        {picture.file.name} ({sizeWords(picture.file.size)})
        <button type="button" aria-label={`Take out ${picture.file.name}`} disabled={disabled} onClick={onTakeOut} data-testid="picture-take-out">
          ×
        </button>
      </span>
    </span>
  )
}

/**
 * The picture a Telegram draft carries, on its card: the thumbnail the owner's own attachment route gives for the draft's id (never Claude's: the inbox refuses its token), at the draft's revision so a
 * picture put over another is not shown from the browser's memory, and a line that says whose it is. Nothing when the draft carries none. A picture the inbox will not give becomes the line alone.
 */
export function DraftPicture({ id, rev, picture, byClaude }: { id: string; rev: number; picture: { type: string; size: number } | null | undefined; byClaude: boolean }) {
  const [failed, setFailed] = useState(false)
  if (!picture) return null
  const url = fileUrl(id, 0, 'view', rev)
  return (
    <figure className="draft-picture" data-testid="draft-picture">
      {!failed && (
        <a href={url} target="_blank" rel="noopener noreferrer" title="Open it full size.">
          <img src={url} alt="The picture this draft sends" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
        </a>
      )}
      <figcaption data-testid="draft-picture-note">
        {byClaude ? 'Claude attached this picture.' : 'This draft carries a picture.'} It goes as a photo, with the words above as its caption ({sizeWords(picture.size)}).
      </figcaption>
    </figure>
  )
}

/**
 * Attach picture, in the reply box of a Telegram chat (a person or a group): ONE picture, PNG or JPEG, shown small with Take out before anything is sent, and the limits said before Send. A second picture is
 * not chosen until the first is taken out. `why` is what keeps Send off (the picture's, or the words' under it), said in the box.
 */
export function AttachPicture({ picture, why, onChoose, onTakeOut, disabled, label = 'Attach picture' }: { picture: ChosenPicture | undefined; why: string | null; onChoose(file: File): void; onTakeOut(): void; disabled: boolean; label?: string }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="attach attach-picture" data-testid="attach-picture">
      <input
        ref={input}
        type="file"
        accept={PICTURE_ACCEPT}
        hidden
        data-testid="picture-input"
        onChange={(e) => {
          const chosen = e.target.files?.[0]
          if (chosen) onChoose(chosen)
          e.target.value = ''
        }}
      />
      {picture === undefined ? (
        <button type="button" className="btn" disabled={disabled} onClick={() => input.current?.click()} data-testid="picture-button">
          {label}
        </button>
      ) : (
        <PicturePreview picture={picture} onTakeOut={onTakeOut} disabled={disabled} />
      )}
      <span className="attach-limits sub" data-testid="picture-limits">
        One picture, PNG or JPEG, at most {INBOX_PICTURE_MAX_BYTES / (1024 * 1024)} MB; the words under it, at most {INBOX_CAPTION_MAX} characters. You can also paste a screenshot.
      </span>
      {why && (
        <span className="attach-why" role="alert" data-testid="picture-why">
          {why}
        </span>
      )}
    </div>
  )
}

/**
 * Attach, in the composer of an email reply from a business mailbox's thread: the files chosen with a way to take each out, and the inbox's limits said first. The
 * files are chosen again to add to them. Nothing is sent until Send.
 */
export function AttachFiles({ files, onAdd, onRemove, disabled }: { files: readonly File[]; onAdd(files: File[]): void; onRemove(index: number): void; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const why = whyNotFiles(files)
  return (
    <div className="attach" data-testid="attach">
      <input
        ref={input}
        type="file"
        multiple
        hidden
        data-testid="attach-input"
        onChange={(e) => {
          onAdd(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />
      <button type="button" className="btn" disabled={disabled} onClick={() => input.current?.click()} data-testid="attach-button">
        Attach files
      </button>
      {files.map((f, i) => (
        // Two files may share a name, so their place is their identity until one is taken out.
        // biome-ignore lint/suspicious/noArrayIndexKey: the index is the identity
        <span key={`${i}-${f.name}`} className="file-chip chosen" data-testid="chosen-file">
          {f.name} ({sizeWords(f.size)})
          <button type="button" aria-label={`Take out ${f.name}`} disabled={disabled} onClick={() => onRemove(i)}>
            ×
          </button>
        </span>
      ))}
      {why && (
        <span className="attach-why" role="alert" data-testid="attach-why">
          {why}
        </span>
      )}
    </div>
  )
}
