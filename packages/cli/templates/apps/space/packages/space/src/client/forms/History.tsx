import { api } from './api'
import { Card, Notice, useLoad, when } from './kit'
import { href } from './route'

export function History() {
  const { data, error } = useLoad(() => Promise.all([api.audit(), api.clients()]), [])
  if (error) return <Notice kind="error">{error}</Notice>
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>
  const [rows, clients] = data
  const names = new Map(clients.map((c) => [c.id, c.display_name]))
  return (
    <>
      <h1 className="text-xl font-semibold">History</h1>
      <Card>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">Nothing has been changed yet.</p> : null}
        <ul className="divide-y divide-border text-sm">
          {rows.map((a) => (
            <li key={a.id} className="grid gap-0.5 py-2 sm:grid-cols-[11rem_1fr] sm:gap-3">
              <span className="text-muted-foreground">{when(a.at)}</span>
              <span className="min-w-0 break-words">
                {a.actor}{' '}
                {a.action === 'purge' ? ('deleted an envelope early') : a.entity === 'settings' ? ('changed Claude\'s sending switch') : a.action === 'seal-check' ? (
                  'ran the seal check'
                ) : (
                  <>
                    {a.action === 'create' ? 'added' : 'changed'}{' '}
                    {a.client_id && names.has(a.client_id) ? (
                      <a className="underline" href={href(`/clients/${a.client_id}`)}>
                        {names.get(a.client_id)}
                      </a>
                    ) : (
                      a.entity
                    )}
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  )
}
