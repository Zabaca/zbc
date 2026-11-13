// Editing a draft in its card: the inbox's own draft edit, in the space: the subject, the words, on an email who else is copied (the Cc, as addresses the owner can add and take off) and, on a reply, whether everyone on the message it answers is copied. The draft chat with the
// assistant stays beside it, as it was.
//
// REVISION-GUARDED, AS THE INBOX'S IS. A save names the revision the words were written over. When the draft has moved on meanwhile (Claude or the assistant edited it, or another tab), the
// inbox refuses and saves nothing, the card is read again, and this shows the draft's CURRENT subject, who it copies, why it was drafted and its words beside the person's, and says who changed it, with
// two ways out: "Keep mine" (the words stay, now written over the revision on screen, so the next save replaces words that were seen) and "Use the new words" (the boxes take them). Until one is
// chosen, Save names the old revision and is not offered, so nothing is ever replaced unseen. NOTHING HERE SENDS: the draft goes out only by the card's Send, at the revision then shown.
import { type ClipboardEvent, useState } from 'react'
import type { DraftAuthor, InboxDraft } from '@space/workspace'
import type { DraftView } from '../conversation'
import { type ChosenPicture, choosePicture, type Compose, EM_DASH, newCompose, pastedPicture, whyNotCaption, withoutPicture } from './compose'
import { AttachPicture, DraftPicture } from './Files'
import { Say, useAction } from './settings-parts'
import { postView, postViewForm } from './views'

/** Who changed a draft, as the conflict names them (the inbox's own words). */
const WHO: Record<DraftAuthor, string> = { claude: 'Claude', assistant: 'The assistant', owner: 'You', outbox: 'The outbox' }

/** Whether the draft copies everyone on the message it answers: the inbox says so (typed addresses on the Cc do not tick the box). */
export const copiesNow = (draft: Pick<DraftView, 'copiesEveryone'>): boolean => draft.copiesEveryone

/** The draft's Cc as the box shows it: the addresses, comma separated. */
export const ccTextOf = (draft: Pick<DraftView, 'cc'>): string => (draft.cc ?? []).map((c) => c.address).join(', ')

/**
 * The addresses a Cc box holds: split on commas, semicolons, lines and spaces; an entry written `Name <a@x.example>` is the address in the brackets. Not judged here (the inbox refuses what is no address, saving
 * nothing, and says so); only emptied and kept once each, in the order written.
 */
export function parseCc(text: string): string[] {
  const out: string[] = []
  for (const piece of text.split(/[,;\n]+/)) {
    const angled = /<([^<>]*)>\s*$/.exec(piece)?.[1]
    for (const entry of angled !== undefined ? [angled] : piece.split(/\s+/)) {
      const address = entry.trim()
      if (address !== '' && !out.some((o) => o.toLowerCase() === address.toLowerCase())) out.push(address)
    }
  }
  return out
}

/** Whether the Cc box names other people than the draft copies: the same addresses in any order, any case, are no change. */
export const ccChanged = (draft: Pick<DraftView, 'cc'>, ccText: string): boolean => {
  const now = new Set((draft.cc ?? []).map((c) => c.address.toLowerCase()))
  const wanted = parseCc(ccText).map((a) => a.toLowerCase())
  return wanted.length !== now.size || wanted.some((a) => !now.has(a))
}

/** Whether the draft has a Cc the person can change: an email draft whose Cc the inbox told us (an answer without one is an inbox that predates it, and a Cc box would save over a list we cannot see). */
export const takesCc = (draft: Pick<DraftView, 'kind' | 'cc'>): boolean => draft.kind === 'email' && draft.cc !== null

/** Whether the boxes differ from the draft: the inbox trims a draft's words and subject, so an edit that only adds a trailing newline is no change. */
export const isDirty = (draft: Pick<DraftView, 'subject' | 'text' | 'cc' | 'copiesEveryone'>, subject: string, text: string, copy: boolean = copiesNow(draft), ccText: string = ccTextOf(draft)): boolean =>
  subject.trim() !== draft.subject.trim() || text.trim() !== draft.text.trim() || copy !== copiesNow(draft) || ccChanged(draft, ccText)

/** Whether the draft on the card is not the revision the words in the boxes were written over: someone changed it meanwhile. */
export const hasMoved = (draft: Pick<DraftView, 'rev'>, baseRev: number): boolean => draft.rev !== baseRev

/** What the conflict says when the person's words and the draft's are the same: only who is copied, or why it was drafted, changed. */
export const onlyOffPageChanged = (who: string, draft: Pick<DraftView, 'subject' | 'text'>, subject: string, text: string): string | null =>
  draft.text.trim() === text.trim() && draft.subject.trim() === subject.trim() ? `The words are the same; ${who} changed who is copied, or why it was drafted.` : null

/**
 * The picture's part of an edit, for a Telegram draft that can carry one: the picture chosen to go on (or over the one it has), whether the one it has is to be taken out, and the ways to change
 * either. Absent where the draft carries no picture and cannot (an email draft, a draft on no chat): the editor then has no picture control, as before.
 */
export interface PictureEdit {
  chosen: ChosenPicture | undefined
  removed: boolean
  onChoose(file: File): void
  /** Take the newly chosen picture out again (the draft's own, if it has one, is then as it was). */
  onTakeOutChosen(): void
  /** Take the draft's own picture out (at Save), or keep it after all. */
  onRemove(removed: boolean): void
}

/** Whether the draft will carry a picture once saved: one chosen, or the one it has and is not taking out. */
export const willCarryPicture = (draft: Pick<DraftView, 'picture'>, pic: Pick<PictureEdit, 'chosen' | 'removed'> | undefined): boolean =>
  pic !== undefined && (pic.chosen !== undefined || (draft.picture != null && !pic.removed))

/** Whether the picture's part of the edit changes the draft: a picture chosen, or its own taken out. */
export const pictureChanges = (pic: Pick<PictureEdit, 'chosen' | 'removed'> | undefined): boolean => pic !== undefined && (pic.chosen !== undefined || pic.removed)

/** What keeps Save off because of the picture, in words, or null: the chosen picture is not one, or the words under the picture it will carry are too long. */
export function whyNotSavePicture(draft: Pick<DraftView, 'picture'>, pic: PictureEdit | undefined, text: string): string | null {
  if (pic === undefined || !willCarryPicture(draft, pic)) return null
  const problem = pic.chosen?.problem
  if (typeof problem === 'string' && problem !== 'checking') return problem
  return whyNotCaption(text.trim())
}

export interface EditorProps {
  draft: DraftView
  /** The picture's part; absent where the draft cannot carry one. */
  pic?: PictureEdit
  onPaste?(e: ClipboardEvent<HTMLTextAreaElement>): void
  subject: string
  text: string
  copy: boolean
  /** The Cc box's text. */
  cc: string
  /** The revision the words were written over. */
  baseRev: number
  busy: boolean
  onSubject(v: string): void
  onText(v: string): void
  onCopy(v: boolean): void
  onCc(v: string): void
  onSave(): void
  onCancel(): void
  onKeepMine(): void
  onUseTheirs(): void
}

/** The boxes, the conflict when there is one, and the buttons, drawn from literal state. */
export function DraftEditorView(p: EditorProps) {
  const moved = hasMoved(p.draft, p.baseRev)
  // The words of a draft that will carry a picture may be none: the picture speaks for itself.
  const carries = willCarryPicture(p.draft, p.pic)
  const dirty = isDirty(p.draft, p.subject, p.text, p.copy, p.cc) || pictureChanges(p.pic)
  // Who is copied is changed one way at a time: the tick box recomputes the Cc on the inbox, so while it is changed the box is left as the draft has it, and the Cc is edited after it is saved.
  const copyChanged = p.copy !== copiesNow(p.draft)
  const blank = p.text.trim() === '' && !carries
  const pictureWhy = whyNotSavePicture(p.draft, p.pic, p.text)
  const checking = p.pic?.chosen?.problem === 'checking'
  const dash = `${p.subject}${p.text}`.includes(EM_DASH)
  const who = WHO[p.draft.editedBy ?? p.draft.author]
  const same = onlyOffPageChanged(who, p.draft, p.subject, p.text)
  return (
    <div className="de" data-testid="draft-editor">
      {moved && (
        <section className="de-moved" aria-label="The draft changed" data-testid="draft-moved">
          <p>
            <b>{who} changed this draft after you opened it.</b> Nothing of yours was saved. It now says:
          </p>
          {p.draft.subject.trim() !== '' && <p className="sub">Subject: {p.draft.subject}</p>}
          {p.draft.cc !== null && p.draft.cc.length > 0 && <p className="sub">Cc: {p.draft.cc.map((c) => c.address).join(', ')}</p>}
          {p.draft.why.trim() !== '' && <p className="sub">Why: {p.draft.why}</p>}
          {same !== null && <p data-testid="draft-moved-same">{same}</p>}
          <blockquote>{p.draft.text}</blockquote>
          <div className="de-bar">
            <button type="button" className="btn primary" onClick={p.onKeepMine} data-testid="keep-mine">
              Keep mine
            </button>
            <button type="button" className="btn" onClick={p.onUseTheirs} data-testid="use-theirs">
              Use the new words
            </button>
          </div>
        </section>
      )}
      <label className="de-field">
        <span className="nm-label">Subject</span>
        <input type="text" value={p.subject} readOnly={p.busy} maxLength={300} onChange={(e) => p.onSubject(e.target.value)} aria-label="Subject" data-testid="edit-subject" />
      </label>
      <label className="de-field">
        <span className="nm-label">Words</span>
        <textarea rows={7} value={p.text} readOnly={p.busy} onChange={(e) => p.onText(e.target.value)} onPaste={p.onPaste} aria-label="The draft’s words" data-testid="edit-text" />
      </label>
      {p.pic && (
        <div className="de-picture" data-testid="edit-picture">
          {p.pic.chosen === undefined && p.draft.picture != null && !p.pic.removed && (
            <div className="de-picture-had">
              <DraftPicture id={p.draft.id} rev={p.draft.rev} picture={p.draft.picture} byClaude={p.draft.author === 'claude' && p.draft.editedBy !== 'owner'} />
              <button type="button" className="btn" disabled={p.busy} onClick={() => p.pic?.onRemove(true)} data-testid="remove-picture">
                Take the picture out
              </button>
            </div>
          )}
          {p.pic.removed && p.pic.chosen === undefined && (
            <p className="sub" data-testid="picture-removed">
              The picture will be taken out when you save.{' '}
              <button type="button" className="linkish" disabled={p.busy} onClick={() => p.pic?.onRemove(false)} data-testid="keep-picture">
                Keep it
              </button>
            </p>
          )}
          <AttachPicture
            picture={p.pic.chosen}
            why={pictureWhy}
            onChoose={(file) => p.pic?.onChoose(file)}
            onTakeOut={() => p.pic?.onTakeOutChosen()}
            disabled={p.busy}
            label={p.draft.picture != null && !p.pic.removed ? 'Put another picture on' : 'Attach picture'}
          />
        </div>
      )}
      {takesCc(p.draft) && (
        <label className="de-field">
          <span className="nm-label">Cc</span>
          <input
            type="text"
            value={p.cc}
            readOnly={p.busy || copyChanged}
            placeholder="Addresses to copy, separated by commas"
            onChange={(e) => p.onCc(e.target.value)}
            aria-label="Cc"
            data-testid="edit-cc"
          />
          {copyChanged && (
            <span className="sub" data-testid="edit-cc-after-copy">
              Save the tick box first, then edit the Cc.
            </span>
          )}
        </label>
      )}
      {p.draft.canCopyEveryone && (
        <label className="de-copy">
          <input type="checkbox" checked={p.copy} disabled={p.busy} onChange={(e) => p.onCopy(e.target.checked)} data-testid="edit-copy" />
          Copy everyone on the message it answers
        </label>
      )}
      {dash && (
        <p className="sub" data-testid="edit-dash">
          There is an em dash in this. It can be saved, but the inbox will not send it: it reads as machine-written.
        </p>
      )}
      <div className="de-bar">
        <button type="button" className="btn primary" disabled={p.busy || moved || !dirty || blank || pictureWhy !== null || checking} onClick={p.onSave} data-testid="save-draft">
          {p.busy ? 'Saving' : 'Save'}
        </button>
        <button type="button" className="btn" disabled={p.busy} onClick={p.onCancel} data-testid="cancel-edit">
          Cancel
        </button>
        {blank && (
          <span className="sub" data-testid="edit-blank">
            A draft needs words.
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * The editor on one draft. `onChanged` reads the conversation again, which is how a draft that moved on is seen (its card gets the new revision) and how a save is shown.
 * `onClose` leaves the editor, and says whether the words were saved.
 */
export function DraftEditor({ draft, onChanged, onClose }: { draft: DraftView; onChanged(): void; onClose(saved: boolean): void }) {
  const [subject, setSubject] = useState(draft.subject)
  const [text, setText] = useState(draft.text)
  const [copy, setCopy] = useState(copiesNow(draft))
  const [cc, setCc] = useState(ccTextOf(draft))
  const [baseRev, setBaseRev] = useState(draft.rev)
  // The picture: one chosen to go on (or over the one the draft has), kept in a compose of its own so the same rules as the reply box's judge it, and whether the draft's own is to be taken out. Only a Telegram draft in a
  // chat that can be answered carries one; the inbox decides again.
  const [chosen, setChosen] = useState<Compose>(() => newCompose())
  const [removed, setRemoved] = useState(false)
  const action = useAction()
  const takesPicture = draft.kind === 'telegram' && draft.sendable
  const pic: PictureEdit | undefined = takesPicture
    ? {
        chosen: chosen.picture,
        removed,
        onChoose: (file) => choosePicture(file, setChosen),
        onTakeOutChosen: () => setChosen((c) => withoutPicture(c)),
        onRemove: setRemoved,
      }
    : undefined
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!takesPicture) return
    const pasted = pastedPicture(e.clipboardData)
    if (pasted === null) return
    // A picture on the clipboard beside no words is the picture; with words it is the words, which the browser pastes.
    e.preventDefault()
    choosePicture(pasted, setChosen)
  }

  const save = async () => {
    if (action.busy || hasMoved(draft, baseRev)) return
    // As the inbox's card does: who is copied is named only when it changed, so a save of words alone leaves the Cc as it is.
    const copying = copy !== copiesNow(draft)
    // The Cc is named only when the box changed (and the box is read-only while the tick box is changed, so the two are never both sent): a save of words alone leaves it as it is.
    const copied = !copying && takesCc(draft) && ccChanged(draft, cc)
    const newPicture = chosen.picture?.file
    const wordsChanged = isDirty(draft, subject, text, copy, cc)
    const ok = await action.run(
      async () => {
        let rev = baseRev
        // A picture put on or over the draft is one call (an edit of the draft in its own right), at the revision the words were written over; its answer's revision is the one the words are then saved at.
        if (newPicture !== undefined) {
          const put = await postViewForm<InboxDraft>('/api/draft-picture', { draftId: draft.id, rev }, [newPicture])
          if (!put.ok || !wordsChanged) return put
          rev = put.value.rev
        }
        // Taking the draft's own picture out is a field of the edit, in the same change as the words.
        return postView<InboxDraft>('draft-edit', { draftId: draft.id, rev, subject: subject.trim(), text: text.trim(), ...(copying && { copyEveryone: copy }), ...(copied && { cc: parseCc(cc) }), ...(removed && newPicture === undefined && { takeOutPicture: true }) })
      },
      () => 'Saved.',
    )
    // Saved or refused, the card is read again: a save shows as the new words, and a refusal because the draft moved on shows it as it is now.
    onChanged()
    if (ok) onClose(true)
  }
  return (
    <>
      <DraftEditorView
        draft={draft}
        {...(pic && { pic, onPaste })}
        subject={subject}
        text={text}
        copy={copy}
        cc={cc}
        baseRev={baseRev}
        busy={action.busy}
        onSubject={setSubject}
        onText={setText}
        onCopy={(v) => {
          setCopy(v)
          setCc(ccTextOf(draft))
        }}
        onCc={setCc}
        onSave={() => void save()}
        onCancel={() => onClose(false)}
        onKeepMine={() => setBaseRev(draft.rev)}
        onUseTheirs={() => {
          setSubject(draft.subject)
          setText(draft.text)
          setCopy(copiesNow(draft))
          setCc(ccTextOf(draft))
          setChosen(newCompose())
          setRemoved(false)
          setBaseRev(draft.rev)
        }}
      />
      {action.say && <Say say={action.say} />}
    </>
  )
}
