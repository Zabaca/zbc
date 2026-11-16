// The company's leads (the `leads` switch): the board, a column for each of the install's stages in its order, and one person's leads beside their page and their conversation, where a lead
// is made by hand. Every word of a stage or a field is the install's (`Me.leads`); a stage a lead holds that the install no longer declares is drawn under its id, after the declared ones.
//
// A move names the revision the card showed: a card read before someone else moved it is refused (`conflict`), and the board is read again. Every change to a lead tells the open pages that the
// mail moved, so the board and the cards follow it (the `mail` part of the live hub).

import type { InboxLead, InboxLeads } from '@space/workspace'
import { createContext, type MouseEvent, useContext, useState } from 'react'
import type { Me } from '../me'
import { ago } from './format'
import { Glyph } from './icons'
import { useFresh } from './liveHub'
import { inboxPath, peoplePath } from './route'
import { postView, type Said, useView } from './views'

type Go = (path: string) => void
export type LeadsWords = NonNullable<Me['leads']>

/** The install's leads words, for the parts of a page that are drawn without `me` (a person's page, the side of a conversation). Null where the switch is off. */
export const LeadsContext = createContext<LeadsWords | null>(null)

function follow(e: MouseEvent<HTMLAnchorElement>, path: string, go: Go): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  go(path)
}

/** The columns, in the install's order, then any stage a lead holds that the install no longer declares. */
export function columnsOf(words: LeadsWords, leads: readonly InboxLead[]): { id: string; label: string; settled: boolean }[] {
  const known = new Set(words.stages.map((s) => s.id))
  // A stage taken out of the declaration is no settled one of the install's, so its leads are counted as open (as the store counts them) and drawn after the declared columns.
  const strays = [...new Set(leads.map((l) => l.stage).filter((s) => !known.has(s)))].map((id) => ({ id, label: id, settled: false }))
  return [...words.stages, ...strays]
}

/** The person's page: their address, else the contact. */
const personPathOf = (lead: InboxLead): string => peoplePath(lead.email ?? `mail:${lead.contactId}`)

/** A stage picker for one lead: moving it is one choice, sent at the revision shown. */
function MoveLead({ lead, words, onMoved, onSaid }: { lead: InboxLead; words: LeadsWords; onMoved(l: InboxLead): void; onSaid(s: Said): void }) {
  const [busy, setBusy] = useState(false)
  return (
    <select
      className="lead-stage"
      aria-label={`Stage of ${lead.name}’s lead`}
      value={lead.stage}
      disabled={busy}
      data-testid="lead-stage"
      onChange={async (e) => {
        const stage = e.target.value
        setBusy(true)
        const moved = await postView<InboxLead>('lead-move', {
          leadId: lead.id,
          rev: lead.rev,
          stage,
        })
        setBusy(false)
        if (moved.ok) onMoved(moved.value)
        else onSaid(moved.say)
      }}
    >
      {columnsOf(words, [lead]).map((s) => (
        <option key={s.id} value={s.id}>
          {s.label}
        </option>
      ))}
    </select>
  )
}

/** One lead as a card: who, what the install shows on the board, when, and its stage. */
function LeadCard({ lead, words, go, onMoved, onSaid, full = false }: { lead: InboxLead; words: LeadsWords; go: Go; onMoved(l: InboxLead): void; onSaid(s: Said): void; full?: boolean }) {
  const shown = words.fields.filter((f) => (full || f.board) && lead.fields[f.key] !== undefined)
  const person = personPathOf(lead)
  return (
    <article className="lead-card" data-testid="lead-card" data-lead={lead.id}>
      <header>
        {full ? (
          // On the person's own page their name is the page's: the card says where the lead came from instead.
          <span className="lead-name">{lead.source === null ? 'Made by hand' : `From ${lead.source}`}</span>
        ) : (
          <a href={person} onClick={(e) => follow(e, person, go)} className="lead-name" data-testid="lead-name">
            {lead.name}
          </a>
        )}
        <span className="sub" title={new Date(lead.lastRequestAt).toLocaleString()}>
          {ago(Date.now(), Date.parse(lead.lastRequestAt))}
        </span>
      </header>
      {shown.length > 0 && (
        <dl className="lead-fields">
          {shown.map((f) => (
            <div key={f.key}>
              <dt>{f.label}</dt>
              <dd>{lead.fields[f.key]}</dd>
            </div>
          ))}
        </dl>
      )}
      {full && (lead.email !== null || lead.phone !== null) && <p className="sub lead-reach">{[lead.email, lead.phone].filter((x): x is string => x !== null).join(' · ')}</p>}
      <footer>
        <MoveLead lead={lead} words={words} onMoved={onMoved} onSaid={onSaid} />
        {lead.requests > 1 && (
          <span className="pill" title="The same person asked again while this lead was open" data-testid="lead-requests">
            Asked {lead.requests} times
          </span>
        )}
        {lead.email !== null && (
          <a className="linkish" href={inboxPath(lead.email)} onClick={(e) => follow(e, inboxPath(lead.email as string), go)} data-testid="lead-email">
            <Glyph name="mail" size={12} /> Email
          </a>
        )}
      </footer>
    </article>
  )
}

function SaidLine({ said }: { said: Said | null }) {
  if (said === null) return null
  return (
    <p className="notice unreachable" role="status" data-testid="leads-said">
      <Glyph name="warn" size={13} />
      <span>{said.text}</span>
    </p>
  )
}

/** The Leads tab: the board. */
export function LeadsScreen({ me, go }: { me: Me; go: Go }) {
  const words = me.leads
  const view = useView<InboxLeads>('leads', {}, words !== undefined)
  const [said, setSaid] = useState<Said | null>(null)
  useFresh(['mail'], view.follow)
  if (words === undefined) return null
  const onMoved = () => {
    setSaid(null)
    view.reload()
  }
  const onSaid = (s: Said) => {
    setSaid(s)
    view.reload()
  }
  const state = view.state
  return (
    <section className="page leads-page" aria-labelledby="h-leads">
      <h1 id="h-leads">Leads</h1>
      <SaidLine said={said ?? view.problem} />
      {state.kind === 'loading' && (
        <p className="sub" role="status" data-testid="leads-loading">
          Reading the leads
        </p>
      )}
      {state.kind === 'signin' && (
        <SaidLine
          said={{
            tone: 'warn',
            text: 'Your sign-in may have ended. Reload the page to sign in again.',
            again: false,
          }}
        />
      )}
      {state.kind === 'said' && <SaidLine said={state.say} />}
      {state.kind === 'value' && (
        <>
          {state.value.leads.length === 0 && (
            <p className="sub" data-testid="leads-empty">
              No leads yet. A request from your site shows up here, and you can make one from a person’s page.
            </p>
          )}
          <div className="lead-board" data-testid="lead-board">
            {columnsOf(words, state.value.leads).map((col) => {
              const here = state.value.leads.filter((l) => l.stage === col.id)
              return (
                <section key={col.id} className={`lead-col${col.settled ? ' settled' : ''}`} data-testid="lead-column" data-stage={col.id} aria-label={col.label}>
                  <h2>
                    {col.label} <span className="sub">{here.length}</span>
                  </h2>
                  {here.map((lead) => (
                    <LeadCard key={lead.id} lead={lead} words={words} go={go} onMoved={onMoved} onSaid={onSaid} />
                  ))}
                </section>
              )
            })}
          </div>
          {state.value.more && <p className="sub">Only the first 500 leads are shown, the open ones first.</p>}
        </>
      )}
    </section>
  )
}

/** A form for a lead made by hand: the install's fields, none required. */
function MakeLead({ contactId, words, onMade, onCancel }: { contactId: string; words: LeadsWords; onMade(): void; onCancel(): void }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<Said | null>(null)
  return (
    <form
      className="lead-make"
      data-testid="lead-make"
      onSubmit={async (e) => {
        e.preventDefault()
        if (busy) return
        setBusy(true)
        const made = await postView<InboxLead>('lead-make', {
          contactId,
          fields: values,
        })
        setBusy(false)
        if (made.ok) onMade()
        else setSaid(made.say)
      }}
    >
      {words.fields.map((f) => (
        <label key={f.key}>
          <span>{f.label}</span>
          <input value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} data-testid={`lead-field-${f.key}`} />
        </label>
      ))}
      <SaidLine said={said} />
      <div className="lead-make-acts">
        <button type="submit" className="btn primary" disabled={busy} data-testid="lead-make-save">
          Make the lead
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** One person's leads, beside their page or their conversation, with "Make a lead". Nothing where the install has no leads or the person may not see them. */
export function PersonLeads({ contactId, go }: { contactId: string; go: Go }) {
  const words = useContext(LeadsContext)
  const view = useView<InboxLeads>('contact-leads', { contact: contactId }, words !== null)
  const [making, setMaking] = useState(false)
  const [said, setSaid] = useState<Said | null>(null)
  useFresh(['mail'], view.follow)
  if (words === null || view.state.kind !== 'value') return null
  const leads = view.state.value.leads
  return (
    <section className="lead-person" data-testid="person-leads" aria-label="Leads">
      <h3>Leads</h3>
      <SaidLine said={said} />
      {leads.map((lead) => (
        <LeadCard
          key={lead.id}
          lead={lead}
          words={words}
          go={go}
          full
          onMoved={() => {
            setSaid(null)
            view.reload()
          }}
          onSaid={(s) => {
            setSaid(s)
            view.reload()
          }}
        />
      ))}
      {making ? (
        <MakeLead
          contactId={contactId}
          words={words}
          onMade={() => {
            setMaking(false)
            view.reload()
          }}
          onCancel={() => setMaking(false)}
        />
      ) : (
        <button type="button" className="btn" onClick={() => setMaking(true)} data-testid="lead-make-open">
          Make a lead
        </button>
      )}
      {leads.length === 0 && !making && <p className="sub">No leads for this person.</p>}
    </section>
  )
}
