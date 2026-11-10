// The booking form beside the reply box, in a stand-in DOM: Enter in its boxes books the meeting and sends NOTHING. The form was once drawn inside the reply box's form, where Enter submitted
// the reply (the email, or the chat post, with its files) through Send. Also: who a meeting invites is who the email goes to.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { T0, northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { invitableOf } from '../src/client/callActions'
import type { CallActions, ScheduleForm } from '../src/client/callActions'
import { newCompose, typed } from '../src/client/compose'
import { replyLine, replyWays } from '../src/client/convo'
import { ConversationView, type ViewProps } from '../src/client/Conversation'
import { type Opened, openConversation } from '../src/conversation'
import { standInInbox, standInMeet } from '../src/stand-ins'
import { ago, contact, thread } from './world'
import { OWNER_SIGNED_IN } from './signed-in'

const ME = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield())
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function open(key: string): Promise<Extract<Opened, { ok: true }>['value']> {
  const inbox = standInInbox(
    [contact('c-corin', 'Corin Pike', 'corin@client.test'), contact('c-dana', 'Dana Reyes', 'dana@client.test')],
    [thread('t-shared', ago(50), ['c-corin', 'c-dana'], { subject: 'Kickoff', direction: 'in' }), thread('t-solo', ago(500), ['c-dana'], { subject: 'Invoice', direction: 'in' })],
  )
  const meet = standInMeet({ direct: [], channels: [] }, {})
  const opened = await openConversation({ apps: { inbox, meet }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }, key)
  if (!opened.ok) throw new Error(opened.message)
  return opened.value
}

describe('who a meeting invites is who the email goes to', () => {
  test('a reply to everyone on a shared thread invites everyone on it, and the reply line says the same people', async () => {
    const answer = await open('corin@client.test')
    const line = replyLine(answer.row.name, replyWays(answer).email[0]!)
    expect(line).toEqual({ all: true, text: 'Reply all to Corin Pike and Dana Reyes' })
    expect(invitableOf(answer, null).map((i) => i.name)).toEqual(['Corin Pike', 'Dana Reyes'])
    expect(invitableOf(answer, null).map((i) => i.address)).toEqual(['corin@client.test', 'dana@client.test'])
  })

  test('a thread with only the person is that person alone, and a person with no thread the others are on invites no one else', async () => {
    const answer = await open('dana@client.test')
    // Dana's newest open thread is the shared one: she is invited with Corin, as the reply goes to both.
    expect(invitableOf(answer, null).map((i) => i.name)).toEqual(['Dana Reyes', 'Corin Pike'])
    expect(invitableOf(answer, 't-solo').map((i) => i.name)).toEqual(['Dana Reyes'])
  })
})

describe('Enter in the booking form', () => {
  test('books, and neither sends the email nor posts the chat being written', async () => {
    const answer = await open('corin@client.test')
    const sent: string[] = []
    const booked: ScheduleForm[] = []
    const calls: CallActions = {
      busy: false,
      notice: null,
      canHuddle: false,
      canLink: true,
      canSchedule: true,
      scheduleOpen: true,
      invitable: invitableOf(answer, null),
      startHuddle: () => undefined,
      addLink: () => undefined,
      openSchedule: () => undefined,
      closeSchedule: () => undefined,
      schedule: (f) => booked.push(f),
    }
    const props: ViewProps = {
      me: ME,
      now: T0,
      answer,
      sources: answer.sources,
      loadingEarlier: false,
      onEarlier: () => undefined,
      way: 'email',
      onWay: () => undefined,
      threadId: null,
      onThread: () => undefined,
      compose: typed(newCompose(), 'Thanks Corin, here is the plan.'),
      onText: () => undefined,
      onSend: () => sent.push('send'),
      onSendAndClose: () => sent.push('send and close'),
      onClose: () => undefined,
      onReopen: () => undefined,
      reopen: null,
      changing: false,
      changed: null,
      onDismiss: () => undefined,
      drafts: {},
      onSendDraft: () => sent.push('draft'),
      onDismissDraft: () => undefined,
      onDraftChanged: () => undefined,
      profileOpen: false,
      onProfile: () => undefined,
      onBack: () => undefined,
      timeZone: 'UTC',
      calls,
    }
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    document.body.innerHTML = '<div id="root"></div>'
    const root = createRoot(document.getElementById('root') as HTMLElement)
    await act(async () => {
      root.render(createElement(ConversationView, props))
      await sleep(10)
    })

    const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement
    const title = q('schedule-title') as HTMLInputElement
    const when = q('schedule-when') as HTMLInputElement
    // Neither box is inside the reply box's form: the form an Enter submits is the booking's own.
    expect(q('schedule').closest('[data-testid="composer"]')).toBeNull()
    expect(title.form as unknown).toBe(q('schedule'))
    expect(when.form as unknown).toBe(q('schedule'))
    expect(title.form as unknown).not.toBe(q('composer'))

    // What Enter in a box does in a browser: it submits the form the box is in.
    for (const box of [title, when]) {
      await act(async () => {
        box.form?.requestSubmit()
        await sleep(5)
      })
    }
    expect(sent).toEqual([])
    expect(booked).toHaveLength(2)
    expect(booked[0]).toMatchObject({ title: 'Call with Corin' })
    expect(booked[0]?.when).toMatch(/^\d{4}-\d{2}-\d{2}T10:00$/)

    // The reply box's own Send still sends, once.
    await act(async () => {
      ;(q('send') as HTMLButtonElement).click()
      await sleep(5)
    })
    expect(sent).toEqual(['send'])
    await act(async () => root.unmount())
  })
})
