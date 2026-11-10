/**
 * The knowledge app as the space calls it: what the Knowledge tab is drawn from and changes. It runs INSIDE the space's Worker (the
 * company layer's ADR 0003), a function over the store the space's Worker holds, with its externals passed in, so `bun test` drives it
 * over a real store with no Workers runtime.
 *
 * EVERY METHOD is handed the person the space's ONE sign-in check named (`SignedIn`); the assertion was verified once, by the space,
 * and is not here, and no service token comes through (a token is never a person). This app's own rule is the only step left: it
 * admits the install's owner and nobody else, so a teammate who is not an owner is `not-admitted`, even though Cloudflare signed
 * them. The actor stamped on a write is the owner's address.
 */

import {
  answered,
  failed,
  type Failed,
  type Install,
  type KnowledgeBase,
  type KnowledgeChange,
  type KnowledgeEntry,
  type KnowledgeForSpace,
  NOT_ADMITTED,
  KNOWLEDGE_BOOKMARK,
  type KnowledgeBookmark,
  type Refused,
  refused,
  type SignedIn,
  type SpaceReply,
} from '@space/workspace'
import { BAD, ENTRY_ID, guarded, isCount, isRecord, isText, readBase, reply, textList } from './reply'
import type { StoreApi } from './store'
import type { KnowledgeObject } from './store-access'

export interface SpaceKnowledgeDeps {
  store: StoreApi
  install: Install
  /** The object itself, for the operator's bookmark, restart and restore. Absent: they answer `broken`. */
  object?: KnowledgeObject
}

/** The shapes a change may take, read: what the entrypoint was handed is not trusted to be the contract's shape. */
function readChange(raw: unknown): { ok: true; change: KnowledgeChange } | Refused {
  if (!isRecord(raw)) return BAD('A knowledge change is an object.')
  const entry = (): { id: string; version: number } | Refused => {
    if (!isText(raw.id) || !ENTRY_ID.test(raw.id)) return refused('not-found', 'No such entry.')
    if (!isCount(raw.version)) return BAD('Say which version of the entry you were shown (version).')
    return { id: raw.id, version: raw.version }
  }
  switch (raw.do) {
    case 'add': {
      if (!isText(raw.title) || !isText(raw.body)) return BAD('An entry needs a title and a body.')
      const businesses = textList(raw.businesses)
      if (businesses === null) return BAD('An entry needs at least one business, so that some assistant reads it.')
      return { ok: true, change: { do: 'add', title: raw.title, body: raw.body, businesses } }
    }
    case 'edit': {
      const named = entry()
      if ('ok' in named) return named
      if (raw.title !== undefined && !isText(raw.title)) return BAD('The title is text.')
      if (raw.body !== undefined && !isText(raw.body)) return BAD('The body is text.')
      let businesses: string[] | undefined
      if (raw.businesses !== undefined) {
        const list = textList(raw.businesses)
        if (list === null) return BAD('The businesses are a list.')
        businesses = list
      }
      return {
        ok: true,
        change: {
          do: 'edit',
          ...named,
          ...(raw.title !== undefined && { title: raw.title as string }),
          ...(raw.body !== undefined && { body: raw.body as string }),
          ...(businesses !== undefined && { businesses }),
        },
      }
    }
    case 'remove':
    case 'restore':
    case 'approve':
    case 'reject': {
      const named = entry()
      if ('ok' in named) return named
      return { ok: true, change: { do: raw.do, ...named } }
    }
    default:
      return BAD('A knowledge change is add, edit, remove, restore, approve or reject.')
  }
}

/** The space's entrypoint, over a store. */
export function createSpaceKnowledge(deps: SpaceKnowledgeDeps): KnowledgeForSpace {
  const { store, install, object } = deps
  const noObject = () => failed('The knowledge store could not be reached to do that.')

  /** This app's own rule: the owner and no one else. */
  function admit(asker: SignedIn): { ok: true; actor: string } | Refused {
    if (!install.isOwner(asker.person)) {
      console.warn('knowledge: signed in but not an owner')
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
    knowledge: (asker, business) =>
      asOwner(asker, async (): Promise<SpaceReply<KnowledgeBase>> => readBase(store, install, business ?? null)),

    changeKnowledge: (asker, change) =>
      asOwner(asker, async (actor): Promise<SpaceReply<KnowledgeEntry>> => {
        const read = readChange(change)
        if (!read.ok) return read
        const c = read.change
        if (c.do === 'add') return reply(await store.call('add', c.title, c.body, c.businesses, actor))
        if (c.do === 'edit') {
          const { id, do: _do, ...changes } = c
          return reply(await store.call('edit', id, changes, actor))
        }
        // Remove, put back, approve and reject all name an entry and the version the owner was shown.
        return reply(await store.call(c.do, c.id, c.version, actor))
      }),

    // The operator's three (see the contract). Each is the owner's; none touches an entry.
    storeBookmark: (asker) =>
      asOwner(asker, async (): Promise<SpaceReply<KnowledgeBookmark>> => (object ? answered({ bookmark: await object.bookmark() }) : noObject())),

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

    restoreStore: (asker, bookmark) =>
      asOwner(asker, async (): Promise<SpaceReply<{ restoring: true }>> => {
        if (!object) return noObject()
        if (typeof bookmark !== 'string' || !KNOWLEDGE_BOOKMARK.test(bookmark)) return BAD('That is not a bookmark of the knowledge store.')
        await object.restoreTo(bookmark)
        try {
          await object.restart()
        } catch {
          // As above: the restore happens when the object starts again.
        }
        return answered({ restoring: true as const })
      }),
  }
}
