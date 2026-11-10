// Channel admin as a browser runs it, in a stand-in DOM, over the real Worker (src/app.ts) and a stand-in meet: what a press does, and what it does NOT do until it is asked. New channel
// makes one channel for one press; Archive, Remove from workspace and Delete everything ask first, in meet's words; a button is drawn only where meet says the person may; and the
// invitation to a guest goes by Invite and by nothing else (typing in the boxes sends nothing). The DOM is registered for this file only.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { northfield } from '../../workspace/test/helpers'
import { browse, changeChannel, channelOf, createChannel, inviteGuest, parseChange, parseChannelQuery, parseCreate, parseInvite } from '../src/channels'
import { standInInbox, standInMeet } from '../src/stand-ins'
import { ago, channel, contact, dm, person } from './world'
import { OWNER_SIGNED_IN } from './signed-in'
import { inNorthfield } from './northfield-shell'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const realFetch = globalThis.fetch
const ORIGIN = 'https://space.northfield.example'

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  globalThis.fetch = realFetch
})

const priya = person('p-priya', 'Priya Natarajan', 'priya@northfield.example', 'teammate')

/** The real Worker with a stand-in meet behind it; the page's `fetch` is routed to it, signed in as Tessa. */
async function setup(o: { owner?: boolean } = {}) {
  const meet = standInMeet(
    { direct: [dm(11, priya, ago(30))], channels: [{ ...channel(21, 'launch', ago(60)), memberCount: 4 }, { ...channel(22, 'ops', ago(90)), privacy: 'private' as const, memberCount: 2 }] },
    {
      channels: {
        owner: o.owner ?? true,
        people: [
          { ...priya, direct: true },
          { id: 'p-dana', name: 'Dana Reyes', kind: 'guest', address: 'dana@harbor.example', invitedByMe: true, direct: true },
          { id: 'p-marcus', name: 'Marcus Chen', kind: 'guest', address: 'marcus@harbor.example', invited: true },
          { id: 'p-rosa', name: 'Rosa Whitfield', kind: 'guest', address: 'rosa@yahoo.example' },
          { id: 'p-ben', name: 'Ben Walker', kind: 'teammate', address: 'ben@northfield.example' },
        ],
        rooms: { 21: { createdByMe: false, members: ['p-priya', 'p-dana', 'p-marcus', 'p-rosa'] }, 22: { createdByMe: true, members: ['p-priya'] } },
        open: [{ conversationId: 31, name: 'design', memberCount: 3 }],
      },
    },
  )
  const inbox = standInInbox([contact('c-dana', 'Dana Reyes', 'dana@harbor.example')], [])
  const ask = { apps: { inbox, meet }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 200, writeWithinMs: 500 }
  // The page's `fetch`, answered by the Worker's own channel functions (src/channels.ts) over the stand-in meet. (The router, the sign-in and the POST guard are test/channels.test.ts's: a
  // DOM's Request drops the Origin header a browser sets for itself, so a request through the router cannot be made from here.)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), ORIGIN)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const name = url.pathname.replace('/api/meet/', '')
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      if (name === 'channel-create') {
        const parsed = parseCreate(body)
        return parsed.ok ? json(await createChannel(ask, parsed.value)) : json({ error: parsed.message }, 400)
      }
      if (name === 'channel-invite') {
        const parsed = parseInvite(body)
        return parsed.ok ? json(await inviteGuest(ask, parsed.value)) : json({ error: parsed.message }, 400)
      }
      const parsed = parseChange(body)
      return parsed.ok ? json(await changeChannel(ask, parsed.value)) : json({ error: parsed.message }, 400)
    }
    if (name === 'browse') return json(await browse(ask))
    const q = parseChannelQuery(url.searchParams)
    return q.ok ? json(await channelOf(ask, q.value)) : json({ error: q.message }, 400)
  }) as typeof fetch
  return { meet }
}

async function mount(node: (h: typeof import('react').createElement) => React.ReactElement) {
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  document.body.innerHTML = '<div id="root"></div>'
  const root = createRoot(document.getElementById('root') as HTMLElement)
  await act(async () => {
    root.render(inNorthfield(node(createElement)))
    await sleep(120)
  })
  const q = <T extends Element = HTMLElement>(testid: string) => document.querySelector(`[data-testid="${testid}"]`) as T | null
  const all = (testid: string) => [...document.querySelectorAll(`[data-testid="${testid}"]`)] as HTMLElement[]
  const click = async (el: Element | null) => {
    if (!el) throw new Error('nothing to click')
    await act(async () => {
      ;(el as HTMLElement).click()
      await sleep(120)
    })
  }
  const type = async (el: Element | null, value: string) => {
    if (!el) throw new Error('nothing to type in')
    await act(async () => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
      await sleep(10)
    })
  }
  const submit = async (el: Element | null) => {
    await act(async () => {
      el?.closest('form')?.requestSubmit()
      await sleep(150)
    })
  }
  return { q, all, click, type, submit, text: () => document.body.textContent ?? '', unmount: () => act(async () => root.unmount()), createElement }
}

describe('New channel and Browse channels', () => {
  test('a channel is made for one press, private by default, and the page goes to it', async () => {
    const s = await setup()
    const { ChannelTools } = await import('../src/client/Channels')
    const went: string[] = []
    let changed = 0
    const m = await mount((h) => h(ChannelTools, { go: (p: string) => went.push(p), onChanged: () => changed++ }))
    expect(m.q('new-channel')).toBeNull()
    await m.click(m.q('new-channel-button'))
    expect((m.q('privacy-private') as HTMLInputElement).checked).toBe(true)
    expect(m.text()).toContain('Only the people you add. A good fit for one client.')
    expect(m.text()).toContain('Every Northfield Works person can see it and join.')
    expect((m.q('channel-make') as HTMLButtonElement).disabled).toBe(true)
    await m.type(m.q('channel-name'), 'acme')
    await m.submit(m.q('channel-name'))
    expect(s.meet.admin.made.channels).toHaveLength(1)
    expect(s.meet.admin.made.channels[0]).toMatchObject({ name: 'acme', privacy: 'private' })
    expect(went).toHaveLength(1)
    expect(went[0]).toMatch(/^\/meet\/chat%3Achannel%3A\d+$/)
    expect(changed).toBe(1)
    expect(m.q('new-channel')).toBeNull()
    await m.unmount()
  })

  test('meet’s refusal is shown and nothing is opened; the open choice is sent as open', async () => {
    const s = await setup()
    const { ChannelTools } = await import('../src/client/Channels')
    const went: string[] = []
    const m = await mount((h) => h(ChannelTools, { go: (p: string) => went.push(p), onChanged: () => undefined }))
    await m.click(m.q('new-channel-button'))
    await m.type(m.q('channel-name'), 'launch')
    await m.submit(m.q('channel-name'))
    expect(m.text()).toContain('There is already a channel with that name.')
    expect(went).toEqual([])
    await m.click(m.q('privacy-open'))
    await m.type(m.q('channel-name'), 'liftoff')
    await m.submit(m.q('channel-name'))
    expect(s.meet.admin.made.channels.at(-1)).toMatchObject({ name: 'liftoff', privacy: 'open' })
    expect(went).toHaveLength(1)
    await m.unmount()
  })

  test('Browse lists the open channels not joined with a count, and Join opens the channel', async () => {
    const s = await setup()
    const { ChannelTools } = await import('../src/client/Channels')
    const went: string[] = []
    const m = await mount((h) => h(ChannelTools, { go: (p: string) => went.push(p), onChanged: () => undefined }))
    await m.click(m.q('browse-button'))
    expect(m.all('browse-channel').map((r) => r.textContent)).toEqual(['design 3 peopleJoin'])
    await m.click(m.q('join-channel'))
    expect(s.meet.admin.made.changes).toEqual([{ do: 'join', conversationId: 31 }])
    expect(went).toEqual(['/meet/chat%3Achannel%3A31'])
    await m.unmount()
  })
})

describe('a channel’s people', () => {
  const mountPanel = async (id: number, go: (p: string) => void = () => undefined) => {
    const { ChannelPanel } = await import('../src/client/Channels')
    return mount((h) => h(ChannelPanel, { conversationId: id, go, onChanged: () => undefined }))
  }

  test('the owner sees every button meet says he may press, and a tag on each person', async () => {
    await setup()
    const m = await mountPanel(21)
    const rows = m.all('member')
    expect(rows.map((r) => r.querySelector('b')?.textContent)).toEqual(['Tessa (you)', 'Priya Natarajan', 'Dana Reyes', 'Marcus Chen', 'Rosa Whitfield'])
    expect(m.all('member-tag').map((t) => t.textContent)).toEqual(['Northfield Works', 'Northfield Works', 'Guest', 'Invited', 'Guest'])
    const buttons = (id: string) => rows.find((r) => r.dataset.person === id)?.querySelectorAll('button, a')
    const names = (id: string) => [...(buttons(id) ?? [])].map((b) => b.textContent)
    expect(names('p-priya')).toEqual(['Message', 'Delete everything'])
    expect(names('p-dana')).toEqual(['Message', 'Take out', 'Remove from workspace', 'Delete everything'])
    expect(names('p-marcus')).toEqual(['Take out', 'Remove from workspace', 'Delete everything'])
    // Launch was made by Priya, and Tessa is the owner: he may archive it.
    expect(m.q('archive')).not.toBeNull()
    expect(m.q('invite-go')).not.toBeNull()
    await m.unmount()
  })

  test('a teammate who is not the owner sees only Take out, Remove for a guest they invited, and no Delete or Archive of another’s channel', async () => {
    await setup({ owner: false })
    const m = await mountPanel(21)
    const rows = m.all('member')
    const names = (id: string) => [...(rows.find((r) => r.dataset.person === id)?.querySelectorAll('button, a') ?? [])].map((b) => b.textContent)
    expect(names('p-priya')).toEqual(['Message'])
    expect(names('p-dana')).toEqual(['Message', 'Take out', 'Remove from workspace'])
    expect(names('p-rosa')).toEqual(['Take out'])
    expect(m.q('archive')).toBeNull()
    expect(m.q('rename')).not.toBeNull()
    expect(m.q('leave')).not.toBeNull()
    await m.unmount()
  })

  test('Archive asks first, in meet’s words; Keep it archives nothing; Archive archives and leaves the channel behind', async () => {
    const s = await setup()
    const went: string[] = []
    const m = await mountPanel(22, (p) => went.push(p))
    await m.click(m.q('archive'))
    expect(m.text()).toContain("Archive this channel? It leaves everyone's list and takes no new messages.")
    expect(s.meet.admin.made.changes).toEqual([])
    await m.click(m.all('ask-no')[0] ?? null)
    expect(m.q('ask')).toBeNull()
    expect(s.meet.admin.made.changes).toEqual([])
    await m.click(m.q('archive'))
    await m.click(m.q('ask-yes'))
    expect(s.meet.admin.made.changes).toEqual([{ do: 'archive', conversationId: 22 }])
    expect(went).toEqual(['/meet'])
    await m.unmount()
  })

  test('Remove from workspace and Delete everything ask first, each in its own words, and only a yes asks meet', async () => {
    const s = await setup()
    const m = await mountPanel(21)
    const dana = () => m.all('member').find((r) => r.dataset.person === 'p-dana')
    await m.click(dana()?.querySelector('[data-testid=member-remove-all]') ?? null)
    expect(m.text()).toContain('Remove Dana Reyes from the workspace? They are signed out everywhere and see nothing more; their messages stay under their name.')
    await m.click(m.q('ask-no'))
    await m.click(dana()?.querySelector('[data-testid=member-delete]') ?? null)
    expect(m.text()).toContain('Delete Dana Reyes and every message they wrote, for good? This cannot be undone.')
    expect(s.meet.admin.made.changes).toEqual([])
    await m.click(m.q('ask-yes'))
    expect(s.meet.admin.made.changes).toEqual([{ do: 'delete-person', conversationId: 21, personId: 'p-dana' }])
    expect(m.all('member').map((r) => r.dataset.person)).not.toContain('p-dana')
    await m.unmount()
  })

  test('Take out takes a guest out at once, as /start did, and says so', async () => {
    const s = await setup()
    const m = await mountPanel(21)
    await m.click(m.all('member').find((r) => r.dataset.person === 'p-rosa')?.querySelector('[data-testid=member-remove]') ?? null)
    expect(s.meet.admin.made.changes).toEqual([{ do: 'take-out', conversationId: 21, personId: 'p-rosa' }])
    expect(m.text()).toContain('Rosa Whitfield is out of this channel.')
    await m.unmount()
  })

  test('Add offers the people meet says can be added, and adds the one chosen', async () => {
    const s = await setup()
    const m = await mountPanel(22)
    const select = m.q('add-person')
    expect(Array.from((select as unknown as { options: ArrayLike<{ textContent: string | null }> }).options).map((o) => o.textContent)).toEqual(['Choose', 'Dana Reyes (Guest)', 'Marcus Chen (Guest)', 'Rosa Whitfield (Guest)', 'Ben Walker (Northfield Works)'])
    expect((m.q('add-person-go') as HTMLButtonElement).disabled).toBe(true)
    await m.type(select, 'p-ben')
    await m.submit(select)
    expect(s.meet.admin.made.changes).toEqual([{ do: 'add', conversationId: 22, personId: 'p-ben' }])
    expect(m.all('member').map((r) => r.dataset.person)).toContain('p-ben')
    await m.unmount()
  })

  test('Rename shows the name, saves the new one, and Leave leaves', async () => {
    const s = await setup()
    const went: string[] = []
    const m = await mountPanel(22, (p) => went.push(p))
    await m.click(m.q('rename'))
    expect((m.q('rename-input') as HTMLInputElement).value).toBe('ops')
    await m.type(m.q('rename-input'), 'operations')
    await m.submit(m.q('rename-input'))
    expect(s.meet.admin.made.changes).toEqual([{ do: 'rename', conversationId: 22, name: 'operations' }])
    await m.click(m.q('leave'))
    expect(s.meet.admin.made.changes.at(-1)).toEqual({ do: 'leave', conversationId: 22 })
    expect(went).toEqual(['/meet'])
    await m.unmount()
  })
})

describe('Invite a guest: it goes by Invite, once, and says whether it left', () => {
  test('typing in the boxes sends nothing; Invite sends one email and says so, and the boxes are cleared', async () => {
    const s = await setup()
    const m = await (async () => {
      const { ChannelPanel } = await import('../src/client/Channels')
      return mount((h) => h(ChannelPanel, { conversationId: 22, go: () => undefined, onChanged: () => undefined }))
    })()
    expect(m.text()).toContain('Pressing Invite sends them an email from meet@northfield.example with a link to sign in at space.northfield.example/w/. Nothing is sent until you press it.')
    expect((m.q('invite-go') as HTMLButtonElement).disabled).toBe(true)
    await m.type(m.q('invite-name'), 'Abel Ng')
    await m.type(m.q('invite-email'), 'abel@abelcpa.example')
    expect(s.meet.admin.emailed).toEqual([])
    expect(s.meet.admin.made.invites).toEqual([])
    await m.submit(m.q('invite-name'))
    expect(s.meet.admin.emailed).toEqual(['abel@abelcpa.example'])
    expect(m.text()).toContain('Invited Abel Ng. They get an email from meet@northfield.example.')
    // The boxes are empty again, and the guest is in the channel, tagged Invited.
    expect((m.q('invite-name') as HTMLInputElement).value).toBe('')
    expect(m.all('member').find((r) => r.dataset.kind === 'guest' && r.textContent?.includes('Abel Ng'))?.querySelector('[data-testid=member-tag]')?.textContent).toBe('Invited')
    expect(s.meet.admin.made.invites).toHaveLength(1)
    await m.unmount()
  })

  test('an email that could not be sent is said plainly: the guest is in the channel, and Invite again sends it', async () => {
    const s = await setup()
    s.meet.admin.mailFails.next = true
    const { ChannelPanel } = await import('../src/client/Channels')
    const m = await mount((h) => h(ChannelPanel, { conversationId: 22, go: () => undefined, onChanged: () => undefined }))
    await m.type(m.q('invite-name'), 'Abel Ng')
    await m.type(m.q('invite-email'), 'abel@abelcpa.example')
    await m.submit(m.q('invite-name'))
    expect(s.meet.admin.emailed).toEqual([])
    expect(m.text()).toContain('Abel Ng is in the channel, but the invitation email could not be sent. Press Invite again to send it.')
    expect(m.text()).not.toContain('They get an email from meet@northfield.example')
    await m.type(m.q('invite-name'), 'Abel Ng')
    await m.type(m.q('invite-email'), 'abel@abelcpa.example')
    await m.submit(m.q('invite-name'))
    expect(s.meet.admin.emailed).toEqual(['abel@abelcpa.example'])
    await m.unmount()
  })

  test('a refusal is meet’s words, and nothing is sent', async () => {
    const s = await setup()
    const { ChannelPanel } = await import('../src/client/Channels')
    const m = await mount((h) => h(ChannelPanel, { conversationId: 22, go: () => undefined, onChanged: () => undefined }))
    await m.type(m.q('invite-name'), 'Ben')
    await m.type(m.q('invite-email'), 'ben@northfield.example')
    await m.submit(m.q('invite-name'))
    expect(m.text()).toContain('That address belongs to a Northfield Works person. Add them to the channel instead.')
    expect(s.meet.admin.emailed).toEqual([])
    // The boxes keep what was typed, so the person fixes it and presses again.
    expect((m.q('invite-email') as HTMLInputElement).value).toBe('ben@northfield.example')
    await m.unmount()
  })

  test('the key is the form’s: kept through a refusal and an outcome the page could not read, new only after success, so a guest is emailed once however many presses', async () => {
    const s = await setup()
    const { ChannelPanel } = await import('../src/client/Channels')
    const m = await mount((h) => h(ChannelPanel, { conversationId: 22, go: () => undefined, onChanged: () => undefined }))
    const keys = () => s.meet.admin.made.invites.map((i) => i.key)
    // A refusal (a Northfield Works person's address): the key is released by meet and kept by the page, so the corrected form is pressed with it.
    await m.type(m.q('invite-name'), 'Abel Ng')
    await m.type(m.q('invite-email'), 'ben@northfield.example')
    await m.submit(m.q('invite-name'))
    await m.type(m.q('invite-email'), 'abel@abelcpa.example')
    // Meet sends it and the answer is lost: outcome unknown, the boxes stay, nothing says it went.
    s.meet.admin.loseAnswer.next = true
    await m.submit(m.q('invite-name'))
    expect(s.meet.admin.emailed).toEqual(['abel@abelcpa.example'])
    expect(m.text()).toContain('did not say whether it went through')
    expect((m.q('invite-name') as HTMLInputElement).value).toBe('Abel Ng')
    expect(m.text()).not.toContain('Invited Abel Ng.')
    // Pressing again, and retyping the same words first, is the same key: meet answers the first and sends nothing more.
    await m.type(m.q('invite-name'), 'Abel Ng')
    await m.type(m.q('invite-email'), 'abel@abelcpa.example')
    await m.submit(m.q('invite-name'))
    expect(s.meet.admin.emailed).toEqual(['abel@abelcpa.example'])
    expect(m.text()).toContain('Invited Abel Ng. They get an email from meet@northfield.example.')
    expect(new Set(keys()).size).toBe(1)
    expect(keys()).toHaveLength(3)
    // After success the next invitation is a new press with a new key.
    await m.type(m.q('invite-name'), 'Mia Ho')
    await m.type(m.q('invite-email'), 'mia@abelcpa.example')
    await m.submit(m.q('invite-name'))
    expect(s.meet.admin.emailed).toEqual(['abel@abelcpa.example', 'mia@abelcpa.example'])
    expect(new Set(keys()).size).toBe(2)
    await m.unmount()
  })
})
