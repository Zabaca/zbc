// Settings, Clients: the businesses the space serves, made and edited here and, where the install has a source (a company's website, say), brought in by
// that source's pushes. The list has New Client, the active Clients and a fold of archived ones; a Client's page has its details (Edit, Archive or Put back), its people and the people the inbox only SUGGESTS (each with
// a Link: a suggestion counts for nothing until somebody agrees to it, and Link is that assignment, audited as the person who made it), and, for a Client a source brought in, what the source says of it, read only.
//
// The Clients are the Clients part's (packages/clients) and the people under them the inbox's; the Worker puts the two together (src/clients-settings.ts), so this file draws one answer per screen. It knows no source
// by name: the source's name, its address of the Client and its extra fields come with the Client.
import type { Client } from '@space/workspace'
import { type FormEvent, useEffect, useState } from 'react'
import type { ClientFieldValue, ClientRow, ClientScreen, ClientsScreen, UnlistedRow } from '../clients-settings'
import { href as formsHref } from './forms/route'
import { useFresh } from './liveHub'
import { inboxPath, settingsItem, settingsItemPath, settingsPath } from './route'
import { Block, Done, Say, Viewed, useAction, when } from './settings-parts'
import { type Said, postView, useView } from './views'

/** What a person is suggested for a Client by: an address the source gave under the key the declaration names (`label` is that field's), or a domain already linked to the Client. */
const reasonText = (reason: 'address' | 'domain', via: string, label: string | null): string => (reason === 'address' ? `${via} is this Client’s ${label ?? 'address'}` : `people at ${via} are already linked to this Client`)

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
const peopleText = (c: { contacts: number; conversations: number; open: number }): string => `${plural(c.contacts, 'person', 'people')}, ${plural(c.conversations, 'conversation', 'conversations')}, ${c.open} open.`

const open = (go: (path: string) => void, path: string) => (e: { preventDefault(): void; metaKey: boolean; ctrlKey: boolean; button: number }) => {
  if (!e.metaKey && !e.ctrlKey && e.button === 0) {
    e.preventDefault()
    go(path)
  }
}

export const NEW_CLIENT_PATH = settingsItemPath('clients', 'new')

// ── The list ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The line under the heading: when the source last sent anything, and when it last sent the full set. Nothing for an install with no source. */
export function SourceLine({ source }: { source: ClientsScreen['source'] }) {
  if (source === null) return null
  return (
    <p className="sub" data-testid="source-line">
      {source.lastPushAt === null ? `${source.name} has not sent anything yet.` : `${source.name} last sent something ${when(source.lastPushAt)}, and the full set ${source.lastSyncAt === null ? 'never' : when(source.lastSyncAt)}${source.syncedCount === null ? '' : ` (${plural(source.syncedCount, 'Client', 'Clients')})`}.`}
    </p>
  )
}

function Row({ c, go }: { c: ClientRow; go(path: string): void }) {
  const path = settingsItemPath('clients', c.number)
  return (
    <li>
      <a className="s-item s-link" href={path} onClick={open(go, path)} data-testid="client" data-id={c.number}>
        <span className="s-item-main">
          <span className="s-item-title">{c.name}</span>
          <span className="sub">
            {c.legalName ? `${c.legalName}${c.legalName.endsWith('.') ? '' : '.'} ` : ''}
            {peopleText(c)}
          </span>
          <span className="sub" data-testid="client-origin">
            {c.source === null ? 'Made here.' : `From ${c.source}.`}
            {c.goneSince !== null ? ` ${c.source} no longer lists it, since ${when(c.goneSince)}.` : ''}
          </span>
        </span>
        <span className="sub" data-testid="client-fields">
          {c.fields.map((f) => fieldText(f)).join(' · ')}
        </span>
      </a>
    </li>
  )
}

/** The list of Clients, from the Worker's answer. */
export function ClientsList({ screen, go }: { screen: ClientsScreen; go(path: string): void }) {
  return (
    <>
      <SourceLine source={screen.source} />
      {!screen.peopleCounted && (
        <p className="cnotice warn" role="status" data-testid="directory-down">
          {screen.peopleError ?? 'The people under each Client could not be counted.'} The people shown below are not counted.
        </p>
      )}
      {screen.peopleCounted && screen.peopleError !== null && (
        <p className="cnotice warn" role="status" data-testid="directory-down">
          {screen.peopleError}
        </p>
      )}
      <div className="s-actions">
        <a className="btn primary" href={NEW_CLIENT_PATH} onClick={open(go, NEW_CLIENT_PATH)} data-testid="new-client">
          New Client
        </a>
      </div>
      {screen.active.length === 0 && (
        <p className="sub" data-testid="no-clients">
          There are no Clients yet. New Client makes one.
        </p>
      )}
      <ul className="s-list" aria-label="Clients" data-testid="clients">
        {screen.active.map((c) => (
          <Row key={c.number} c={c} go={go} />
        ))}
      </ul>
      {screen.archived.length > 0 && (
        <details className="s-fold" data-testid="archived-fold">
          <summary>Archived ({screen.archived.length})</summary>
          <p className="sub">Out of the lists and pickers. Their people stay linked and their mail is treated as before.</p>
          <ul className="s-list" aria-label="Archived Clients" data-testid="archived-clients">
            {screen.archived.map((c) => (
              <Row key={c.number} c={c} go={go} />
            ))}
          </ul>
        </details>
      )}
      {screen.unlisted.length > 0 && <Unlisted rows={screen.unlisted} go={go} />}
    </>
  )
}

function Unlisted({ rows, go }: { rows: UnlistedRow[]; go(path: string): void }) {
  return (
    <section aria-label="Numbers with people and no Client" className="s-stack" data-testid="unlisted">
      <h3 className="s-cap">Held by number only</h3>
      <p className="sub">People are linked to these numbers and no Client has them.</p>
      <ul className="s-list">
        {rows.map((c) => {
          const path = settingsItemPath('clients', c.number)
          return (
            <li key={c.number}>
              <a className="s-item s-link" href={path} onClick={open(go, path)} data-testid="client" data-id={c.number}>
                <span className="s-item-main">
                  <span className="s-item-title">{c.name}</span>
                  <span className="sub">{peopleText(c)}</span>
                </span>
              </a>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// ── A name and a legal name, typed ───────────────────────────────────────────────────────────────────────────────────────

interface Names {
  name: string
  legalName: string
}

function NameFields({ value, onChange, autoFocus }: { value: Names; onChange(next: Names): void; autoFocus?: boolean }) {
  return (
    <>
      <label className="p-field">
        <span className="sub">Name</span>
        <input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} maxLength={80} autoComplete="off" autoFocus={autoFocus} placeholder="What you call the business" data-testid="field-name" />
      </label>
      <label className="p-field">
        <span className="sub">Legal name (optional)</span>
        <input value={value.legalName} onChange={(e) => onChange({ ...value, legalName: e.target.value })} maxLength={120} autoComplete="off" placeholder="The name on its agreements, if it has one" data-testid="field-legal-name" />
      </label>
    </>
  )
}

/** New Client: a name, and a legal name if there is one. */
export function NewClientForm({ onCancel, say, busy, submit }: { onCancel(): void; say: Said | null; busy: boolean; submit(names: Names): void }) {
  const [names, setNames] = useState<Names>({ name: '', legalName: '' })
  return (
    <form
      className="p-fields s-card"
      onSubmit={(e: FormEvent) => {
        e.preventDefault()
        if (names.name.trim() !== '' && !busy) submit(names)
      }}
      data-testid="new-client-form"
    >
      <h3 className="s-sub">New Client</h3>
      <NameFields value={names} onChange={setNames} autoFocus />
      {say && <Say say={say} />}
      <div className="s-actions">
        <button type="submit" className="btn primary" disabled={busy || names.name.trim() === ''} data-testid="make-client">
          {busy ? 'Making' : 'Make the Client'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// ── A Client's page ───────────────────────────────────────────────────────────────────────────────────────────────────────

function Person({ person, go }: { person: ClientScreen['contacts'][number]; go(path: string): void }) {
  const address = person.addresses[0]
  return (
    <li className="s-item" data-testid="client-person">
      <div className="s-item-main">
        <p className="s-item-title">{person.name}</p>
        <p className="sub">{person.addresses.join(', ') || 'No email address'}</p>
      </div>
      {address && (
        <a className="btn" href={inboxPath(address)} onClick={open(go, inboxPath(address))}>
          Open conversation
        </a>
      )}
    </li>
  )
}

/** The edit form of the details: the boxes hold what was typed until it is saved, and an edit over a Client that has moved on is refused, with what was typed still in them. */
function EditForm({ client, busy, say, onSave, onCancel }: { client: Client; busy: boolean; say: Said | null; onSave(base: number, names: Names): Promise<boolean>; onCancel(): void }) {
  const fieldsOf = (c: Client): Names => ({ name: c.name, legalName: c.legalName ?? '' })
  const [base, setBase] = useState({ revision: client.revision, names: fieldsOf(client) })
  const [draft, setDraft] = useState<Names>(fieldsOf(client))
  const dirty = draft.name !== base.names.name || draft.legalName !== base.names.legalName
  const newer = client.revision > base.revision
  // Nothing typed and the Client moved on: take the newer details without asking.
  useEffect(() => {
    if (client.revision > base.revision && !dirty) {
      setBase({ revision: client.revision, names: fieldsOf(client) })
      setDraft(fieldsOf(client))
    }
  }, [client, base.revision, dirty])
  return (
    <form
      className="p-fields"
      onSubmit={(e: FormEvent) => {
        e.preventDefault()
        if (dirty && draft.name.trim() !== '' && !busy && !newer) void onSave(base.revision, draft)
      }}
      data-testid="edit-client-form"
    >
      <NameFields value={draft} onChange={setDraft} autoFocus />
      {newer && dirty && (
        <div className="cnotice warn p-newer" role="status" data-testid="newer">
          <p>
            This Client was changed since you opened it, so nothing you typed was saved. It is still in the boxes. As it is now: name “{client.name}”, legal name “{client.legalName ?? ''}”.
          </p>
          <button
            type="button"
            className="linkish"
            onClick={() => {
              setBase({ revision: client.revision, names: fieldsOf(client) })
              setDraft(fieldsOf(client))
            }}
            data-testid="take-newer"
          >
            Use these instead of what I typed
          </button>
        </div>
      )}
      {/* The conflict is said by the notice above once the Client has been read again; when that reading failed there is no newer Client to show, and the sentence itself must still be said. */}
      {say && !(say.conflict && newer && dirty) && <Say say={say} />}
      <div className="s-actions">
        <button type="submit" className="btn primary" disabled={!dirty || draft.name.trim() === '' || busy || newer} data-testid="save-client">
          {busy ? 'Saving' : 'Save'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** What a source says of the Client's names, against the Client's own: whether they still follow it, or an edit here took over (and what the source calls it then). */
function NamesNote({ source, names }: { source: string; names: NonNullable<ClientScreen['names']> }) {
  return (
    <div className="sub" data-testid="names-note">
      {names.followsName && names.followsLegalName ? (
        <p data-testid="follows">The names follow {source}: a rename there reaches here until you edit one.</p>
      ) : (
        <>
          {!names.followsName && (
            <p data-testid="edited-name">
              {source} calls it “{names.saidName}”. Your name stands.
            </p>
          )}
          {!names.followsLegalName && (
            <p data-testid="edited-legal">
              {source} gives its legal name as {names.saidLegalName === null ? 'none' : `“${names.saidLegalName}”`}. Your legal name stands.
            </p>
          )}
        </>
      )}
    </div>
  )
}

/** A field's value as it is read: a time as a date, the rest as the source said it. */
const valueText = (f: ClientFieldValue): string => {
  if (f.kind !== 'time') return f.value
  const at = Date.parse(f.value)
  return Number.isNaN(at) ? f.value : when(at)
}
const fieldText = (f: ClientFieldValue): string => `${f.label}: ${valueText(f)}`

/** The source's part of a Client, read only: whatever it last said of the Client as label and value pairs, and the Client in the source's admin. */
function FromSource({ screen, client }: { screen: ClientScreen; client: Client }) {
  const part = client.source
  if (part === null) return null
  return (
    <section aria-label={`From ${part.source}`} className="s-card" data-testid="from-source">
      <h3 className="s-cap">From {part.source}</h3>
      {part.goneSince !== null && (
        <p className="cnotice warn" role="status" data-testid="gone">
          {part.source} no longer lists this Client, since {when(part.goneSince)}. It is kept as it was last said; archive it if you do not want it.
        </p>
      )}
      {screen.fields.length === 0 ? (
        <p className="sub">{part.source} has said nothing else of it.</p>
      ) : (
        <dl className="s-fields" data-testid="source-fields">
          {screen.fields.map((f) => (
            <div key={f.key} data-testid="source-field" data-key={f.key}>
              <dt className="sub">{f.label}</dt>
              <dd>{valueText(f)}</dd>
            </div>
          ))}
        </dl>
      )}
      {screen.adminUrl && (
        <div className="s-actions">
          <a className="btn" href={screen.adminUrl} target="_blank" rel="noreferrer noopener" data-testid="client-admin">
            Open in {part.source}’s admin
          </a>
        </div>
      )}
    </section>
  )
}

/**
 * Whether Forms signs for the Client: the way into its signing settings in Forms, or Set up signing. What a signer sees (logo, colour, where replies go) is set in Forms; the name and legal name are this page's, and Forms follows them.
 * An archived Client is not set up from here (put it back first); one that already has signing keeps its documents going.
 */
function Signing({ screen, client, go }: { screen: ClientScreen; client: Client; go(path: string): void }) {
  const { available, settings } = screen.signing
  const archived = client.archivedAt !== null
  return (
    <section aria-label="Signing" className="s-card" data-testid="signing">
      <h3 className="s-cap">Signing</h3>
      {!available ? (
        <p className="sub" data-testid="signing-unavailable">
          Forms could not be asked just now, so whether it sends for {client.name} is not shown.
        </p>
      ) : settings !== null ? (
        <>
          <p data-testid="signing-set-up">Forms is set up to send for {client.name}. Replies to its signing emails go to {settings.replyTo}.</p>
          {settings.copy === null ? (
            <p className="sub">Its name and legal name are the ones on this page; Forms follows them.</p>
          ) : (
            <div data-testid="signing-differs">
              <p>
                Forms signs under “{settings.copy.formsName}” (legal name “{settings.copy.formsLegalName}”), not the names on this page.
              </p>
              <p className="sub" data-testid="signing-differs-why">
                {settings.copy.why}
              </p>
              <p className="sub" data-testid="signing-differs-todo">
                {settings.copy.todo}
              </p>
            </div>
          )}
          <div className="s-actions">
            <a className="btn" href={formsHref(`/clients/${settings.id}`)} onClick={open(go, formsHref(`/clients/${settings.id}`))} data-testid="signing-settings">
              Signing settings in Forms
            </a>
          </div>
        </>
      ) : (
        <>
          <p className="sub" data-testid="signing-not-set-up">
            Forms is not set up to send for {client.name}.{archived ? ' It is archived: put it back to set signing up.' : ''}
          </p>
          {!archived && (
            <div className="s-actions">
              <a className="btn primary" href={formsHref(`/clients/new?client=${client.number}`)} onClick={open(go, formsHref(`/clients/new?client=${client.number}`))} data-testid="set-up-signing">
                Set up signing
              </a>
            </div>
          )}
        </>
      )}
    </section>
  )
}

/** One Client: its details with Edit, Archive or Put back, the source's part, its people, and the people the inbox suggests for it. */
export function ClientDetail({
  screen,
  busy,
  say,
  editing,
  onEditing,
  onSave,
  onArchive,
  onLink,
  go,
}: {
  screen: ClientScreen
  busy: boolean
  say: Said | null
  editing: boolean
  onEditing(on: boolean): void
  onSave(base: number, names: Names): Promise<boolean>
  onArchive(back: boolean): void
  onLink(contactId: string, clientId: number): void
  go(path: string): void
}) {
  const c = screen.client
  const archived = c !== null && c.archivedAt !== null
  return (
    <div className="s-stack" data-testid="client-page">
      <div className="s-card" data-testid="client-details">
        <h3 className="s-sub">{screen.name}</h3>
        {c === null ? (
          <p className="sub" data-testid="not-held">
            No Client has this number. People are linked to it, and they stay linked.
          </p>
        ) : (
          <>
            {archived && (
              <p className="cnotice warn" role="status" data-testid="archived-note">
                Archived {when(c.archivedAt)}. It is out of the lists and pickers; its people stay linked and their mail is treated as before.
              </p>
            )}
            {editing ? (
              <EditForm client={c} busy={busy} say={say} onSave={onSave} onCancel={() => onEditing(false)} />
            ) : (
              <>
                <p data-testid="legal-name">{c.legalName ?? <span className="sub">No legal name.</span>}</p>
                <p className="sub">{c.source === null ? `Made here ${when(c.createdAt)}.` : `Brought in by ${c.source.source} ${when(c.createdAt)}.`}</p>
                {c.source !== null && screen.names !== null && <NamesNote source={c.source.source} names={screen.names} />}
                <div className="s-actions">
                  <button type="button" className="btn" onClick={() => onEditing(true)} disabled={busy} data-testid="edit-client">
                    Edit
                  </button>
                  {archived ? (
                    <button type="button" className="btn" onClick={() => onArchive(true)} disabled={busy} data-testid="put-back-client">
                      Put back
                    </button>
                  ) : (
                    <button type="button" className="btn" onClick={() => onArchive(false)} disabled={busy} data-testid="archive-client">
                      Archive
                    </button>
                  )}
                </div>
              </>
            )}
          </>
        )}
        {!screen.directory.available && (
          <p className="cnotice warn" role="status">
            {screen.directory.error ?? 'The people under this Client could not be read.'}
          </p>
        )}
      </div>

      {c !== null && <FromSource screen={screen} client={c} />}

      {c !== null && <Signing screen={screen} client={c} go={go} />}

      {screen.suggestions.length > 0 && (
        <section aria-label="People the inbox suggests for this Client" className="s-stack" data-testid="suggestions">
          <h3 className="s-cap">May belong here, not counted until linked</h3>
          <ul className="s-list">
            {screen.suggestions.map((s) => (
              <li key={s.contactId} className="s-item dashed" data-testid="suggestion">
                <div className="s-item-main">
                  <p className="s-item-title">{s.name}</p>
                  <p className="sub">Because {reasonText(s.reason, s.via, screen.matchLabel)}.</p>
                </div>
                <button type="button" className="btn primary" disabled={busy || !screen.directory.available || archived} aria-label={`Link ${s.name} to this Client`} onClick={() => onLink(s.contactId, screen.number)} data-testid="link-person">
                  Link
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Their people" className="s-stack">
        <h3 className="s-cap">
          Their people ({screen.contacts.length}) · {plural(screen.counts.conversations, 'conversation', 'conversations')}, {screen.counts.open} open
        </h3>
        {screen.contacts.length === 0 && <p className="sub">No one is linked to this Client yet.</p>}
        <ul className="s-list">
          {screen.contacts.map((p) => (
            <Person key={p.contactId} person={p} go={go} />
          ))}
        </ul>
      </section>
    </div>
  )
}

// ── The screens ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export function Clients({ pathname, go }: { pathname: string; go(path: string): void }) {
  const chosen = settingsItem(pathname, 'clients')
  const id = chosen !== null && /^[1-9][0-9]{0,9}$/.test(chosen) ? Number(chosen) : null
  return (
    <Block title="Clients" testid="section-clients">
      {chosen === 'new' ? <MakeClient go={go} /> : id === null ? <ClientsOverview go={go} /> : <ClientOf key={id} id={id} go={go} />}
    </Block>
  )
}

function ClientsOverview({ go }: { go(path: string): void }) {
  const view = useView<ClientsScreen>('clients/list')
  // The Clients part tells the page when a Client is made, renamed, archived or sent in; the inbox, when someone is linked.
  useFresh(['clients', 'mail'], view.reload)
  return (
    <Viewed view={view.state} problem={view.problem} reload={view.reload} loading="Loading the Clients">
      {(screen) => <ClientsList screen={screen} go={go} />}
    </Viewed>
  )
}

function Back({ go }: { go(path: string): void }) {
  return (
    <p>
      <a href={settingsPath('clients')} className="s-back" onClick={open(go, settingsPath('clients'))}>
        All Clients
      </a>
    </p>
  )
}

function MakeClient({ go }: { go(path: string): void }) {
  const action = useAction()
  const submit = async (names: Names) => {
    // Forms' Add a client comes here with `then=signing`: the Client is made, and the next screen is Set up signing for it (the one Clients list; Forms makes no second).
    const thenSigning = new URLSearchParams(window.location.search).get('then') === 'signing'
    await action.run(
      () => postView<Client>('clients/make', { name: names.name, legalName: names.legalName.trim() === '' ? null : names.legalName }),
      (made) => `Made ${made.name}.`,
      (made) => go(thenSigning ? formsHref(`/clients/new?client=${made.number}`) : settingsItemPath('clients', made.number)),
    )
  }
  return (
    <>
      <Back go={go} />
      <NewClientForm onCancel={() => go(settingsPath('clients'))} say={action.say} busy={action.busy} submit={(n) => void submit(n)} />
    </>
  )
}

function ClientOf({ id, go }: { id: number; go(path: string): void }) {
  const view = useView<ClientScreen>('clients/one', { number: String(id) })
  useFresh(['clients', 'mail'], view.reload)
  const action = useAction()
  const [editing, setEditing] = useState(false)
  const link = async (contactId: string, clientId: number) => {
    await action.run(() => postView('client-link', { contactId, clientId }), 'Linked. They count as this Client’s people now.')
    view.reload()
  }
  const save = async (revision: number, names: Names): Promise<boolean> => {
    const ok = await action.run(
      () => postView<Client>('clients/edit', { number: id, revision, name: names.name, legalName: names.legalName.trim() === '' ? null : names.legalName }),
      'Saved.',
      () => setEditing(false),
    )
    // Saved or refused, the page reads the Client again: a refusal is the Client having moved on, and the newer details are what the boxes are shown beside.
    view.reload()
    return ok
  }
  const archive = async (back: boolean) => {
    await action.run(
      () => postView<Client>(back ? 'clients/put-back' : 'clients/archive', { number: id }),
      (c) => (back ? `Put back. ${c.name} is in the lists and pickers again.` : `Archived. ${c.name} is out of the lists and pickers; its people stay linked.`),
    )
    view.reload()
  }
  return (
    <>
      <Back go={go} />
      <Viewed view={view.state} problem={view.problem} reload={view.reload} loading="Loading the Client">
        {(screen) => <ClientDetail screen={screen} busy={action.busy} say={action.say} editing={editing} onEditing={setEditing} onSave={save} onArchive={(b) => void archive(b)} onLink={(c, k) => void link(c, k)} go={go} />}
      </Viewed>
      {action.say && !editing && <Say say={action.say} />}
      <Done text={action.done} />
    </>
  )
}
