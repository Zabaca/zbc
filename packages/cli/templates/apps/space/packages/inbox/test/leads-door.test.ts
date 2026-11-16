import { describe, expect, test } from 'bun:test'
import { createInstall, type Install } from '@space/workspace'
import { NORTHFIELD_DECLARATION } from '../../workspace/northfield'
import { createInboxPartFactory, type InboxPartEnv } from '../src/space-part'
import { harness, RIDGEWAY } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'
import { decrypt, newDevice, type TestDevice } from '../test-support/push-device'

/**
 * A request from the company's site, as the space's leads door hands it to the inbox's part (`InboxPart.leadFromSource`): made a lead in the invented company's leads (Ridgeway's mailbox; the
 * declaration's `leads.door` and `leads.notify`), and told to the devices of the people on that mailbox. A repeat of the same request tells nobody; one more request on the open lead tells again.
 */

type H = ReturnType<typeof harness>

const raw = (id: string) =>
  [
    `From: Cora Lund <cora@dock.example>`,
    `To: ${RIDGEWAY.address}`,
    'Subject: Hello',
    `Message-ID: <${id}@mail.example>`,
    'Date: Mon, 20 Oct 2026 12:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'Hi there',
    '',
  ].join('\r\n')

function partOver(h: H, install?: Install) {
  const stub = {
    call: (method: string, args: unknown[]) =>
      (h.store.call as (m: string, ...a: unknown[]) => Promise<unknown>)(method, ...args),
    restart: async () => {},
  }
  const INBOX = { idFromName: (name: string) => name, get: () => stub } as unknown as InboxPartEnv['INBOX']
  return createInboxPartFactory(install)({ INBOX, clients: h.directory })
}

async function world() {
  const h = harness()
  // The first mail makes Ridgeway's mailbox, as on a live install; the owner is on it.
  expect((await h.deliver(raw('r1'), { to: RIDGEWAY.address })).entered).toBe('filed')
  const device = await newDevice()
  const added = (await h.store.call(
    'addDevice',
    { endpoint: device.endpoint, keys: device.keys },
    null,
    OWNER_EMAIL,
  )) as { ok: boolean }
  expect(added.ok).toBe(true)
  return { h, device, part: partOver(h) }
}

const pushed = async (h: H, device: TestDevice) =>
  Promise.all(
    h.pushService
      .to(device.endpoint)
      .map(async (r) => JSON.parse((await decrypt(device, r.body)).text) as Record<string, unknown>),
  )

const request = (id: string, over: Record<string, unknown> = {}) => ({
  externalId: id,
  name: 'Jo Park',
  email: 'jo@home.example',
  phone: null,
  fields: { project: 'New wheels', budget: 'About 900' },
  ...over,
})

describe('a request through the leads door', () => {
  test('is made a lead and told to the leads’ people in the install’s words; the same request again tells nobody', async () => {
    const { h, device, part } = await world()
    const made = await part.leadFromSource(request('q1'))
    expect(made).toMatchObject({ ok: true, value: { outcome: 'made' } })
    const said = await pushed(h, device)
    expect(said).toHaveLength(1)
    expect(said[0]).toMatchObject({
      kind: 'lead',
      title: 'New quote request',
      body: 'Jo Park, New wheels',
      conversationId: null,
    })
    expect(await part.leadFromSource(request('q1'))).toMatchObject({ ok: true, value: { outcome: 'repeat' } })
    expect(await pushed(h, device)).toHaveLength(1)
  })

  test('one more request on the open lead is folded into it and told again, under a tag of its own', async () => {
    const { h, device, part } = await world()
    await part.leadFromSource(request('q1'))
    expect(await part.leadFromSource(request('q2', { fields: { project: 'A new frame' } }))).toMatchObject({
      ok: true,
      value: { outcome: 'folded' },
    })
    const said = await pushed(h, device)
    expect(said.map((p) => p.body)).toEqual(['Jo Park, New wheels', 'Jo Park, A new frame'])
    expect(new Set(said.map((p) => p.messageId)).size).toBe(2)
  })

  test('a field the install does not declare is refused, and nothing is kept or told', async () => {
    const { h, device, part } = await world()
    expect(await part.leadFromSource(request('q1', { fields: { colour: 'red' } }))).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(await pushed(h, device)).toEqual([])
    expect((h.db.query('SELECT count(*) AS n FROM lead').get() as { n: number }).n).toBe(0)
  })

  test('an install that declares no door takes no lead from a site', async () => {
    const { h } = await world()
    const noDoor = structuredClone(NORTHFIELD_DECLARATION) as { leads: { door?: unknown } }
    delete noDoor.leads.door
    const part = partOver(h, createInstall(noDoor))
    expect(await part.leadFromSource(request('q1'))).toMatchObject({ ok: false, reason: 'not-found' })
  })

  test('a lead in a mailbox no mail has reached yet is told to the owner alone, who alone sees it', async () => {
    const { h, device } = await world()
    const told = await h.store.call('notifyLead', {
      leadId: 'x',
      requests: 1,
      mailbox: 'nobody@elsewhere.example',
      title: 'New lead',
      body: 'Someone',
      at: new Date(h.now()).toISOString(),
    })
    expect(told).toEqual({ handed: 1 })
    void device
  })
})
