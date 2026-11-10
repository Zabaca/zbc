// The inbox's contacts for People, as a stand-in answers them: what `bun test` asks instead of the real inbox, and what a local page shows with fixture data
// (`SPACE_FIXTURES`, src/app.ts). The shapes are the contract's (packages/workspace/src/inbox-people.ts) and the rules are the ones the page leans on and the real
// inbox keeps (packages/inbox/src/store/space.ts): a write names the revision it was shown and is refused with `conflict` when the person has moved on, a merge moves
// the addresses and the conversations to the survivor and fills what the survivor left blank, and its undo puts the other person back.
//
// They check nothing about who is asking; the real inbox does, and the space's own tests prove the asker is passed along (`views.calls` records it, with every
// call's arguments). Each call goes through the views' script (`throw`, `hang`, `broken`), so a test can make the next one fail.

import {
  type SignedIn,
  type InboxContact,
  type InboxContactProfile,
  type InboxForSpace,
  profileLimitMessage,
  type SpaceReply,
  answered,
  failed,
  refused,
} from '@space/workspace'
import type { StandInContact, StandInThread } from './stand-ins'
import type { StandInViews } from './stand-in-views'

export type StandInPeopleMethods = Pick<InboxForSpace, 'contacts' | 'contact' | 'saveContactProfile' | 'mergeContacts' | 'undoContactMerge' | 'linkClient' | 'renameContact' | 'splitAddress'>

interface Merged {
  survivorId: string
  /** The absorbed contact as it was, and the survivor's fields before. */
  absorbed: StandInContact
  survivorBefore: Pick<StandInContact, 'business' | 'role' | 'notes' | 'client'>
  moved: string[]
  /** The survivor's revision as the merge left it: the undo restores its fields only if it is still this. */
  mergedRev: number
  /** The threads each was on, so the undo lists the right people on them again. */
  absorbedThreads: string[]
  survivorThreads: string[]
}

export function standInPeople(
  contacts: StandInContact[],
  threads: readonly Pick<StandInThread, 'id' | 'on' | 'messages' | 'telegramChat'>[],
  views: StandInViews,
  /** Told when a merge or its undo changed which contact is whom, so the inbox stand-in's own lookups follow. */
  changed: () => void,
): StandInPeopleMethods & { merges: Map<number, Merged> } {
  const merges = new Map<number, Merged>()
  let nextMerge = 1

  async function enter<T>(asker: SignedIn, method: string, args: unknown[]): Promise<SpaceReply<T> | null> {
    views.calls.push({ method, args, asker })
    const step = views.script.shift()
    if (step === 'throw') throw new Error('stand-in inbox lost the connection')
    if (step === 'hang') return new Promise(() => undefined)
    if (step === 'broken') return failed('The inbox could not answer that. Nothing was changed.')
    return null
  }

  const emails = (c: StandInContact) => [...c.addresses].sort()
  const conversationsOf = (c: StandInContact) => threads.filter((t) => t.on.includes(c.id)).length
  /** A Client as a pill names it: by the name the Clients show now (a Client renamed in Settings is renamed here), else the name the contact was given. */
  const clientRef = (c: StandInContact['client']) => (c ? { id: c.id, name: views.clientList().find((k) => k.summary.id === c.id)?.summary.name ?? c.name, listed: true } : null)
  /** The Telegram groups a person has written in: a group's messages are named by who wrote them, and the group's own contact is the thread's one participant. Newest first. */
  const groupsOf = (c: StandInContact) =>
    threads
      .flatMap((t) => {
        const wrote = (t.messages ?? []).filter((m) => m.direction === 'in' && m.from === c.name).reduce<number | null>((a, m) => (a === null || m.at > a ? m.at : a), null)
        const groupId = t.on[0]
        return t.telegramChat === 'group' && wrote !== null && groupId !== undefined ? [{ contactId: groupId, name: contacts.find((x) => x.id === groupId)?.name ?? groupId, lastWroteAt: wrote }] : []
      })
      .sort((a, b) => b.lastWroteAt - a.lastWroteAt)
  const contactOf = (c: StandInContact): InboxContact => ({
    contactId: c.id,
    name: c.name,
    identities: c.addresses.map((address, i) => ({ id: `${c.id}-i${i}`, kind: 'email' as const, address })),
    addresses: emails(c),
    client: clientRef(c.client),
    suggestedClient: c.client ? null : clientRef(c.suggested),
    business: c.business ?? '',
    role: c.role ?? '',
    conversations: conversationsOf(c),
    rev: c.rev ?? 0,
    automated: c.automated === true,
    ...(groupsOf(c).length > 0 && { groups: groupsOf(c) }),
  })
  const profileOf = (c: StandInContact): InboxContactProfile => ({ ...contactOf(c), notes: c.notes ?? '' })
  const find = (id: string) => contacts.find((c) => c.id === id)

  return {
    merges,
    // Linking a Client is the views' (stand-in-views.ts); the contact then carries it, as the inbox's list shows it.
    async linkClient(asker, contactId, clientId) {
      const done = await views.methods.linkClient(asker, contactId, clientId)
      if (!done.ok) return done
      const known = clientId === null ? null : views.clientList().find((k) => k.summary.id === clientId)
      if (clientId !== null && !known) return refused('bad-request', `There is no Client ${clientId}, so nothing was assigned.`)
      // A contact only the Clients' pages know (a suggestion for a person who has not written) has nothing to carry here.
      const c = find(contactId)
      if (c && known) c.client = { id: known.summary.id, name: known.summary.name }
      else if (c) delete c.client
      return done
    },
    async contacts(asker, scope) {
      return (
        (await enter(asker, 'contacts', scope === undefined ? [] : [scope])) ??
        answered({ contacts: contacts.filter((c) => c.chat === undefined && (scope?.automated === true || !c.automated)).map(contactOf), automated: contacts.filter((c) => c.chat === undefined && c.automated).length })
      )
    },
    async contact(asker, contactId) {
      const early = await enter<InboxContactProfile>(asker, 'contact', [contactId])
      if (early) return early
      const c = find(contactId)
      return c ? answered(profileOf(c)) : refused('not-found', 'No such contact.')
    },
    async saveContactProfile(asker, edit) {
      const early = await enter<InboxContactProfile>(asker, 'saveContactProfile', [edit])
      if (early) return early
      const c = find(edit.contactId)
      if (!c) return refused('not-found', 'No such contact.')
      const tooLong = profileLimitMessage(edit)
      if (tooLong !== null) return refused('bad-request', tooLong)
      const business = edit.business.trim()
      const role = edit.role.trim()
      const notes = edit.notes.trim()
      if ((c.rev ?? 0) !== edit.rev) return refused('conflict', 'This person changed since you opened them, so nothing was saved. They are shown as they are now.')
      if (c.business !== business || c.role !== role || c.notes !== notes) {
        c.business = business
        c.role = role
        c.notes = notes
        c.rev = (c.rev ?? 0) + 1
      }
      return answered(profileOf(c))
    },
    // The inbox's own Rename, at the revision shown: an empty name is refused in its words, a contact that moved on is a conflict, and a rename raises the revision.
    async renameContact(asker, rename) {
      const early = await enter<InboxContactProfile>(asker, 'renameContact', [rename])
      if (early) return early
      const c = find(rename.contactId)
      if (!c) return refused('not-found', 'No such contact.')
      const name = rename.name.trim()
      if (name === '') return refused('bad-request', 'A contact needs a name.')
      if ((c.rev ?? 0) !== rename.rev) return refused('conflict', 'This person changed since you opened them, so nothing was renamed. They are shown as they are now.')
      c.name = name
      c.rev = (c.rev ?? 0) + 1
      return answered(profileOf(c))
    },
    // The inbox's own Split off, at the revision of the contact it comes off: an address that is not that contact's is "No such address.", a contact's only address stays, and the new contact is named by the address.
    async splitAddress(asker, split) {
      const early = await enter<never>(asker, 'splitAddress', [split])
      if (early) return early as never
      const c = find(split.contactId)
      const at = c ? c.addresses.findIndex((_, i) => `${c.id}-i${i}` === split.identityId) : -1
      if (!c || at < 0) return refused('not-found', 'No such address.')
      if ((c.rev ?? 0) !== split.rev) return refused('conflict', 'This person changed since you opened them, so nothing was split. They are shown as they are now.')
      if (c.addresses.length < 2) return refused('bad-request', 'That is this contact’s only address, so there is nothing to split off.')
      const address = c.addresses[at] as string
      c.addresses.splice(at, 1)
      const made: StandInContact = { id: `${c.id}-split-${address}`, name: address, addresses: [address], rev: 0 }
      contacts.push(made)
      c.rev = (c.rev ?? 0) + 1
      // A thread goes with the address when everything said on it was said by (or to) that address; one that used both stays with the contact and is listed under the new one too.
      for (const t of threads) {
        if (!t.on.includes(c.id)) continue
        const mentions = (a: string) => (t.messages ?? []).some((m) => m.from.includes(a) || (m.to ?? '').includes(a))
        const stays = c.addresses.some(mentions)
        if (!mentions(address)) continue
        if (stays) t.on.push(made.id)
        else t.on[t.on.indexOf(c.id)] = made.id
      }
      changed()
      return answered({ from: profileOf(c), contact: profileOf(made) })
    },
    async mergeContacts(asker, merge) {
      const early = await enter<never>(asker, 'mergeContacts', [merge])
      if (early) return early as never
      const survivor = find(merge.survivorId)
      const absorbed = find(merge.absorbedId)
      if (!survivor || !absorbed) return refused('not-found', 'No such contact.')
      if (survivor === absorbed) return refused('bad-request', 'That is one contact; a merge needs two.')
      if ((survivor.rev ?? 0) !== merge.survivorRev || (absorbed.rev ?? 0) !== merge.absorbedRev) {
        return refused('conflict', 'One of them changed since you opened it, so nothing was merged. They are shown as they are now.')
      }
      const record: Merged = {
        survivorId: survivor.id,
        absorbed: { ...absorbed, addresses: [...absorbed.addresses] },
        survivorBefore: { business: survivor.business, role: survivor.role, notes: survivor.notes, client: survivor.client },
        moved: emails(absorbed),
        mergedRev: 0,
        absorbedThreads: threads.filter((t) => t.on.includes(absorbed.id)).map((t) => t.id),
        survivorThreads: threads.filter((t) => t.on.includes(survivor.id)).map((t) => t.id),
      }
      survivor.addresses = [...survivor.addresses, ...absorbed.addresses]
      for (const t of threads) {
        const at = t.on.indexOf(absorbed.id)
        if (at < 0) continue
        // A thread both were on lists the person once.
        if (t.on.includes(survivor.id)) t.on.splice(at, 1)
        else t.on[at] = survivor.id
      }
      if (!survivor.client && absorbed.client) survivor.client = absorbed.client
      survivor.business = survivor.business || absorbed.business
      survivor.role = survivor.role || absorbed.role
      survivor.notes = survivor.notes || absorbed.notes
      survivor.rev = (survivor.rev ?? 0) + 1
      record.mergedRev = survivor.rev
      contacts.splice(contacts.indexOf(absorbed), 1)
      const mergeId = nextMerge++
      merges.set(mergeId, record)
      changed()
      return answered({ mergeId, survivor: profileOf(survivor), absorbedName: absorbed.name, moved: record.moved })
    },
    async undoContactMerge(asker, mergeId) {
      const early = await enter<never>(asker, 'undoContactMerge', [mergeId])
      if (early) return early as never
      const was = merges.get(mergeId)
      if (!was) return refused('not-found', 'There is no such merge.')
      if (find(was.absorbed.id)) return refused('conflict', 'That merge was undone already.')
      if ([...merges].some(([id, m]) => id > mergeId && m.absorbed.id === was.absorbed.id)) return refused('conflict', `${was.absorbed.name} was merged again since, so that later merge is the one to undo.`)
      const survivor = find(was.survivorId)
      if (!survivor) return refused('conflict', 'The person it was merged into is not a contact any more, so this merge cannot be undone from here.')
      const back = was.absorbed.addresses.filter((a) => survivor.addresses.includes(a))
      if (back.length === 0) return refused('conflict', 'None of their addresses is on that contact any more, so there is nothing to undo.')
      const restored: StandInContact = { ...was.absorbed, addresses: back, rev: (was.absorbed.rev ?? 0) + 1 }
      contacts.push(restored)
      survivor.addresses = survivor.addresses.filter((a) => !back.includes(a))
      // The stand-in knows a thread by the contacts on it, not by the address: the threads the absorbed person was on list them again, and the survivor only where it was on them before.
      for (const t of threads) {
        if (!was.absorbedThreads.includes(t.id)) continue
        t.on.push(restored.id)
        if (!was.survivorThreads.includes(t.id)) t.on.splice(t.on.indexOf(survivor.id), 1)
      }
      if ((survivor.rev ?? 0) === was.mergedRev) {
        survivor.business = was.survivorBefore.business
        survivor.role = was.survivorBefore.role
        survivor.notes = was.survivorBefore.notes
        survivor.client = was.survivorBefore.client
      }
      survivor.rev = (survivor.rev ?? 0) + 1
      changed()
      return answered({ survivor: profileOf(survivor), restored: profileOf(restored) })
    },
  }
}
