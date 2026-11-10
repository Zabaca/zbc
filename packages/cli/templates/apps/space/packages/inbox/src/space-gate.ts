/**
 * Who is asking, and what every answer of the inbox's part of the space looks like: the one gate that src/space.ts (mail) and
 * src/space-views.ts (the inbox's other views) both go through, so the two cannot read the rule two ways.
 *
 * THE SIGN-IN IS NOT CHECKED HERE ANY MORE (the company layer's ADR 0003): the inbox's part runs in the space's
 * Worker, which checked the Access assertion once for the request and hands every method the person it named (`SignedIn`). What is left is the inbox's own rule, in two gates:
 *
 *   - `personGate`: the install's owner is admitted always, and anyone else of the install once they are on at least one mailbox (the inbox's ADR 0004); the function
 *     is handed what they may see (`MailScope`, src/queue.ts), which every read it makes must be cut to. Anyone who is on no mailbox is `not-admitted`.
 *   - `ownerGate`: the install's owner and nobody else (`roleFor`): connecting Gmail, Claude's switch, restore, the operator's three, the Clients and the contacts' writes.
 *
 * Nothing a method throws leaves it as an exception, because the space reads a refusal as a decision and a fault as `broken`.
 */

import {
  type ClientsForInbox,
  type Failed,
  failed,
  NOT_ADMITTED,
  normalizeAddress,
  type Refused,
  refused,
  type SignedIn,
} from '@space/workspace'
import type { StoreApi } from './app'
import { canSee, type MailScope, mayEnter } from './queue'
import type { Refusal } from './store/store'
import { type Install, roleFor } from './workspace'

export interface SpaceDeps {
  store: StoreApi
  install: Install
  /** The Clients part's inbox face, asked afresh when an answer carries a Client and never cached. */
  clients: ClientsForInbox | null | undefined
  /** The Google OAuth web client's id (the var INBOX_GOOGLE_CLIENT_ID), for the sign-in address Connect Gmail sends the browser to. Unset or blank: that step says it is not set up. */
  googleClientId?: string | undefined
  /**
   * The store's Durable Object, for the operator's three (bookmark, counts, restart: src/space-operator.ts). Absent where the part is made over a bare store (the unit tests of the
   * other methods): the operator then answers `broken`.
   */
  object?: (() => StoreObject) | undefined
}

/** The store's object as the operator reaches it: the three methods of `InboxDO` that are not `call` (src/durable.ts). */
export interface StoreObject {
  bookmark(): Promise<string>
  counts(): Promise<Record<string, number>>
  /** Always ends with the object reset under the caller: an error is the expected answer. */
  restart(): Promise<void>
}

/** What a conversation or message id looks like (the store's own are uuids; the check keeps a path-shaped string out of a query). */
export const ID = /^[A-Za-z0-9-]{1,64}$/

export const FAULT = 'The inbox could not answer that. Nothing was changed.'
export const BAD = (what: string): Refused => refused('bad-request', what)

/** A store refusal as the contract's refusal or failure. A 502 or 503 is the inbox saying a thing it depends on failed. */
export function outcomeOf(r: { status: Refusal; error: string }): Refused | Failed {
  switch (r.status) {
    case 403:
      return refused('not-admitted', r.error)
    case 404:
      return refused('not-found', r.error)
    case 409:
      return refused('conflict', r.error)
    case 413:
    case 415:
    case 422:
      return refused('bad-request', r.error)
    default:
      return failed(r.error)
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
export const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/** Every email address a contact has, in the one spelling, once each, sorted. */
export const spelled = (emails: readonly string[]): string[] =>
  [...new Set(emails.flatMap((e) => normalizeAddress(e) ?? []))].sort()

export const ms = (iso: string): number => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

/** Run `fn` as the owner, for the person the space's check named; nothing it throws leaves as an exception. */
export type AsOwner = <R>(asker: SignedIn, fn: (actor: string) => Promise<R>) => Promise<R | Refused | Failed>

export function ownerGate(deps: Pick<SpaceDeps, 'install'>): AsOwner {
  /** The inbox's own rule: `roleFor` admits the owner and nobody else. Anything else is the refusal to hand back. */
  function admit(asker: SignedIn): { ok: true; actor: string } | Refused {
    const who = roleFor({ kind: 'person', person: asker.person, exp: asker.exp }, deps.install, {})
    if (who?.role !== 'owner') {
      console.warn('space: signed in but not the inbox’s owner')
      return refused('not-admitted', NOT_ADMITTED)
    }
    return { ok: true, actor: who.actor }
  }

  return async function asOwner<R>(asker: SignedIn, fn: (actor: string) => Promise<R>): Promise<R | Refused | Failed> {
    let actor: string
    try {
      const admitted = admit(asker)
      if (!admitted.ok) return admitted
      actor = admitted.actor
    } catch (error) {
      console.error('space: the owner check failed', error)
      return failed(FAULT)
    }
    try {
      return await fn(actor)
    } catch (error) {
      console.error('space: answering failed', error)
      return failed(FAULT)
    }
  }
}

/** Who is asking, once admitted as a person of the install: their address (the actor every write stamps), what they may see, and whether they are the install's owner. */
export interface Asker {
  actor: string
  scope: MailScope
  owner: boolean
}

/** Run `fn` for a person of the install who may use the Inbox, handed what they may see; nothing it throws leaves as an exception. */
export type AsPerson = <R>(asker: SignedIn, fn: (who: Asker) => Promise<R>) => Promise<R | Refused | Failed>

export function personGate(deps: Pick<SpaceDeps, 'install' | 'store'>): AsPerson {
  return async function asPerson<R>(asker: SignedIn, fn: (who: Asker) => Promise<R>): Promise<R | Refused | Failed> {
    let who: Asker
    try {
      // The space's check names people of the install by their sign-in address; a name the install does not list is refused here as well, whatever made it.
      const person = deps.install.person(asker.person.address)
      if (person === null) {
        console.warn('space: signed in but not a person of this install')
        return refused('not-admitted', NOT_ADMITTED)
      }
      const actor = person.address.trim().toLowerCase()
      const owner = actor === deps.install.owner().address.trim().toLowerCase()
      const scope = await deps.store.call('mailScope', actor)
      if (!mayEnter(scope, owner)) {
        console.warn('space: signed in but on no mailbox')
        return refused('not-admitted', NOT_ADMITTED)
      }
      who = { actor, scope, owner }
    } catch (error) {
      console.error('space: the person check failed', error)
      return failed(FAULT)
    }
    try {
      return await fn(who)
    } catch (error) {
      console.error('space: answering failed', error)
      return failed(FAULT)
    }
  }
}

/**
 * Whether the person may see a conversation or a message, asked of the store by its id: false for one in a mailbox they are not on AND for one that does not exist, so the two cannot be told apart (an id the person may
 * not see is a 404). The one question every method that names a conversation or a message by its id asks before it does anything.
 */
export async function seesConversation(deps: Pick<SpaceDeps, 'store'>, scope: MailScope, id: string): Promise<boolean> {
  const where = await deps.store.call('mailboxOfConversation', id)
  return where !== null && canSee(scope, where.mailboxId)
}

export async function seesMessage(deps: Pick<SpaceDeps, 'store'>, scope: MailScope, id: string): Promise<boolean> {
  const where = await deps.store.call('mailboxOfMessage', id)
  return where !== null && canSee(scope, where.mailboxId)
}
