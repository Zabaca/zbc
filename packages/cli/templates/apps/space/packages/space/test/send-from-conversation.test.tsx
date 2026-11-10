// Forms' Send screen opened from a conversation: the first signer is the conversation's person, what is made carries the conversation, and a forms that
// does not know conversations yet is said, never silently sent unlinked. The DOM is registered for this file only, so React is imported after it
// (as forms-tab.test.tsx and settings-dom.test.tsx do).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

const realFetch = globalThis.fetch
beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://space.northfield.example/forms/send' })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  globalThis.fetch = realFetch
})

const CLIENT = { id: '11111111-1111-4111-8111-111111111111', slug: 'lane', client_number: 1001, client_archived: false, display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing', accent_color: '#7a2e1d', reply_to: 'office@lane.example', copy_addresses: [], time_zone: 'America/Los_Angeles', retention_years: 7, has_logo: false, logo_type: null, logo_sha256: null, created_at: '2026-11-02T10:00:00Z', updated_at: '2026-11-02T10:00:00Z' }
const SIGNING = { key: 'dana@harbor.example', name: 'Dana Reyes', channel: false, conversation: { app: 'inbox', id: 'c-dana' }, people: [{ name: 'Dana Reyes', addresses: ['dana@harbor.example', 'dreyes@mail.example'] }] }
const MADE_ID = '22222222-2222-4222-8222-222222222222'

let unmount: (() => Promise<void>) | null = null
const calls: { method: string; path: string; body: unknown }[] = []
afterEach(async () => {
  await unmount?.()
  unmount = null
  calls.length = 0
  globalThis.fetch = realFetch
  window.history.replaceState(null, '', '/forms/send')
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Setup {
  /** What Worker says to the conversation read. */
  signers?: () => Response
  /** How long the conversation's read takes, for typing before it arrives. */
  signersDelayMs?: number
  /** Whether forms echoes the conversation on the envelope it makes (a forms that knows conversations does). */
  echoes?: boolean
}

async function openSend(search: string, o: Setup = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://space.northfield.example')
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method: init?.method ?? 'GET', path: url.pathname + url.search, body })
    if (url.pathname === '/api/conversation/signers') {
      if (o.signersDelayMs) await sleep(o.signersDelayMs)
      return (o.signers ?? (() => Response.json(SIGNING)))()
    }
    if (url.pathname === '/forms/api/clients') return Response.json([CLIENT])
    if (url.pathname === '/forms/api/envelopes' && init?.method === 'POST') {
      const link = body.conversation && o.echoes !== false ? { conversation_app: body.conversation.app, conversation_id: body.conversation.id } : {}
      return Response.json({ envelope: { id: MADE_ID, status: 'draft', title: 'Sample', ...link }, recipients: [], events: [], mail: [], instructions: [] }, { status: 201 })
    }
    return Response.json([])
  }) as typeof fetch
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { FormsTab } = await import('../src/client/forms/FormsTab')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  unmount = () => act(async () => root.unmount())
  await act(async () => root.render(<FormsTab pathname="/forms/send" search={search} go={() => undefined} />))
  if (!o.signersDelayMs) await act(async () => sleep(40))
  const submit = async () => {
    const form = host.querySelector('form') as HTMLFormElement
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await sleep(40)
    })
  }
  /** Types into a field the way a person does: the input event React listens to. */
  const fill = async (id: string, text: string) => {
    const input = host.querySelector(`#${id}`) as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  return { host, submit, fill }
}

const value = (host: HTMLElement, id: string) => (host.querySelector(`#${id}`) as HTMLInputElement).value

describe('Send from a conversation', () => {
  test('the first signer is the conversation’s person, with their addresses to choose from, and the screen says where it came from', async () => {
    const { host } = await openSend('?from=dana%40harbor.example')
    expect(calls.filter((c) => c.path.startsWith('/api/conversation/signers')).map((c) => c.path)).toEqual(['/api/conversation/signers?key=dana%40harbor.example'])
    expect(value(host, 'name-0')).toBe('Dana Reyes')
    expect(value(host, 'email-0')).toBe('dana@harbor.example')
    expect([...host.querySelectorAll('#conversation-addresses option')].map((o) => o.getAttribute('value'))).toEqual(['dana@harbor.example', 'dreyes@mail.example'])
    // One signer, not the two blank ones Forms starts with.
    expect(host.querySelectorAll('[id^="name-"]').length).toBe(1)
    const banner = host.querySelector('[data-testid="send-from"]')!
    expect(banner.textContent).toContain('From your conversation with Dana Reyes')
    expect(banner.querySelector('a')?.getAttribute('href')).toBe('/inbox/dana%40harbor.example')
  })

  test('what someone has already typed in the signer boxes is not written over when the conversation arrives', async () => {
    const { host, fill } = await openSend('?from=dana%40harbor.example', { signersDelayMs: 150 })
    await fill('name-0', 'Someone Else')
    await fill('email-0', 'else@x.example')
    const { act } = await import('react')
    await act(async () => sleep(300))
    expect(host.querySelector('[data-testid="send-from"]')).not.toBeNull() // it has arrived
    expect(value(host, 'name-0')).toBe('Someone Else')
    expect(value(host, 'email-0')).toBe('else@x.example')
    expect(host.querySelectorAll('[id^="name-"]').length).toBe(2) // and the form is as Forms starts it
  })

  test('what is made carries the conversation, and the draft opens', async () => {
    const { host, submit } = await openSend('?from=dana%40harbor.example')
    await submit()
    const made = calls.find((c) => c.method === 'POST' && c.path === '/forms/api/envelopes')!
    expect(made.body).toMatchObject({ client_id: CLIENT.id, conversation: { app: 'inbox', id: 'c-dana' }, recipients: [{ name: 'Dana Reyes', email: 'dana@harbor.example', kind: 'signer' }] })
    expect(window.location.pathname).toBe(`/forms/envelopes/${MADE_ID}`)
    expect(host.querySelector('[data-testid="send-unlinked"]')).toBeNull()
  })

  test('a forms that does not know conversations yet makes the draft, says it is not linked, and does not pretend', async () => {
    const { host, submit } = await openSend('?from=dana%40harbor.example', { echoes: false })
    await submit()
    expect(calls.some((c) => c.method === 'POST' && c.path === '/forms/api/envelopes')).toBe(true)
    expect(window.location.pathname).toBe('/forms/send') // it stays
    const warning = host.querySelector('[data-testid="send-unlinked"]')!
    expect(warning.textContent).toContain('will not show as a card there')
    expect(warning.querySelector('a')?.getAttribute('href')).toBe(`/forms/envelopes/${MADE_ID}`)
  })

  test('a conversation that cannot be read says so and sends nothing: it never makes a document with no link', async () => {
    const { host, submit } = await openSend('?from=nobody%40x.example', { signers: () => Response.json({ error: 'There is no such conversation. It may have been closed or moved.' }, { status: 404 }) })
    expect(host.textContent).toContain('There is no such conversation.')
    expect((host.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true)
    await submit()
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  test('a channel names no one, so the signers stay for the person to name, and the document carries the channel', async () => {
    const { host, submit, fill } = await openSend('?from=chat%3Achannel%3A21', { signers: () => Response.json({ key: 'chat:channel:21', name: '# web-team', channel: true, conversation: { app: 'meet', id: '21' }, people: [] }) })
    expect(host.querySelector('[data-testid="send-from"]')!.textContent).toContain('A channel does not say who is in it')
    expect(value(host, 'name-0')).toBe('')
    expect(host.querySelectorAll('[id^="name-"]').length).toBe(2)
    for (const i of [0, 1]) {
      await fill(`name-${i}`, `Signer ${i}`)
      await fill(`email-${i}`, `s${i}@x.example`)
    }
    await submit()
    expect(calls.find((c) => c.method === 'POST' && c.path === '/forms/api/envelopes')!.body).toMatchObject({ conversation: { app: 'meet', id: '21' } })
  })

  test('opened from Forms it is as it was: two blank signers, no conversation read, nothing linked', async () => {
    const { host, submit, fill } = await openSend('')
    expect(calls.some((c) => c.path.startsWith('/api/conversation'))).toBe(false)
    expect(host.querySelector('[data-testid="send-from"]')).toBeNull()
    expect(host.querySelectorAll('[id^="name-"]').length).toBe(2)
    for (const i of [0, 1]) {
      await fill(`name-${i}`, `Signer ${i}`)
      await fill(`email-${i}`, `s${i}@x.example`)
    }
    await submit()
    const made = calls.find((c) => c.method === 'POST' && c.path === '/forms/api/envelopes')!
    expect(made.body).not.toHaveProperty('conversation')
    expect(window.location.pathname).toBe(`/forms/envelopes/${MADE_ID}`)
  })
})
