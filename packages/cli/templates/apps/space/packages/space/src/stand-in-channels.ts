// The channel admin of the stand-in for meet (stand-ins.ts `standInMeet`): New channel, Invite a guest, and a change to a channel, in memory, so `bun test` and a local page with fixtures can draw
// and press them without meet.
//
// It keeps meet's RULES only as far as the page needs them to draw (what `may` says), and none of its checks of who is asking: the real rules are meet's, proved in packages/meet's
// tests over the real Workspace core. What it does keep is what the space's tests must see: the compose key (a key meet holds answers `Repeated` and does nothing), a refused first use
// that releases the key, and that the invitation email is sent by `inviteGuest` and by nothing else (`emailed` is the list of addresses it "sent" to).

import {
  type SignedIn,
  type MeetBrowsable,
  type MeetChanged,
  type MeetChannel,
  type MeetChannelChange,
  type MeetChannelDetail,
  type MeetChannelMake,
  type MeetGuestInvite,
  type MeetInvited,
  type MeetMember,
  type MeetPerson,
  type SpaceReply,
  type WriteReply,
  answered,
  failed,
  refused,
  repeated,
} from '@space/workspace'

/** Someone the person can see, besides themself: a teammate, or a guest of some channel. */
export interface StandInPerson extends MeetPerson {
  /** A guest who has not signed in yet. */
  invited?: boolean
  /** The person asking invited this guest. */
  invitedByMe?: boolean
  /** A direct message with something in it exists. */
  direct?: boolean
}

export interface StandInRoom {
  conversationId: number
  createdByMe: boolean
  /** The ids of the people in it, besides the person asking. */
  members: string[]
}

/** What the next write of channel admin does instead: refused for rate (`limit`), failed (`broken`), the binding failing (`throw`) or never answering (`hang`). */
export type ChannelStep = 'limit' | 'broken' | 'throw' | 'hang'

export interface StandInChannels {
  channel(asker: SignedIn, conversationId: number): Promise<SpaceReply<MeetChannelDetail>>
  browseChannels(asker: SignedIn): Promise<SpaceReply<MeetBrowsable[]>>
  createChannel(asker: SignedIn, make: MeetChannelMake): Promise<WriteReply<MeetChannelDetail>>
  inviteGuest(asker: SignedIn, invite: MeetGuestInvite): Promise<WriteReply<MeetInvited>>
  changeChannel(asker: SignedIn, change: MeetChannelChange): Promise<SpaceReply<MeetChanged>>
  /** What the space asked, in order. */
  made: { channels: MeetChannelMake[]; invites: MeetGuestInvite[]; changes: MeetChannelChange[]; channelReads: number[]; browses: number }
  /** The addresses an invitation was "sent" to: by `inviteGuest` and nothing else. */
  emailed: string[]
  /** Make the next invitation's email fail (the guest is in the channel; `mailed` is false), once. */
  mailFails: { next: boolean }
  /** Make the next invitation or channel be DONE (the key held, the email sent) and then lose the answer, as a binding that fails after meet committed does: the space reads it as outcome unknown, once. */
  loseAnswer: { next: boolean }
  steps: ChannelStep[]
  /** The people the stand-in knows, and the channels with their people: a test may read what a press did. */
  people: StandInPerson[]
  rooms: Map<number, StandInRoom>
  open: MeetBrowsable[]
}

export interface StandInChannelOptions {
  /** Whether the person asking is the owner (Tessa is). Default true. */
  owner?: boolean
  me: MeetPerson
  people?: StandInPerson[]
  /** The people in the channels of the overview, by conversation id; a channel with none is the person alone. */
  rooms?: Record<number, { createdByMe?: boolean; members: string[] }>
  /** Open channels the person has not joined. */
  open?: Array<{ conversationId: number; name: string; memberCount: number }>
  now(): number
}

export function standInChannels(channels: MeetChannel[], askers: string[], options: StandInChannelOptions): StandInChannels {
  const { me } = options
  const owner = options.owner ?? true
  const people = [...(options.people ?? [])]
  const rooms = new Map<number, StandInRoom>()
  for (const c of channels) {
    const seed = options.rooms?.[c.conversationId]
    rooms.set(c.conversationId, { conversationId: c.conversationId, createdByMe: seed?.createdByMe ?? false, members: [...(seed?.members ?? [])] })
  }
  const open: MeetBrowsable[] = (options.open ?? []).map((o) => ({ ...o }))
  const made: StandInChannels['made'] = { channels: [], invites: [], changes: [], channelReads: [], browses: 0 }
  const emailed: string[] = []
  const mailFails = { next: false }
  const loseAnswer = { next: false }
  const lost = () => {
    if (!loseAnswer.next) return
    loseAnswer.next = false
    throw new Error('stand-in meet lost the connection after it committed')
  }
  const steps: ChannelStep[] = []
  const createKeys = new Map<string, MeetChannelDetail>()
  const inviteKeys = new Map<string, MeetInvited>()
  let nextConversation = 500
  let nextPerson = 1

  const personOf = (id: string): StandInPerson | undefined => people.find((p) => p.id === id)
  const channelOf = (id: number) => channels.find((c) => c.conversationId === id)
  const nameTaken = (name: string, except = 0) => channels.some((c) => c.conversationId !== except && c.name.toLowerCase() === name.toLowerCase()) || open.some((o) => o.conversationId !== except && o.name.toLowerCase() === name.toLowerCase())

  const detail = (id: number): MeetChannelDetail | null => {
    const c = channelOf(id)
    const room = rooms.get(id)
    if (!c || !room) return null
    const memberOf = (p: StandInPerson): MeetMember => ({
      person: { id: p.id, name: p.name, kind: p.kind, address: p.address },
      invited: p.invited === true,
      you: false,
      direct: p.direct === true,
      may: { takeOut: p.kind === 'guest', removeFromWorkspace: p.kind === 'guest' && (owner || p.invitedByMe === true), deleteEverything: owner },
    })
    const here = room.members.map(personOf).filter((p): p is StandInPerson => p !== undefined)
    return {
      conversationId: id,
      name: c.name,
      privacy: c.privacy,
      createdByMe: room.createdByMe,
      members: [{ person: me, invited: false, you: true, direct: false, may: { takeOut: false, removeFromWorkspace: false, deleteEverything: false } }, ...here.map(memberOf)],
      addable: people.filter((p) => !room.members.includes(p.id)).map((p) => ({ id: p.id, name: p.name, kind: p.kind, address: p.address })),
      may: { rename: true, leave: true, archive: room.createdByMe || owner, add: true, invite: true },
    }
  }
  const syncCount = (id: number) => {
    const c = channelOf(id)
    const room = rooms.get(id)
    if (c && room) c.memberCount = room.members.length + 1
  }
  /** The step a scripted write takes, or null to do it. */
  const stepped = async (): Promise<SpaceReply<never> | null> => {
    const step = steps.shift()
    if (step === 'limit') return refused('limit', 'meet has sent as many emails as it may this hour. Try again later.')
    if (step === 'broken') return failed('Chat could not do that.')
    if (step === 'throw') throw new Error('stand-in meet lost the connection')
    if (step === 'hang') return new Promise(() => undefined)
    return null
  }
  const notFound = () => refused('not-found', 'There is no such channel.')

  return {
    made,
    emailed,
    mailFails,
    loseAnswer,
    steps,
    people,
    rooms,
    open,
    async channel(asker, conversationId) {
      askers.push(asker.person.address)
      made.channelReads.push(conversationId)
      const d = detail(conversationId)
      return d ? answered(d) : notFound()
    },
    async browseChannels(asker) {
      askers.push(asker.person.address)
      made.browses += 1
      return answered(open.map((o) => ({ ...o })))
    },
    async createChannel(asker, make) {
      askers.push(asker.person.address)
      made.channels.push(make)
      const held = createKeys.get(make.key)
      if (held) return repeated<MeetChannelDetail>({ state: 'done', reply: answered(held) })
      const scripted = await stepped()
      if (scripted) return scripted
      const name = make.name.replace(/^#+\s*/, '').trim()
      if (name === '') return refused('bad-request', 'Give the channel a name.')
      if (make.privacy !== 'open' && make.privacy !== 'private') return refused('bad-request', 'A channel is open or private.')
      if (nameTaken(name)) return refused('conflict', 'There is already a channel with that name.')
      const id = nextConversation++
      channels.push({ conversationId: id, name, privacy: make.privacy, memberCount: 1, createdAt: options.now(), newest: null, unread: 0 })
      rooms.set(id, { conversationId: id, createdByMe: true, members: [] })
      const d = detail(id) as MeetChannelDetail
      createKeys.set(make.key, d)
      lost()
      return answered(d)
    },
    async inviteGuest(asker, invite) {
      askers.push(asker.person.address)
      made.invites.push(invite)
      const held = inviteKeys.get(invite.key)
      if (held) return repeated<MeetInvited>({ state: 'done', reply: answered(held) })
      const scripted = await stepped()
      if (scripted) return scripted
      const room = rooms.get(invite.conversationId)
      if (!room || !channelOf(invite.conversationId)) return notFound()
      if (invite.name.trim() === '') return refused('bad-request', 'Give the guest a name.')
      if (/@northfield\.example$/i.test(invite.address)) return refused('conflict', 'That address belongs to a Northfield Works person. Add them to the channel instead.')
      let guest = people.find((p) => p.address === invite.address)
      if (!guest) {
        guest = { id: `p-guest-${nextPerson++}`, name: invite.name.trim(), kind: 'guest', address: invite.address, invited: true, invitedByMe: true }
        people.push(guest)
      }
      if (!room.members.includes(guest.id)) room.members.push(guest.id)
      syncCount(invite.conversationId)
      // The one email: sent here, for this press, and nowhere else.
      const mailed = !mailFails.next
      mailFails.next = false
      if (mailed) emailed.push(invite.address)
      const done: MeetInvited = { conversationId: invite.conversationId, person: { id: guest.id, name: guest.name, kind: 'guest', address: guest.address }, mailed }
      inviteKeys.set(invite.key, done)
      lost()
      return answered(done)
    },
    async changeChannel(asker, change) {
      askers.push(asker.person.address)
      made.changes.push(change)
      const scripted = await stepped()
      if (scripted) return scripted
      const id = change.conversationId
      if (change.do === 'join') {
        const o = open.find((x) => x.conversationId === id)
        if (!o) return notFound()
        open.splice(open.indexOf(o), 1)
        channels.push({ conversationId: id, name: o.name, privacy: 'open', memberCount: o.memberCount + 1, createdAt: options.now(), newest: null, unread: 0 })
        rooms.set(id, { conversationId: id, createdByMe: false, members: [] })
        return answered({ conversationId: id, channel: detail(id) })
      }
      const c = channelOf(id)
      const room = rooms.get(id)
      if (!c || !room) return notFound()
      switch (change.do) {
        case 'leave':
        case 'archive': {
          if (change.do === 'archive' && !(room.createdByMe || owner)) return refused('not-admitted', 'Only the person who made a channel, or Tessa, can archive it.')
          channels.splice(channels.indexOf(c), 1)
          rooms.delete(id)
          if (change.do === 'leave' && c.privacy === 'open') open.push({ conversationId: id, name: c.name, memberCount: c.memberCount - 1 })
          return answered({ conversationId: id, channel: null })
        }
        case 'rename': {
          const name = change.name.replace(/^#+\s*/, '').trim()
          if (name === '') return refused('bad-request', 'Give the channel a name.')
          if (nameTaken(name, id)) return refused('conflict', 'There is already a channel with that name.')
          c.name = name
          return answered({ conversationId: id, channel: detail(id) })
        }
        case 'add': {
          const who = personOf(change.personId)
          if (!who) return refused('not-found', 'There is no such person.')
          if (!room.members.includes(who.id)) room.members.push(who.id)
          syncCount(id)
          return answered({ conversationId: id, channel: detail(id) })
        }
        case 'take-out':
        case 'remove-guest':
        case 'delete-person': {
          const who = personOf(change.personId)
          if (!who || !room.members.includes(who.id)) return refused('not-found', 'That person is not in this channel.')
          if (change.do === 'take-out' && who.kind !== 'guest') return refused('not-admitted', 'A teammate leaves a channel on their own.')
          if (change.do === 'remove-guest' && !(owner || who.invitedByMe)) return refused('not-admitted', 'You can remove only a guest you invited.')
          if (change.do === 'delete-person' && !owner) return refused('not-admitted', 'Only Tessa can delete a person.')
          room.members.splice(room.members.indexOf(who.id), 1)
          // Removed or deleted: out of every channel; a guest taken out of their last channel is out of the workspace.
          if (change.do !== 'take-out') for (const r of rooms.values()) r.members = r.members.filter((m) => m !== who.id)
          if (change.do !== 'take-out' || ![...rooms.values()].some((r) => r.members.includes(who.id))) people.splice(people.indexOf(who), 1)
          for (const r of rooms.keys()) syncCount(r)
          return answered({ conversationId: id, channel: detail(id) })
        }
      }
    },
  }
}
