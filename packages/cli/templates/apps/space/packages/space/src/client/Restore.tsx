// Settings, Restore the store: the owner's way to put the inbox back to an earlier moment. The owner's only: the inbox refuses anyone else, and Claude can only read a bookmark.
//
// TWO STEPS, AS THE INBOX'S OWN PAGE HAS THEM, AND NOTHING IS DONE UNTIL THE SECOND. Naming a time (or a bookmark Claude wrote down) changes nothing and shows what would be
// restored to; only the second button, in a box that says what is lost, makes the restore, and it sends back the token the first step answered with the bookmark it named, so a
// restore cannot be made blind or from a stale screen. What it answers is the bookmark that undoes it, shown here and kept in the inbox's bucket.
import { useState } from 'react'
import type { InboxRestoreChoice, InboxRestoreDone, InboxRestorePlan, InboxRestoreRecord, InboxRestoreReport } from '@space/workspace'
import { Block, Say, Viewed, useAction, when } from './settings-parts'
import { postView, useView } from './views'

/** A local "datetime-local" value as the ISO time with its zone that the inbox asks for. */
export const isoFromLocal = (value: string): string | null => {
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

const whenIso = (iso: string | null): string => (iso === null ? '' : when(Date.parse(iso)))

function RecordRow({ record }: { record: InboxRestoreRecord }) {
  return (
    <li className="s-record">
      <span>
        {record.kind === 'restored' ? 'Restored' : 'Prepared'} {whenIso(record.at)} by {record.actor}, to {record.targetTime ? `${whenIso(record.targetTime)} (` : ''}
        <code>{record.target}</code>
        {record.targetTime ? ')' : ''}
      </span>
      {record.undoBookmark && (
        <span className="sub">
          Undo with <code>{record.undoBookmark}</code>
        </span>
      )}
    </li>
  )
}

export function RestorePanel({
  report,
  plan,
  done,
  busy,
  onPrepare,
  onConfirm,
  onCancel,
}: {
  report: InboxRestoreReport
  /** The preparation waiting for its second step, if one is. */
  plan: InboxRestorePlan | null
  /** What a restore answered, once it has been made. */
  done: InboxRestoreDone | null
  busy: boolean
  onPrepare(choice: InboxRestoreChoice): void
  onConfirm(): void
  onCancel(): void
}) {
  const [time, setTime] = useState('')
  const [bookmark, setBookmark] = useState('')
  // A bookmark typed wins over a time picked; neither is a choice yet.
  const picked = isoFromLocal(time)
  const chosen: InboxRestoreChoice | null = bookmark.trim() !== '' ? { bookmark: bookmark.trim() } : picked === null ? null : { time: picked }
  return (
    <div className="s-card" data-testid="restore">
      <p>
        The inbox’s store keeps 30 days of history. Restoring puts everything the inbox holds (conversations, read and closed state, drafts, contacts) back as it was at the moment you choose. Mail that arrived since is gone
        from the store; its raw copy stays in the bucket.
      </p>
      <p className="sub">
        Now: <code>{report.current}</code>
      </p>

      {done ? (
        <div className="s-note" role="status" data-testid="restore-done">
          <p>
            <b>The store is restarting and comes back as it was at {done.restoredTo}.</b>
          </p>
          <p>
            To undo this restore, restore to <code>{done.undoBookmark}</code>. It is also kept in the bucket. Reload this page in a few seconds.
          </p>
        </div>
      ) : plan ? (
        <div className="s-ask danger" role="group" aria-label="Restore the store?" data-testid="restore-ask">
          <p className="s-ask-q">Restore the inbox to {plan.targetTime ? whenIso(plan.targetTime) : 'that bookmark'}?</p>
          <p>
            Bookmark <code>{plan.target}</code>. Everything since is replaced, and mail that arrived since is gone from the store until it is filed again. The answer will carry a bookmark that undoes this. This
            confirmation lasts until {whenIso(plan.expiresAt)}.
          </p>
          <p>
            <b>Messages sent since then will show as unsent drafts again. They went out: do not send them a second time. Gmail may need reconnecting, because the connection goes back with the store.</b>
          </p>
          <div className="s-actions">
            <button type="button" className="btn danger" disabled={busy} onClick={onConfirm} data-testid="restore-confirm">
              Yes, restore the store
            </button>
            <button type="button" className="btn" disabled={busy} onClick={onCancel} data-testid="restore-cancel">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <form
          className="s-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (chosen) onPrepare(chosen)
          }}
        >
          <label className="s-field">
            <span>Restore to this time</span>
            <input type="datetime-local" value={time} disabled={bookmark.trim() !== ''} onChange={(e) => setTime(e.target.value)} data-testid="restore-time" />
          </label>
          <label className="s-field">
            <span>or to a bookmark Claude wrote down</span>
            <input type="text" value={bookmark} placeholder="a bookmark" onChange={(e) => setBookmark(e.target.value)} data-testid="restore-bookmark" />
          </label>
          <div className="s-actions">
            <button type="submit" className="btn primary" disabled={busy || !chosen} data-testid="restore-prepare">
              Show what would be restored
            </button>
          </div>
          <p className="sub">Nothing changes until you confirm in the next step.</p>
        </form>
      )}

      {report.restoresError && <p className="sub">{report.restoresError}</p>}
      {report.restores.length > 0 && (
        <div className="s-stack">
          <p className="s-cap">Earlier restores</p>
          <ul className="s-records">
            {report.restores.map((r) => (
              <RecordRow key={`${r.kind}-${r.id}`} record={r} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** The section with its data: the bookmark and the records read from the inbox, and the two calls. */
export function Restore() {
  const view = useView<InboxRestoreReport>('restore')
  const [plan, setPlan] = useState<InboxRestorePlan | null>(null)
  const [done, setDone] = useState<InboxRestoreDone | null>(null)
  const action = useAction()
  return (
    <Block title="Restore the store" testid="section-restore">
      <Viewed view={view.state} problem={view.problem} reload={view.reload} loading="Loading the store’s bookmark">
        {(report) => (
          <RestorePanel
            report={report}
            plan={plan}
            done={done}
            busy={action.busy}
            onPrepare={(choice) => void action.run(() => postView<InboxRestorePlan>('restore-prepare', choice), 'Check what would be restored below. Nothing has changed.', setPlan)}
            onConfirm={() => {
              if (!plan) return
              void action.run(() => postView<InboxRestoreDone>('restore-confirm', { token: plan.token, bookmark: plan.target }), 'The restore is made.', (d) => {
                setDone(d)
                setPlan(null)
              })
            }}
            onCancel={() => {
              setPlan(null)
              action.clear()
            }}
          />
        )}
      </Viewed>
      {action.say && <Say say={action.say} />}
    </Block>
  )
}
