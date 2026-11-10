// The knowledge base: what each business's assistant may tell people, as entries the owner reads, adds, edits and removes,
// each marked for the businesses whose assistants read it, with every version kept and who wrote it. THE ASSISTANTS QUOTE WHAT IS HERE: each reads every ACTIVE entry
// marked for its business whenever it is asked for a reply, so a price here is a price it will state to that business's customers. An entry Claude proposes waits
// under "Waiting for you" and is read by nobody until the owner approves it; a proposed change written against an entry that has since moved on is marked out of date and
// can only be rejected, because approving it would undo what the owner changed.
//
// The base is the knowledge app's (src/knowledge.ts, packages/knowledge), read whole once and filtered here by the business chosen, so a proposal's entry is always at
// hand to be compared with. Everything that changes an entry names the version count this page showed (the app refuses one over an entry that has moved on, as `conflict`,
// and the page then reads it again). The writes are the owner's alone: the app admits no one else.
import { useState } from 'react'
import { KNOWLEDGE_MAX_BODY, KNOWLEDGE_MAX_TITLE, type KnowledgeBase, type KnowledgeChange, type KnowledgeEntry, type KnowledgeVersion } from '@space/workspace'
import { useFresh } from './liveHub'
import { useOwner } from './owner'
import { Ask, Done, Say, Viewed, useAction, when, whoText } from './settings-parts'
import { postView, useView } from './views'

/** How a change ended, for the card that made it. */
export type Changed = 'ok' | 'conflict' | 'failed'

const STATUS_TAG: Record<KnowledgeEntry['status'], string | null> = { active: null, proposed: 'Proposed', removed: 'Removed' }

/** The words for a list of businesses: "Northfield Works", "Northfield Works and Brightwater Builders", "Northfield Works, Brightwater Builders and Harbor Lane". */
export function businessWords(ids: readonly string[], base: Pick<KnowledgeBase, 'businesses'>): string {
  const names = ids.map((id) => base.businesses.find((b) => b.id === id)?.name ?? id)
  return names.length < 2 ? (names[0] ?? 'no business') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/**
 * A proposed change gone out of date: the entry it would change is gone, is not active, or has been changed (its words or its businesses) since the proposal was
 * written. Approving it would undo that change, so the app refuses it as `conflict` and this page offers only Reject. The rule is the app's (its `approve`).
 */
export function outOfDate(entry: KnowledgeEntry, entries: readonly KnowledgeEntry[]): boolean {
  if (entry.status !== 'proposed' || entry.replaces === null) return false
  const target = entries.find((e) => e.id === entry.replaces)
  return !target || target.status !== 'active' || target.version !== entry.replacesVersion
}

/** The small labels naming the businesses an entry is for. */
export function BusinessTags({ ids, base }: { ids: readonly string[]; base: Pick<KnowledgeBase, 'businesses'> }) {
  return (
    <span className="k-biz" data-testid="entry-businesses">
      {ids.map((id) => (
        <span key={id} className="pill" data-business={id}>
          {base.businesses.find((b) => b.id === id)?.name ?? id}
        </span>
      ))}
    </span>
  )
}

/** The businesses to tick, with the shortcut that ticks them all. At least one must be ticked: the app refuses an entry nobody reads. */
function BusinessPicker({ base, chosen, onChange, name }: { base: Pick<KnowledgeBase, 'businesses'>; chosen: string[]; onChange(next: string[]): void; name: string }) {
  const all = base.businesses.map((b) => b.id)
  return (
    <fieldset className="s-field k-pick" data-testid="business-picker">
      <span>Whose assistant may say this</span>
      <div className="k-pick-row">
        {base.businesses.map((b) => (
          <label key={b.id} className="k-check">
            <input type="checkbox" name={name} checked={chosen.includes(b.id)} onChange={(e) => onChange(all.filter((id) => (id === b.id ? e.target.checked : chosen.includes(id))))} data-testid={`pick-${b.id}`} />
            {b.name}
          </label>
        ))}
        <button type="button" className="linkish" onClick={() => onChange(all)} data-testid="pick-every">
          Every business
        </button>
      </div>
    </fieldset>
  )
}

/** The versions of an entry, newest first, each with who wrote it and when, what businesses it was for, and a way to put an older one back. */
export function History({ entry, base, busy, onPutBack }: { entry: KnowledgeEntry; base: Pick<KnowledgeBase, 'businesses'>; busy?: boolean; onPutBack?: (v: KnowledgeVersion) => void }) {
  const self = useOwner().address
  const newestFirst = [...entry.versions].reverse()
  return (
    <ol className="s-history" aria-label={`History of ${entry.title}`} data-testid="history">
      {newestFirst.map((v, n) => {
        // The version before this one is the next in the list, which is in order: `seq` is one counter across every entry, so it does not count this entry's own.
        const before = newestFirst[n + 1]
        const moved = before !== undefined && before.businesses.join() !== v.businesses.join()
        return (
          <li key={v.seq}>
            <p className="sub">
              <b>{whoText(v.by, self)}</b> {when(v.at)}
              {n === 0 && ' (now)'}
              {v.title !== entry.title && `, titled ${v.title}`}
            </p>
            <p className="sub" data-testid="version-businesses">
              {moved ? `Now for ${businessWords(v.businesses, base)} (was ${businessWords(before.businesses, base)}).` : `For ${businessWords(v.businesses, base)}.`}
            </p>
            <p className="s-pre">{v.body}</p>
            {n > 0 && onPutBack && (v.body !== entry.body || v.title !== entry.title || v.businesses.join() !== entry.businesses.join()) && (
              <button type="button" className="linkish" disabled={busy} onClick={() => onPutBack(v)}>
                Put this back
              </button>
            )}
          </li>
        )
      })}
    </ol>
  )
}

export function EntryCard({
  entry,
  base,
  target,
  stale = false,
  busy,
  onChange,
  initialEditing = false,
  initialHistory = false,
}: {
  entry: KnowledgeEntry
  base: Pick<KnowledgeBase, 'businesses'>
  /** The entry a proposed change would change, for the side by side. */
  target?: KnowledgeEntry
  /** A proposed change gone out of date (`outOfDate`): only Reject is offered. */
  stale?: boolean
  busy: boolean
  /** Make one change; answers how it ended. `conflict`: the entry changed since it was shown, so nothing was saved. */
  onChange(change: KnowledgeChange): Promise<Changed>
  initialEditing?: boolean
  initialHistory?: boolean
}) {
  const self = useOwner().address
  const [editing, setEditing] = useState(initialEditing)
  // THE VERSION THE WORDS WERE WRITTEN OVER: taken when Edit opens and sent with Save, never the card's current one. After a refusal the list is read again and the
  // card's `entry` is the newer version; a Save that named it would put these older words over it and wipe what was there.
  const [editFrom, setEditFrom] = useState(entry.version)
  const [lost, setLost] = useState<{ title: string; body: string } | null>(null)
  const [history, setHistory] = useState(initialHistory)
  const [removing, setRemoving] = useState(false)
  const [title, setTitle] = useState(entry.title)
  const [body, setBody] = useState(entry.body)
  const [businesses, setBusinesses] = useState(entry.businesses)
  const proposal = entry.status === 'proposed'
  const tag = STATUS_TAG[entry.status]
  const openEdit = () => {
    setTitle(entry.title)
    setBody(entry.body)
    setBusinesses(entry.businesses)
    setEditFrom(entry.version)
    setLost(null)
    setEditing(true)
  }
  const edit = async (change: { title: string; body: string; businesses: string[] }, from: number) => {
    const done = await onChange({ do: 'edit', id: entry.id, version: from, ...change })
    if (done === 'ok') setEditing(false)
    else if (done === 'conflict') {
      // It changed while the owner was editing: leave editing and show it as it is now, keeping their words in view to copy from, never to send over it.
      setLost({ title: change.title, body: change.body })
      setEditing(false)
    }
  }
  return (
    <article className="s-card" data-testid="entry" data-status={entry.status} data-id={entry.id} {...(stale && { 'data-stale': 'true' })}>
      <header className="s-entry-head">
        <h3 className="s-sub">{entry.title}</h3>
        {tag && <span className={`kindtag${proposal ? ' accent' : ''}`}>{proposal && entry.replaces ? 'Proposed change' : tag}</span>}
        {stale && (
          <span className="kindtag warn" data-testid="stale-tag">
            Out of date
          </span>
        )}
        <BusinessTags ids={entry.businesses} base={base} />
      </header>

      {editing ? (
        <div className="s-form">
          <label className="s-field">
            <span>Title</span>
            <input value={title} maxLength={KNOWLEDGE_MAX_TITLE} onChange={(e) => setTitle(e.target.value)} aria-label="Title" data-testid="edit-title" />
          </label>
          <label className="s-field">
            <span>What the assistant may say</span>
            <textarea value={body} maxLength={KNOWLEDGE_MAX_BODY} rows={5} onChange={(e) => setBody(e.target.value)} aria-label="What the assistant may say" data-testid="edit-body" />
          </label>
          <BusinessPicker base={base} chosen={businesses} onChange={setBusinesses} name={`edit-${entry.id}`} />
          <div className="s-actions">
            <button type="button" className="btn primary" disabled={busy || title.trim() === '' || body.trim() === '' || businesses.length === 0} onClick={() => void edit({ title, body, businesses }, editFrom)} data-testid="save-entry">
              Save
            </button>
            <button type="button" className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : proposal && target ? (
        <div className="s-sides">
          <div>
            <p className="s-cap">Now, in {target.title}</p>
            <p className="s-pre sub">{target.body}</p>
            {target.businesses.join() !== entry.businesses.join() && <p className="sub">For {businessWords(target.businesses, base)}.</p>}
          </div>
          <div>
            <p className="s-cap">Proposed</p>
            <p className="s-pre">{entry.body}</p>
            {target.businesses.join() !== entry.businesses.join() && <p className="sub">For {businessWords(entry.businesses, base)}.</p>}
          </div>
        </div>
      ) : (
        <p className="s-pre">{entry.body}</p>
      )}

      {stale && (
        <div className="s-note" role="status" data-testid="stale-note">
          <p>
            <b>This change is out of date.</b> The entry it would change has been changed since Claude wrote it, so approving it would undo that. It can only be rejected; ask Claude to propose it again against the entry as it is now.
          </p>
        </div>
      )}

      {lost && (
        <div className="s-note" role="status" data-testid="lost-words">
          <p>
            <b>This entry changed while you were editing, so what you wrote was not saved.</b> It is shown above as it is now. Your words, to copy from if you want them:
          </p>
          <p className="s-pre">{lost.title}</p>
          <p className="s-pre">{lost.body}</p>
          <div className="s-actions">
            <button type="button" className="btn" onClick={() => setLost(null)} data-testid="dismiss-lost">
              Done
            </button>
          </div>
        </div>
      )}

      <p className="sub">
        {proposal ? `Proposed by ${whoText(entry.proposedBy ?? entry.updatedBy, self)} ${when(entry.createdAt)}. Nothing reads it until you approve it.` : `${entry.status === 'removed' ? 'Removed' : 'Last changed'} by ${whoText(entry.updatedBy, self)} ${when(entry.updatedAt)}. `}
        {!proposal && `${entry.version} ${entry.version === 1 ? 'version' : 'versions'}.`}
      </p>

      {removing && (
        <Ask
          question={`Remove ${entry.title}? The assistants stop using it. Its history is kept.`}
          yes="Yes, remove"
          no="Keep it"
          danger
          busy={busy}
          onYes={() => {
            setRemoving(false)
            void onChange({ do: 'remove', id: entry.id, version: entry.version })
          }}
          onNo={() => setRemoving(false)}
        />
      )}

      {!editing && !removing && (
        <div className="s-actions">
          {proposal && (
            <>
              {!stale && (
                <button type="button" className="btn primary" disabled={busy} onClick={() => void onChange({ do: 'approve', id: entry.id, version: entry.version })} data-testid="approve-entry">
                  {entry.replaces ? 'Approve the change' : 'Approve'}
                </button>
              )}
              <button type="button" className={`btn${stale ? ' primary' : ''}`} disabled={busy} onClick={() => void onChange({ do: 'reject', id: entry.id, version: entry.version })} data-testid="reject-entry">
                Reject
              </button>
            </>
          )}
          {entry.status === 'removed' ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void onChange({ do: 'restore', id: entry.id, version: entry.version })} data-testid="restore-entry">
              Put back
            </button>
          ) : (
            !stale && (
              <button type="button" className="btn" onClick={openEdit} data-testid="edit-entry">
                Edit
              </button>
            )
          )}
          <button type="button" className="btn" aria-expanded={history} onClick={() => setHistory((h) => !h)} data-testid="history-entry">
            {history ? 'Hide history' : 'History'}
          </button>
          {entry.status === 'active' && (
            <button type="button" className="btn" disabled={busy} onClick={() => setRemoving(true)} data-testid="remove-entry">
              Remove
            </button>
          )}
        </div>
      )}

      {history && <History entry={entry} base={base} busy={busy} onPutBack={(v) => void edit({ title: v.title, body: v.body, businesses: v.businesses }, entry.version)} />}
    </article>
  )
}

/** Add an entry: a title, what the assistants may say and the businesses it is for, active at once. */
export function AddEntry({
  base,
  busy,
  onAdd,
  initialOpen = false,
  initialBusinesses = [],
}: {
  base: Pick<KnowledgeBase, 'businesses'>
  busy: boolean
  onAdd(title: string, body: string, businesses: string[]): Promise<Changed>
  initialOpen?: boolean
  /** The businesses ticked to begin with: the one the tab is filtered to. */
  initialBusinesses?: string[]
}) {
  const [open, setOpen] = useState(initialOpen)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [businesses, setBusinesses] = useState(initialBusinesses)
  if (!open) {
    return (
      <button type="button" className="btn primary s-self" onClick={() => setOpen(true)} data-testid="add-entry">
        Add an entry
      </button>
    )
  }
  return (
    <form
      className="s-card s-form"
      onSubmit={(e) => {
        e.preventDefault()
        void onAdd(title, body, businesses).then((done) => {
          if (done !== 'ok') return
          setTitle('')
          setBody('')
          setBusinesses(initialBusinesses)
          setOpen(false)
        })
      }}
    >
      <h3 className="s-sub">New entry</h3>
      <input aria-label="Title" placeholder="Title, like Pricing or Hours" value={title} maxLength={KNOWLEDGE_MAX_TITLE} onChange={(e) => setTitle(e.target.value)} required data-testid="new-title" />
      <textarea aria-label="What the assistant may say" placeholder="What the assistants may tell a customer about this" rows={4} value={body} maxLength={KNOWLEDGE_MAX_BODY} onChange={(e) => setBody(e.target.value)} required data-testid="new-body" />
      <BusinessPicker base={base} chosen={businesses} onChange={setBusinesses} name="new-entry" />
      {businesses.length === 0 && (
        <p className="sub" data-testid="pick-one">
          Pick at least one business: an entry no assistant reads would sit here doing nothing.
        </p>
      )}
      <div className="s-actions">
        <button type="submit" className="btn primary" disabled={busy || title.trim() === '' || body.trim() === '' || businesses.length === 0} data-testid="submit-entry">
          Add entry
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** The row of choices: All, then each business. Picking one shows exactly what that business's assistant reads. */
export function BusinessChoice({ base, chosen, onPick }: { base: Pick<KnowledgeBase, 'businesses'>; chosen: string | null; onPick(id: string | null): void }) {
  return (
    <div className="chips s-chips" role="group" aria-label="Business" data-testid="business-choice">
      <button type="button" className={`chip${chosen === null ? ' on' : ''}`} aria-pressed={chosen === null} onClick={() => onPick(null)} data-testid="kb-all">
        All
      </button>
      {base.businesses.map((b) => (
        <button key={b.id} type="button" className={`chip${b.id === chosen ? ' on' : ''}`} aria-pressed={b.id === chosen} onClick={() => onPick(b.id)} data-testid={`kb-${b.id}`}>
          {b.name}
        </button>
      ))}
    </div>
  )
}

/** The base, as the app answered it, narrowed to a business: a presentational piece so every state of it can be drawn with a literal one. */
export function KnowledgeView({
  base,
  business,
  busy,
  onPick,
  onChange,
  onAdd,
}: {
  base: KnowledgeBase
  /** The business chosen (`BusinessChoice`), or null for all. */
  business: string | null
  busy: boolean
  onPick(id: string | null): void
  onChange(change: KnowledgeChange): Promise<Changed>
  onAdd(title: string, body: string, businesses: string[]): Promise<Changed>
}) {
  // A proposed change that would take an entry off the business chosen is marked for other businesses, but it is about an entry this business's assistant reads, so it is shown here too.
  const aboutChosen = (e: KnowledgeEntry): boolean => e.status === 'proposed' && e.replaces !== null && (base.entries.find((x) => x.id === e.replaces)?.businesses.includes(business as string) ?? false)
  const shown = base.entries.filter((e) => business === null || e.businesses.includes(business) || aboutChosen(e))
  const waiting = shown.filter((e) => e.status === 'proposed')
  const active = shown.filter((e) => e.status === 'active')
  const removed = shown.filter((e) => e.status === 'removed')
  const chosen = business === null ? null : (base.businesses.find((b) => b.id === business) ?? null)
  return (
    <div className="s-stack" data-testid="knowledge">
      <p className="sub">Each business’s assistant reads only the entries marked for it, so a price here is a price it will quote to that business’s customers.</p>
      <BusinessChoice base={base} chosen={business} onPick={onPick} />
      {chosen && (
        <p className="sub" data-testid="reads-line">
          {chosen.name}’s assistant reads the {active.length} active {active.length === 1 ? 'entry' : 'entries'} below, and nothing else.
        </p>
      )}
      {waiting.length > 0 && (
        <section aria-label="Waiting for you" className="s-stack" data-testid="waiting">
          <h3 className="s-cap">Waiting for you ({waiting.length})</h3>
          {waiting.map((e) => (
            <EntryCard
              key={e.id}
              entry={e}
              base={base}
              {...(e.replaces !== null && base.entries.some((x) => x.id === e.replaces) && { target: base.entries.find((x) => x.id === e.replaces) as KnowledgeEntry })}
              stale={outOfDate(e, base.entries)}
              busy={busy}
              onChange={onChange}
            />
          ))}
        </section>
      )}
      <section aria-label="Active entries" className="s-stack" data-testid="active">
        <h3 className="s-cap">
          Active ({active.length}){active.length > 0 && ' · the assistants read these'}
        </h3>
        {active.length === 0 && (
          <p className="sub">
            {chosen ? `Nothing is marked for ${chosen.name} yet.` : 'Nothing yet.'} With no entries an assistant states no price, hour or policy and says what it could not confirm.
          </p>
        )}
        {active.map((e) => (
          <EntryCard key={e.id} entry={e} base={base} busy={busy} onChange={onChange} />
        ))}
        <AddEntry key={business ?? 'all'} base={base} busy={busy} onAdd={onAdd} initialBusinesses={business === null ? [] : [business]} />
      </section>
      {removed.length > 0 && (
        <details className="s-details" data-testid="removed">
          <summary className="s-cap">Removed ({removed.length})</summary>
          <div className="s-stack">
            {removed.map((e) => (
              <EntryCard key={e.id} entry={e} base={base} busy={busy} onChange={onChange} />
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

/** The knowledge base, read whole and again after every change made from it; `business` and `onPick` are the page's (the address holds the choice). */
export function Knowledge({ business, onPick }: { business: string | null; onPick(id: string | null): void }) {
  const view = useView<KnowledgeBase>('knowledge')
  // A change or a proposal (Claude's) moves the base: read again at once, and when the page is shown again (the base has no other way to hear of one).
  useFresh(['knowledge'], view.reload)
  const action = useAction()
  const change = async (c: KnowledgeChange): Promise<Changed> => {
    let conflict = false
    const ok = await action.run(async () => {
      const done = await postView('knowledge', { change: c })
      if (!done.ok && done.say.conflict) conflict = true
      return done
    }, 'Saved.')
    // A refusal because the entry moved on is answered by showing it as it is now, and the card leaves editing (EntryCard).
    view.reload()
    return ok ? 'ok' : conflict ? 'conflict' : 'failed'
  }
  return (
    <>
      <Viewed view={view.state} problem={view.problem} reload={view.reload} loading="Loading the knowledge base">
        {(base) => (
          <KnowledgeView
            base={base}
            business={business !== null && base.businesses.some((b) => b.id === business) ? business : null}
            busy={action.busy}
            onPick={onPick}
            onChange={change}
            onAdd={(title, body, businesses) => change({ do: 'add', title, body, businesses })}
          />
        )}
      </Viewed>
      {action.say && <Say say={action.say} />}
      <Done text={action.done} />
    </>
  )
}
