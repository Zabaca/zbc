// The things a person does with calls inside a conversation: start a huddle, add a call link to the email being written, book a meeting. Each is one press with
// ONE compose key made for that press (compose.ts `mintKey`), sent to the Worker (`/api/meet/<name>`), never retried, and said in words afterwards.
//
// A huddle announces itself in the conversation (meet posts a message that names the call), so after it the conversation is read again and the card is there. A call
// link and a meeting's invitation are TEXT put into the reply box of the email being written: they go out only when the person presses Send, in the inbox's own send.
import type { MeetCall, MeetInvitee } from '@space/workspace'
import { useCallback, useRef, useState } from 'react'
import type { ConversationAnswer } from '../conversation'
import { type Notice, type Way, mintKey } from './compose'
import { replyWays } from './convo'
import { callLinkText, invitationText, parseLocal } from './invite'
import { useSwitches } from './switches'
import { postView } from './views'

/** Who a meeting can invite from this conversation: the person (or people) the email is to, by name and address. */
export interface Invitable {
  key: string
  name: string
  address: string | null
}

/** The form's fields, as the person left them. Who is invited is not one of them: it is who the email goes to (`invitableOf`), so the record and the email cannot disagree. */
export interface ScheduleForm {
  title: string
  /** What a `datetime-local` box holds, read on the company's clock when it is booked. */
  when: string
}

/**
 * Who an email meeting invites, and who the email goes to: the person the conversation is with and, where the reply goes to everyone on a shared thread (the reply line),
 * the others on that thread. The same thread the reply box picks (`replyWays`), so the people named here are exactly the reply's recipients. Teammates and channels are invited by meet.
 */
export function invitableOf(answer: ConversationAnswer, threadId: string | null): Invitable[] {
  const { row } = answer
  if (row.type !== 'person') return []
  const out: Invitable[] = []
  const seen = new Set<string>()
  const add = (name: string, address: string | null) => {
    const key = (address ?? name).toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ key, name, address })
  }
  add(row.name, row.addresses[0] ?? null)
  const ways = replyWays(answer).email
  const thread = ways.find((t) => t.conversationId === threadId) ?? ways[0]
  for (const p of thread?.alsoOn ?? []) add(p.name, p.address)
  return out
}

/** Where a meeting is made: in the direct message or channel when the reply goes by chat, from the email conversation when it goes by email. */
export type Home = { via: 'chat'; conversationId: number } | { via: 'email'; home: string }

export function homeOf(answer: ConversationAnswer, way: Way): Home | null {
  const { row } = answer
  if (row.type === 'channel') return { via: 'chat', conversationId: row.conversationId }
  if (way === 'chat') return row.chat ? { via: 'chat', conversationId: row.chat.conversationId } : null
  return { via: 'email', home: row.key }
}

export interface CallActions {
  /** One of them is waiting on meet. */
  busy: boolean
  /** How the last press ended, under the reply box. */
  notice: Notice | null
  /** The huddle button is there where the reply can go by chat. */
  canHuddle: boolean
  /** The call link button is there where the reply goes by email. */
  canLink: boolean
  canSchedule: boolean
  scheduleOpen: boolean
  invitable: Invitable[]
  startHuddle(): void
  addLink(): void
  openSchedule(): void
  closeSchedule(): void
  schedule(form: ScheduleForm): void
}

interface Inputs {
  /** Null while the conversation is not open yet: the actions are then none. */
  answer: ConversationAnswer | null
  way: Way
  threadId: string | null
  zone: string
  /** Put text in the reply box, under what is written there. */
  insert(text: string): void
  /** A call was made: read the conversation again. */
  made(): void
  now(): number
}

const failure = (text: string): Notice => ({ tone: 'error', text })

export function useCallActions({ answer, way, threadId, zone, insert, made, now }: Inputs): CallActions {
  // Calls are a switch: an install without them has no huddle, no call link and no meeting to offer.
  const { calls } = useSwitches()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const pressing = useRef(false)
  const row = answer?.row
  const chatId = !row ? null : row.type === 'channel' ? row.conversationId : (row.chat?.conversationId ?? null)
  const home = answer ? homeOf(answer, way) : null
  const invitable = answer ? invitableOf(answer, threadId) : []

  const run = useCallback(async <T>(name: string, body: Record<string, unknown>, done: (value: T) => void) => {
    if (pressing.current) return
    pressing.current = true
    setBusy(true)
    setNotice(null)
    const got = await postView<T>(name, { key: mintKey(), ...body })
    pressing.current = false
    setBusy(false)
    if (got.ok) done(got.value)
    else setNotice(failure(got.say.text))
  }, [])

  return {
    busy,
    notice,
    canHuddle: calls && chatId !== null && (way === 'chat' || row?.type === 'channel'),
    canLink: calls && row?.type === 'person' && way === 'email',
    canSchedule: calls && home !== null,
    scheduleOpen,
    invitable,
    startHuddle() {
      if (chatId === null) return
      void run<MeetCall>('meet/huddle', { conversationId: chatId }, () => {
        setNotice({ tone: 'ok', text: 'Huddle started. Its card is above, with the link.' })
        made()
      })
    },
    addLink() {
      const home = row?.key
      if (home === undefined) return
      void run<MeetCall>('meet/call', { home }, (call) => {
        insert(callLinkText(call.link))
        setNotice({ tone: 'ok', text: 'The call link is in your email below. Nothing is sent until you press Send.' })
        made()
      })
    },
    openSchedule: () => setScheduleOpen(true),
    closeSchedule: () => setScheduleOpen(false),
    schedule(form) {
      if (home === null) return
      const startsAt = parseLocal(form.when, zone)
      const title = form.title.trim()
      if (startsAt === null) return setNotice(failure('Pick a day and a time for the meeting.'))
      if (title === '') return setNotice(failure('Give the meeting a title.'))
      if (startsAt < now() - 5 * 60_000) return setNotice(failure('That time has already passed.'))
      const invitees: MeetInvitee[] = invitable.map((p) => ({ name: p.name, address: p.address }))
      const where = home.via === 'chat' ? { conversationId: home.conversationId } : { home: home.home, invitees }
      void run<MeetCall>('meet/meeting', { title, startsAt, ...where }, (call) => {
        setScheduleOpen(false)
        if (home.via === 'email') {
          insert(invitationText({ title, startsAt, zone, link: call.link, to: invitees[0]?.name ?? null }))
          setNotice({ tone: 'ok', text: 'The meeting is booked and the invitation is in your email below. Nothing is sent until you press Send.' })
        } else setNotice({ tone: 'ok', text: 'The meeting is booked. Its card is above, with the link, and everyone in this conversation is invited.' })
        made()
      })
    },
  }
}
