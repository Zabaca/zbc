// Set up signing for a Client: the settings a signer sees (short name, where replies go, colour, time zone, how long records are kept) for a Client that is already in the
// space's one list. There is no second Client made here: a Client is made in Settings (Add a client goes there and comes back), and its name and legal name are its own. A Client with no legal name is asked for one, and it is saved on the Client.
import type { Client as SpaceClient } from '@space/workspace'
import type { ClientScreen } from '../../clients-settings'
import { getView, postView } from '../views'
import { api } from './api'
import { ClientForm } from './ClientForm'
import { Card, Notice, useLoad } from './kit'
import { go, href } from './route'

const NUMBER = /^[1-9][0-9]{0,9}$/

export function NewClient({ number }: { number: string | null }) {
  const open = useLoad(() => api.clientsNotSetUp(), [])
  const rows = useLoad(() => api.clients(), [])
  const n = number !== null && NUMBER.test(number) ? Number(number) : null
  const found = n === null ? undefined : open.data?.clients.find((c) => c.number === n)
  const has = n === null ? undefined : rows.data?.find((c) => c.client_number === n)
  const loading = (open.loading && !open.data) || (rows.loading && !rows.data)

  return (
    <>
      <div>
        <a href={href('/')} className="text-sm text-muted-foreground underline">
          Clients
        </a>
        <h1 className="text-xl font-semibold">{found ? `Set up signing for ${found.name}` : 'Set up signing'}</h1>
      </div>
      {open.error || rows.error ? <Notice kind="error">{open.error ?? rows.error}</Notice> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {open.data && !open.data.available ? <Notice kind="warn">The list of Clients could not be read just now, so signing cannot be set up. Try again in a moment.</Notice> : null}

      {n === null && open.data?.available ? (
        <Card title="Which Client?">
          {open.data.clients.length === 0 ? (
            <p className="text-sm">Every Client already has signing set up. A new Client is made in Settings.</p>
          ) : (
            <ul className="grid gap-2" aria-label="Clients without signing" data-testid="pick-a-client">
              {open.data.clients.map((c) => (
                <li key={c.number}>
                  <a className="underline" href={href(`/clients/new?client=${c.number}`)}>
                    {c.name}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {n !== null && has ? (
        <Notice kind="info">
          Signing is already set up for {has.display_name}.{' '}
          <a className="underline" href={href(`/clients/${has.id}`)}>
            Open its signing settings
          </a>
        </Notice>
      ) : null}

      {n !== null && !has && open.data?.available && !found ? (
        <Notice kind="warn">
          No active Client has the number {n}. An archived Client cannot be set up for signing: put it back in Settings first.{' '}
          <a className="underline" href={href('/')}>
            Back to the Clients
          </a>
        </Notice>
      ) : null}

      {found ? (
        <ClientForm
          create={{ name: found.name, legalName: found.legalName, number: found.number }}
          submitLabel="Set up signing"
          onSubmit={async (input, legalName) => {
            if (legalName) {
              // The legal name is the Client's: read the Client as it is now to name its revision, and save it there before the settings are made.
              const seen = await getView<ClientScreen>('clients/one', { number: String(found.number) })
              if (seen.kind !== 'value' || seen.value.client === null) throw new Error('The Client could not be read just now, so its legal name was not saved. Nothing was set up.')
              const saved = await postView<SpaceClient>('clients/edit', { number: found.number, revision: seen.value.client.revision, legalName })
              if (!saved.ok) throw new Error(saved.say.text)
            }
            const created = await api.createClient({ ...input, client_number: found.number })
            go(`/clients/${created.id}`)
          }}
        />
      ) : null}
    </>
  )
}
