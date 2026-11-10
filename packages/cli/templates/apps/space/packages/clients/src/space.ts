/**
 * The Clients part as the space calls it: what Settings is drawn from and changes. It runs INSIDE the space's Worker (the company layer's ADR 0003), a function over the store the space's Worker holds, with its
 * externals passed in, so `bun test` drives it over a real store with no Workers runtime.
 *
 * EVERY METHOD is handed the person the space's ONE sign-in check named (`SignedIn`); the assertion was verified once, by the space, and is not here, and no service token comes through (a token is never a
 * person). This part's own rule is the only step left: it admits the install's owner and nobody else, so a teammate who is not an owner is `not-admitted`, even though Cloudflare signed them. The actor stamped on
 * a write is the owner's address.
 */

import {
  answered,
  type Client,
  type ClientEdit,
  type ClientList,
  type ClientMake,
  type ClientsBookmark,
  type ClientsCounts,
  type ClientsForSpace,
  type Failed,
  failed,
  type Install,
  NOT_ADMITTED,
  type Refused,
  refused,
  type SignedIn,
  type SpaceReply,
} from '@space/workspace'
import { BAD, guarded, isRecord, reply } from './reply'
import type { StoreApi } from './store'
import type { ClientsObject } from './store-access'

export interface SpaceClientsDeps {
  store: StoreApi
  install: Install
  /** The object itself, for the operator's bookmark, restart and counts. Absent: they answer `broken`. */
  object?: ClientsObject
}

/** A new Client as the entrypoint was handed it, read: it is not trusted to be the contract's shape. */
function readMake(raw: unknown): { ok: true; make: ClientMake } | Refused {
  if (!isRecord(raw)) return BAD('A new Client is an object with a name.')
  if (typeof raw.name !== 'string') return BAD('A Client needs a name.')
  if (raw.legalName !== undefined && raw.legalName !== null && typeof raw.legalName !== 'string') return BAD('A legal name is text, or empty.')
  return { ok: true, make: { name: raw.name, ...(raw.legalName !== undefined && { legalName: raw.legalName }) } }
}

function readEdit(raw: unknown): { ok: true; edit: ClientEdit } | Refused {
  if (!isRecord(raw)) return BAD('A change is an object.')
  if (raw.name !== undefined && typeof raw.name !== 'string') return BAD('The name is text.')
  if (raw.legalName !== undefined && raw.legalName !== null && typeof raw.legalName !== 'string') return BAD('The legal name is text, or empty.')
  return { ok: true, edit: { ...(raw.name !== undefined && { name: raw.name as string }), ...(raw.legalName !== undefined && { legalName: raw.legalName as string | null }) } }
}

/** The space's entrypoint, over a store. */
export function createSpaceClients(deps: SpaceClientsDeps): ClientsForSpace {
  const { store, install, object } = deps
  const noObject = () => failed('The Clients store could not be reached to do that.')

  /** This part's own rule: the owner and no one else. */
  function admit(asker: SignedIn): { ok: true; actor: string } | Refused {
    if (!install.isOwner(asker.person)) {
      console.warn('clients: signed in but not an owner')
      return refused('not-admitted', NOT_ADMITTED)
    }
    return { ok: true, actor: asker.person.address }
  }

  /** Run `fn` as the owner; nothing it throws leaves as an exception. */
  async function asOwner<R>(asker: SignedIn, fn: (actor: string) => Promise<R>): Promise<R | Refused | Failed> {
    const admitted = admit(asker)
    if (!admitted.ok) return admitted
    return guarded('answering', () => fn(admitted.actor))
  }

  return {
    clients: (asker) =>
      asOwner(asker, async (): Promise<SpaceReply<ClientList>> => {
        const all = await store.call('list')
        if (!all.ok) return refused(all.reason, all.error)
        const source = await store.call('sourceStatus')
        if (!source.ok) return refused(source.reason, source.error)
        return answered({
          active: all.value.filter((c) => c.archivedAt === null),
          archived: all.value.filter((c) => c.archivedAt !== null),
          source: source.value,
        })
      }),

    client: (asker, number) => asOwner(asker, async (): Promise<SpaceReply<Client>> => reply(await store.call('get', number))),

    makeClient: (asker, make) =>
      asOwner(asker, async (actor): Promise<SpaceReply<Client>> => {
        const read = readMake(make)
        if (!read.ok) return read
        return reply(await store.call('make', read.make.name, read.make.legalName, actor))
      }),

    editClient: (asker, number, revision, edit) =>
      asOwner(asker, async (actor): Promise<SpaceReply<Client>> => {
        const read = readEdit(edit)
        if (!read.ok) return read
        return reply(await store.call('edit', number, revision, read.edit, actor))
      }),

    archiveClient: (asker, number) => asOwner(asker, async (actor): Promise<SpaceReply<Client>> => reply(await store.call('archive', number, actor))),

    putBackClient: (asker, number) => asOwner(asker, async (actor): Promise<SpaceReply<Client>> => reply(await store.call('putBack', number, actor))),

    // The operator's three (see the contract). Each is the owner's; none touches a Client.
    storeBookmark: (asker) =>
      asOwner(asker, async (): Promise<SpaceReply<ClientsBookmark>> => (object ? answered({ bookmark: await object.bookmark() }) : noObject())),

    restartStore: (asker) =>
      asOwner(asker, async (): Promise<SpaceReply<{ restarted: true }>> => {
        if (!object) return noObject()
        try {
          await object.restart()
        } catch {
          // The object was reset under the call, which is what was asked. Whether it restarted under the new code is read in the Worker's log, not here.
        }
        return answered({ restarted: true as const })
      }),

    storeCounts: (asker) => asOwner(asker, async (): Promise<SpaceReply<ClientsCounts>> => (object ? answered(await object.counts()) : noObject())),
  }
}
