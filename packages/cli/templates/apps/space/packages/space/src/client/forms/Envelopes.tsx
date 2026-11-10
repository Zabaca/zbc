import { useFresh } from '../liveHub'
import { api } from './api'
import { Badge, INPUT, LinkButton, Notice, useLoad, when } from './kit'
import { go, href } from './route'

const STATUSES = ['draft', 'sent', 'prepared', 'sealing', 'completed', 'declined', 'cancelled', 'expired']

/** Every sending, by client and status. */
export function Envelopes({ client, status }: { client: string | null; status: string | null }) {
  const clients = useLoad(() => api.clients(), [])
  const list = useLoad(() => api.envelopes({ client: client ?? undefined, status: status ?? undefined }), [client, status])
  // A sending moves on its own (opened, signed, sealed, expired): the list is read again when documents move and when the page is shown again.
  useFresh(['documents'], () => void list.reload())
  const set = (key: 'client' | 'status', v: string) => {
    const q = new URLSearchParams({ ...(client ? { client } : {}), ...(status ? { status } : {}) })
    if (v) q.set(key, v)
    else q.delete(key)
    go(`/envelopes${q.size ? `?${q}` : ''}`)
  }
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Envelopes</h1>
        <LinkButton href={href(`/send${client ? `?client=${client}` : ''}`)} kind="primary">
          Send the sample
        </LinkButton>
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="grid gap-1 text-sm font-medium">
          Client
          <select className={INPUT} value={client ?? ''} onChange={(e) => set('client', e.target.value)}>
            <option value="">All clients</option>
            {(clients.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.display_name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Status
          <select className={INPUT} value={status ?? ''} onChange={(e) => set('status', e.target.value)}>
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      {list.error ? <Notice kind="error">{list.error}</Notice> : null}
      {list.loading && !list.data ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {list.data && list.data.length === 0 ? <Notice kind="info">Nothing has been sent{client || status ? ' that matches' : ''}. Send the built-in sample to yourself and a second address to see the whole thing work.</Notice> : null}
      {list.data && list.data.length > 0 ? (
        <ul className="grid gap-2" aria-label="Envelopes">
          {list.data.map((e) => (
            <li key={e.id}>
              <a href={href(`/envelopes/${e.id}`)} className="grid gap-1 rounded-lg border border-border bg-card p-3 hover:bg-accent sm:grid-cols-[1fr_auto] sm:items-center">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{e.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {e.client_name} · {e.signed ?? 0} of {e.signers ?? 0} signed · {e.sent_at ? `sent ${when(e.sent_at)}` : `drafted ${when(e.created_at)}`}
                  </span>
                </span>
                <Badge status={e.status} />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}
