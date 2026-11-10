// What the workspace page holds, and how a list of changes turns into it. Pure, with no page and no socket, so each
// rule is checked with literal input (test/workspace-client.test.ts).
//
// The page asks the server once for everything (a Bootstrap) and then hears changes, each with a rising number. A
// change is applied once: anything at or below the number already applied is ignored, so a change that arrives
// twice (a catch-up and a push, or one the bootstrap already reflects) does nothing the second time. The server
// sends the changes of a conversation only to people in it, so there is no filtering here.

import type { Bootstrap, BrowseChannel, Change, ConversationView, MeView, PersonView, WMessage } from '../../workspace-model'

export interface WState {
  me: MeView | null
  people: Record<string, PersonView>
  convs: Record<number, ConversationView>
  browse: BrowseChannel[]
  /**
   * The messages the page holds for a conversation, oldest first. Changes that arrive for a conversation not yet
   * opened are held here too, so one that lands while its history is on the way is not lost; `loaded` says the
   * history itself has arrived.
   */
  messages: Record<number, WMessage[]>
  loaded: Record<number, boolean>
  /** Whether older history exists on the server for a loaded conversation. */
  more: Record<number, boolean>
  /** The newest change applied: what the socket's `hello` asks to catch up from. */
  seq: number
  /** Something happened that this state cannot work out alone (a conversation made, someone added): ask for a Bootstrap again. */
  refresh: boolean
}

export const empty = (): WState => ({ me: null, people: {}, convs: {}, browse: [], messages: {}, loaded: {}, more: {}, seq: 0, refresh: false })

/**
 * The state a Bootstrap describes. With `prev`, the messages already loaded stay for the conversations still there,
 * and `seq` stays where it was: changes after it are still on their way over the socket, and applying them to this
 * newer picture is safe (see `applyChanges`). Without it, or with `reset`, the page starts from the Bootstrap's.
 */
export function fromBootstrap(b: Bootstrap, prev?: WState, reset = false): WState {
  const keep = prev && !reset
  const convs: Record<number, ConversationView> = {}
  for (const c of b.conversations) convs[c.id] = c
  const messages: Record<number, WMessage[]> = {}
  const loaded: Record<number, boolean> = {}
  const more: Record<number, boolean> = {}
  if (keep) {
    for (const id of Object.keys(convs).map(Number)) {
      if (prev.messages[id]) messages[id] = prev.messages[id] as WMessage[]
      if (prev.loaded[id]) loaded[id] = true
      if (id in prev.more) more[id] = prev.more[id] as boolean
    }
  }
  return {
    // A privacy note answered here stays answered: a Bootstrap already on its way when it was acknowledged says otherwise.
    me: prev?.me?.privacyAcked && !b.me.privacyAcked ? { ...b.me, privacyAcked: true } : b.me,
    people: Object.fromEntries(b.people.map((p) => [p.id, p])),
    convs,
    browse: b.browse,
    messages,
    loaded,
    more,
    seq: keep ? prev.seq : b.seq,
    refresh: false,
  }
}

/** The held messages plus the new ones, each id once, oldest first. The same array comes back when nothing is new. */
export function mergeById(held: WMessage[], incoming: WMessage[]): WMessage[] {
  const known = new Set(held.map((m) => m.id))
  const fresh = incoming.filter((m) => !known.has(m.id))
  if (fresh.length === 0) return held
  return [...held, ...fresh].sort((a, b) => a.id - b.id)
}

/**
 * Apply changes in order. A change at or below `seq` is skipped. The rules for what a change does to a count are
 * written so that applying one the Bootstrap already reflects is harmless: a message adds to the unread count only
 * when it is newer than the newest the conversation is known to hold.
 */
export function applyChanges(state: WState, changes: Change[]): WState {
  let s = state
  for (const c of [...changes].sort((x, y) => x.seq - y.seq)) {
    if (c.seq <= s.seq) continue
    s = { ...s, seq: c.seq }
    switch (c.kind) {
      case 'message': {
        const { conv, message } = c.data
        const known = s.convs[conv]
        if (!known) {
          s = { ...s, refresh: true }
          break
        }
        const newest = known.last?.id ?? 0
        const mine = message.person === s.me?.id
        const counts = message.id > newest && !mine && message.id > known.lastRead
        s = {
          ...s,
          convs: {
            ...s.convs,
            [conv]: { ...known, unread: known.unread + (counts ? 1 : 0), last: message.id > newest ? { id: message.id, at: message.at } : known.last },
          },
          messages: { ...s.messages, [conv]: mergeById(s.messages[conv] ?? [], [message]) },
        }
        break
      }
      case 'edit': {
        const { conv, id, text, editedAt } = c.data
        const held = s.messages[conv]
        if (held) s = { ...s, messages: { ...s.messages, [conv]: held.map((m) => (m.id === id ? { ...m, text, editedAt } : m)) } }
        break
      }
      case 'delete': {
        const { conv, id, author } = c.data
        const held = s.messages[conv]
        const known = s.convs[conv]
        if (held) s = { ...s, messages: { ...s.messages, [conv]: held.filter((m) => m.id !== id) } }
        // A message that was unread, from someone else, leaves a count this state cannot correct alone.
        if (known && author !== s.me?.id && id > known.lastRead) s = { ...s, refresh: true }
        break
      }
      case 'read': {
        const { conv, upTo, unread } = c.data
        const known = s.convs[conv]
        if (known) s = { ...s, convs: { ...s.convs, [conv]: { ...known, lastRead: Math.max(known.lastRead, upTo), unread } } }
        break
      }
      case 'structure':
        s = { ...s, refresh: true }
        break
    }
  }
  return s
}

/** A conversation's loaded history, from the server's page. Older pages go in front. */
export function withHistory(state: WState, conv: number, page: { messages: WMessage[]; more: boolean }): WState {
  const held = state.messages[conv] ?? []
  return {
    ...state,
    messages: { ...state.messages, [conv]: mergeById(held, page.messages) },
    loaded: { ...state.loaded, [conv]: true },
    more: { ...state.more, [conv]: page.more },
  }
}

/** A message this person just sent, which the reply to the send carries before the change does. */
export function withOwnMessage(state: WState, message: WMessage): WState {
  const known = state.convs[message.conv]
  return {
    ...state,
    messages: { ...state.messages, [message.conv]: mergeById(state.messages[message.conv] ?? [], [message]) },
    convs: known && message.id > (known.last?.id ?? 0) ? { ...state.convs, [message.conv]: { ...known, last: { id: message.id, at: message.at } } } : state.convs,
  }
}

/** A read mark this device sent: the count clears here without waiting for the change to come back. */
export function withRead(state: WState, conv: number, upTo: number): WState {
  const known = state.convs[conv]
  if (!known || upTo <= known.lastRead) return state
  const held = state.loaded[conv] ? state.messages[conv] : undefined
  // With the messages loaded the count is exact; without them the server's answer (a `read` change) corrects it.
  const unread = held ? held.filter((m) => m.id > upTo && m.person !== state.me?.id).length : upTo >= (known.last?.id ?? 0) ? 0 : known.unread
  return { ...state, convs: { ...state.convs, [conv]: { ...known, lastRead: upTo, unread } } }
}

export const totalUnread = (s: WState): number => Object.values(s.convs).reduce((n, c) => n + c.unread, 0)

/** What the browser tab's title says: the unread count in front of the name, when there is one. */
export const tabTitle = (s: WState): string => {
  const n = totalUnread(s)
  return n > 0 ? `(${n > 99 ? '99+' : n}) meet` : 'meet'
}

/** What a person is called beside their name, wherever one is shown: the company's name, Guest, or Invited (a guest who has not signed in yet). `company` is the install's, empty before the page knows it. */
export const personTag = (p: PersonView, company: string): string => (p.kind === 'teammate' ? company || 'Team' : p.invited ? 'Invited' : 'Guest')

export function otherPerson(s: WState, c: ConversationView): PersonView | undefined {
  const id = c.members.find((m) => m !== s.me?.id)
  return id ? s.people[id] : undefined
}

/** A conversation's name as the sidebar shows it: a channel's own, or the other person's for a direct message. */
export const conversationName = (s: WState, c: ConversationView): string =>
  c.kind === 'channel' ? (c.name ?? 'channel') : c.kind === 'phone' ? 'Phone' : (otherPerson(s, c)?.name ?? 'Deleted person')

/** The sidebar: channels and direct messages, each newest-active first, then by name; and the Phone conversation, which is kept apart from both. */
export function sidebar(s: WState): { channels: ConversationView[]; dms: ConversationView[]; phone: ConversationView[] } {
  const all = Object.values(s.convs)
  const byActivity = (a: ConversationView, b: ConversationView) =>
    (b.last?.at ?? 0) - (a.last?.at ?? 0) || conversationName(s, a).localeCompare(conversationName(s, b))
  const byName = (a: ConversationView, b: ConversationView) => conversationName(s, a).localeCompare(conversationName(s, b))
  return { channels: all.filter((c) => c.kind === 'channel').sort(byName), dms: all.filter((c) => c.kind === 'dm').sort(byActivity), phone: all.filter((c) => c.kind === 'phone') }
}

/**
 * Where the "New" line goes: the first message from someone else that was already unread when the conversation was
 * opened (after `readAtOpen`, up to the newest it held then, `lastAtOpen`), or null when none was. A message that
 * arrives while you are reading is not "new" to you, so the line does not move to it.
 */
export function firstNewId(messages: WMessage[], me: string | undefined, readAtOpen: number, lastAtOpen: number): number | null {
  return messages.find((m) => m.id > readAtOpen && m.id <= lastAtOpen && m.person !== me)?.id ?? null
}

/** The newest message id in a loaded conversation, for the read mark. */
export const newestId = (messages: WMessage[] | undefined): number => messages?.at(-1)?.id ?? 0
