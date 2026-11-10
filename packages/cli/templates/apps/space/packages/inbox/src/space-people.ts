/**
 * The inbox's contacts as People draws them: the directory, one
 * person's profile, the business, role and note, a merge of two contacts and its undo, a rename and a split. The contract is packages/workspace/src/inbox-for-space.ts (the
 * methods) and inbox-people.ts (the shapes). Like src/space-views.ts, a function over the inbox's own store, so every rule here runs under plain
 * `bun` against the real store (test/space-people.test.ts), and the space's Worker calls it in-process (src/space-part.ts).
 *
 * ── THE SAME GATES ────────────────────────────────────────────────────────
 * Reading the directory is a person's (`personGate`, src/space-gate.ts): a person is shown the contacts on mail they may see (`contactSeen`, src/queue.ts), with counts that are over that mail alone; the owner also
 * the contacts who are on none (the inbox's ADR 0004). Changing a contact (its fields, a merge, a rename, a split) is the owner's alone (`ownerGate`), and the owner too
 * only changes a contact they may see. The actor of a write is the owner's address, never Claude (a service token is not admitted), so the audit says who changed a person.
 *
 * ── WHAT IS ASKED OF THE STORE, AND NOTHING BESIDES ───────────────────────
 * The profile fields, the merge and its undo are the store's (src/store/space.ts, src/store/store.ts): the revision check, the limits and the
 * audit live there, once, so this file only verifies who is asking, checks the arguments are the shape the contract says, and puts the Client's
 * name beside its id (the Clients part, asked afresh and never cached, as everywhere else).
 */

import {
  answered,
  type InboxContact,
  type InboxContactProfile,
  type InboxContacts,
  type InboxContactsScope,
  type InboxForSpace,
  type InboxMerge,
  type InboxMerged,
  type InboxProfileEdit,
  type InboxRename,
  type InboxSplit,
  type InboxSplitDone,
  type InboxUnmerged,
  normalizeAddress,
  refused,
  type SignedIn,
  type SpaceReply,
} from '@space/workspace'
import { type ClientsRead, clientLabel, clientsById, readClients, suggestClients } from './clients'
import { inboxOwnerOf } from './owner'
import type { MailScope } from './queue'
import {
  type AsOwner,
  type AsPerson,
  BAD,
  ID,
  isCount,
  isRecord,
  outcomeOf,
  type SpaceDeps,
  spelled,
} from './space-gate'
import type { SpaceContactFacts } from './store/space'
import type { Result } from './store/store'
import type { ClientLabel } from './types'

type People = Pick<
  InboxForSpace,
  | 'contacts'
  | 'contact'
  | 'saveContactProfile'
  | 'mergeContacts'
  | 'undoContactMerge'
  | 'renameContact'
  | 'splitAddress'
>

const isText = (v: unknown): v is string => typeof v === 'string'

function reply<T, U>(r: Result<T>, map: (value: T) => U): SpaceReply<U> {
  return r.ok ? answered(map(r.value)) : outcomeOf(r)
}

export function createSpacePeople(deps: SpaceDeps, asOwner: AsOwner, asPerson: AsPerson): People {
  const { store } = deps
  const ownDomain = inboxOwnerOf(deps.install).domain

  /** A contact as the directory lists it: the Client by name from the Clients part, the one the inbox only suggests, and the revision. */
  function contactOf(
    facts: SpaceContactFacts,
    dir: ClientsRead | null,
    suggested: ReadonlyMap<string, ClientLabel>,
  ): InboxContact {
    const c = facts.contact
    const byId = clientsById(dir?.clients ?? [])
    const client = c.clientId === null ? null : clientLabel(c.clientId, byId)
    return {
      contactId: c.id,
      name: c.name,
      identities: c.identities.map((i) => ({ id: i.id, kind: i.kind, address: i.address })),
      addresses: spelled(c.identities.filter((i) => i.kind === 'email').map((i) => i.address)),
      client,
      suggestedClient: client === null ? (suggested.get(c.id) ?? null) : null,
      business: facts.business,
      role: facts.role,
      conversations: c.conversations,
      rev: facts.rev,
      sendsFrom: facts.sendsFrom,
      automated: c.sender.automated,
      ...(facts.groups.length > 0 && {
        groups: facts.groups.map((g) => ({
          contactId: g.contactId,
          name: g.name,
          lastWroteAt: Date.parse(g.lastWroteAt),
        })),
      }),
    }
  }

  /** What the inbox only suggests for the contacts with no Client (its own rule): nothing at all while the Clients part does not answer. */
  async function suggestions(
    unlinked: boolean,
    dir: ClientsRead | null,
    mail: MailScope,
  ): Promise<Map<string, ClientLabel>> {
    const out = new Map<string, ClientLabel>()
    if (!unlinked || !dir?.available) return out
    for (const s of suggestClients(await store.call('suggestionContacts', mail), dir.clients, ownDomain)) {
      if (!out.has(s.contactId)) out.set(s.contactId, { id: s.clientId, name: s.clientName, listed: true })
    }
    return out
  }

  const profileOf = (
    facts: SpaceContactFacts & { notes: string },
    dir: ClientsRead | null,
    suggested: ReadonlyMap<string, ClientLabel>,
  ): InboxContactProfile => ({
    ...contactOf(facts, dir, suggested),
    notes: facts.notes,
  })

  /** One contact read afresh, as the profile: what a write answers with. */
  async function profileNow(contactId: string, mail: MailScope): Promise<Result<InboxContactProfile>> {
    const found = await store.call('spaceContactProfile', contactId, mail)
    if (!found.ok) return found
    const dir = await readClients(deps.clients, deps.install)
    return {
      ok: true,
      value: profileOf(found.value, dir, await suggestions(found.value.contact.clientId === null, dir, mail)),
    }
  }

  /** The owner's scope, which a write of the owner's reads its answer with, and the check that the contact it changes is one the owner may see (as for any id: not told apart from one that is not there). */
  async function ownerSees(actor: string, ...contactIds: string[]): Promise<{ mail: MailScope; seen: boolean }> {
    const mail = await store.call('mailScope', actor)
    const found = await Promise.all(contactIds.map((contactId) => store.call('spaceContact', { contactId }, mail)))
    return { mail, seen: found.every((c) => c !== null) }
  }

  const contacts = (asker: SignedIn, scope?: InboxContactsScope) =>
    asPerson(asker, async ({ scope: mail }): Promise<SpaceReply<InboxContacts>> => {
      if (
        scope !== undefined &&
        (!isRecord(scope) || (scope.automated !== undefined && typeof scope.automated !== 'boolean'))
      ) {
        return BAD('The scope is {"automated": true} or nothing.')
      }
      const found = await store.call('spaceContacts', scope?.automated === true, mail)
      const dir = found.contacts.length > 0 ? await readClients(deps.clients, deps.install) : null
      const suggested = await suggestions(
        found.contacts.some((f) => f.contact.clientId === null),
        dir,
        mail,
      )
      return answered({ contacts: found.contacts.map((f) => contactOf(f, dir, suggested)), automated: found.automated })
    })

  const contact = (asker: SignedIn, contactId: string) =>
    asPerson(asker, async ({ scope: mail }): Promise<SpaceReply<InboxContactProfile>> => {
      if (!isText(contactId) || !ID.test(contactId)) return refused('not-found', 'No such contact.')
      return reply(await profileNow(contactId, mail), (p) => p)
    })

  const saveContactProfile = (asker: SignedIn, edit: InboxProfileEdit) =>
    asOwner(asker, async (actor): Promise<SpaceReply<InboxContactProfile>> => {
      if (!isRecord(edit))
        return BAD('A profile edit names the person, the revision you were shown and the three fields.')
      const { contactId, rev, business, role, notes } = edit
      if (!isText(contactId) || !ID.test(contactId)) return refused('not-found', 'No such contact.')
      if (!isCount(rev)) return BAD('Say which revision of the person you were shown (rev).')
      if (!isText(business) || !isText(role) || !isText(notes))
        return BAD('The business, the role and the note are text.')
      const { mail, seen } = await ownerSees(actor, contactId)
      if (!seen) return refused('not-found', 'No such contact.')
      // The limit on the three fields is the store's (`saveContactProfile`), refused there as 422 and shown here as bad-request: it is not checked a second time in this file.
      const saved = await store.call('saveContactProfile', { contactId, rev, business, role, notes }, actor)
      if (!saved.ok) return outcomeOf(saved)
      return reply(await profileNow(contactId, mail), (p) => p)
    })

  const mergeContacts = (asker: SignedIn, merge: InboxMerge) =>
    asOwner(asker, async (actor): Promise<SpaceReply<InboxMerged>> => {
      if (!isRecord(merge)) return BAD('A merge names the two people and the revision of each you were shown.')
      const { survivorId, survivorRev, absorbedId, absorbedRev } = merge
      if (!isText(survivorId) || !ID.test(survivorId) || !isText(absorbedId) || !ID.test(absorbedId))
        return refused('not-found', 'No such contact.')
      if (!isCount(survivorRev) || !isCount(absorbedRev))
        return BAD('Say which revision of each person you were shown.')
      const { mail, seen } = await ownerSees(actor, survivorId, absorbedId)
      if (!seen) return refused('not-found', 'No such contact.')
      const absorbed = await store.call('getContact', absorbedId, mail)
      const done = await store.call('mergeContacts', survivorId, absorbedId, actor, { survivorRev, absorbedRev })
      if (!done.ok) return outcomeOf(done)
      const survivor = await profileNow(survivorId, mail)
      if (!survivor.ok) return outcomeOf(survivor)
      const moved = (absorbed.ok ? absorbed.value.identities : [])
        .filter((i) => i.kind === 'email')
        .flatMap((i) => normalizeAddress(i.address) ?? [])
      return answered({
        mergeId: done.value.mergeId,
        survivor: survivor.value,
        absorbedName: absorbed.ok ? absorbed.value.name : '',
        moved: [...new Set(moved)].sort(),
      })
    })

  const undoContactMerge = (asker: SignedIn, mergeId: number) =>
    asOwner(asker, async (actor): Promise<SpaceReply<InboxUnmerged>> => {
      if (!isCount(mergeId)) return BAD('Name the merge: the number the inbox answered.')
      const mail = await store.call('mailScope', actor)
      const undone = await store.call('undoMerge', mergeId, actor)
      if (!undone.ok) return outcomeOf(undone)
      const [survivor, restored] = await Promise.all([
        profileNow(undone.value.survivor.id, mail),
        profileNow(undone.value.restored.id, mail),
      ])
      if (!survivor.ok) return outcomeOf(survivor)
      if (!restored.ok) return outcomeOf(restored)
      return answered({ survivor: survivor.value, restored: restored.value })
    })

  /**
   * The inbox's own Rename (`PATCH /api/contacts/:id`, `renameContact`), as the owner, at the revision shown. The store's refusals are the page's: no such contact (404), an empty name (422, "A contact
   * needs a name."), and the rename is audited with the owner as its actor. No length is added here: the inbox's page has none either.
   */
  const renameContact = (asker: SignedIn, rename: InboxRename) =>
    asOwner(asker, async (actor): Promise<SpaceReply<InboxContactProfile>> => {
      if (!isRecord(rename)) return BAD('A rename names the person, the revision you were shown and the new name.')
      const { contactId, rev, name } = rename
      if (!isText(contactId) || !ID.test(contactId)) return refused('not-found', 'No such contact.')
      if (!isCount(rev)) return BAD('Say which revision of the person you were shown (rev).')
      if (!isText(name)) return BAD('A name is text.')
      const { mail, seen } = await ownerSees(actor, contactId)
      if (!seen) return refused('not-found', 'No such contact.')
      const done = await store.call('renameContact', contactId, name, actor, { rev })
      if (!done.ok) return outcomeOf(done)
      return reply(await profileNow(contactId, mail), (p) => p)
    })

  /**
   * The inbox's own Split off (`POST /api/identities/:id/split`, `splitIdentity`), as the owner, for an address of the contact shown and at that contact's revision: an address that is not that
   * contact's is "No such address" (404), a contact's only address is refused (422), and a contact that moved on since is 409 with nothing split. Both contacts are read afresh for the answer.
   */
  const splitAddress = (asker: SignedIn, split: InboxSplit) =>
    asOwner(asker, async (actor): Promise<SpaceReply<InboxSplitDone>> => {
      if (!isRecord(split)) return BAD('A split names the person, the revision you were shown and the address.')
      const { contactId, rev, identityId } = split
      if (!isText(contactId) || !ID.test(contactId)) return refused('not-found', 'No such contact.')
      if (!isText(identityId) || !ID.test(identityId)) return refused('not-found', 'No such address.')
      if (!isCount(rev)) return BAD('Say which revision of the person you were shown (rev).')
      const { mail, seen } = await ownerSees(actor, contactId)
      if (!seen) return refused('not-found', 'No such contact.')
      const done = await store.call('splitIdentity', identityId, actor, { contactId, rev })
      if (!done.ok) return outcomeOf(done)
      const [from, contact] = await Promise.all([
        profileNow(done.value.from.id, mail),
        profileNow(done.value.contact.id, mail),
      ])
      if (!from.ok) return outcomeOf(from)
      if (!contact.ok) return outcomeOf(contact)
      return answered({ from: from.value, contact: contact.value })
    })

  return { contacts, contact, saveContactProfile, mergeContacts, undoContactMerge, renameContact, splitAddress }
}
