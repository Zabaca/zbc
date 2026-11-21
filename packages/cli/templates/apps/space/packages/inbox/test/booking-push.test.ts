import { describe, expect, test } from 'bun:test'
import { createInstall } from '@space/workspace'
import { NORTHFIELD_DECLARATION } from '../../workspace/northfield'
import { bookingPayload } from '../src/notify/rule'
import { bundledContent } from '../src/workspace'
import { harness, RIDGEWAY } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'
import { decrypt, newDevice, type TestDevice } from '../test-support/push-device'

/**
 * A booking a visitor made on one of the owner's booking links (the space's ADR 0025), told to the owner's devices by the inbox's notifications, which the calendar asks in-process (`notifyBooking`): the owner's devices and no one else's, once
 * for a booking, in words the calendar made, with a payload that names no person and opens the Calendar tab.
 */

const pushed = async (h: ReturnType<typeof harness>, device: TestDevice) =>
  Promise.all(
    h.pushService
      .to(device.endpoint)
      .map(async (r) => JSON.parse((await decrypt(device, r.body)).text) as Record<string, unknown>),
  )

const booking = (over: Record<string, string> = {}) => ({
  bookingId: 'b-1',
  title: 'Booked: Ada Quill, Fri, Nov 6, 10:00 AM PST',
  body: 'Intro call',
  at: '2026-11-05T20:00:00.000Z',
  ...over,
})

describe('a booking’s notification', () => {
  test('is a payload that names no person and no conversation, tagged by the booking, with the calendar’s words cut to what a notification shows', () => {
    const payload = bookingPayload(booking({ title: 'T'.repeat(500), body: 'B'.repeat(2000) }))
    expect(payload).toMatchObject({
      v: 1,
      kind: 'booking',
      conversationId: null,
      messageId: 'booking-b-1',
      at: '2026-11-05T20:00:00.000Z',
    })
    expect(payload).not.toHaveProperty('person')
    expect(payload.title.length).toBeLessThanOrEqual(100)
    expect(payload.body.length).toBeLessThanOrEqual(200)
    expect(bookingPayload(booking({ bookingId: 'b-2' })).messageId).toBe('booking-b-2')
  })

  test('is told to the owner’s devices in the calendar’s words', async () => {
    const h = harness()
    const device = await newDevice()
    expect(
      (
        (await h.store.call('addDevice', { endpoint: device.endpoint, keys: device.keys }, null, OWNER_EMAIL)) as {
          ok: boolean
        }
      ).ok,
    ).toBe(true)
    expect(await h.store.call('notifyBooking', booking())).toEqual({ handed: 1 })
    const said = await pushed(h, device)
    expect(said).toHaveLength(1)
    expect(said[0]).toMatchObject({
      kind: 'booking',
      title: 'Booked: Ada Quill, Fri, Nov 6, 10:00 AM PST',
      body: 'Intro call',
      conversationId: null,
      messageId: 'booking-b-1',
    })
  })

  test('is told to no one else: a member who is not an owner, even one on every mailbox, is not told, and with no device nothing is', async () => {
    const raw = structuredClone(NORTHFIELD_DECLARATION) as Record<string, any>
    raw.people.push({ address: 'dana@northfield.example', name: 'Dana', role: 'member' })
    for (const m of raw.cloudflareMailboxes)
      if (m.address === RIDGEWAY.address) m.people = ['tessa@northfield.example', 'dana@northfield.example']
    const h = harness({}, { install: createInstall(raw), content: bundledContent, mailboxes: [RIDGEWAY] })
    const owner = await newDevice('tessa@northfield.example')
    const dana = await newDevice('dana@northfield.example')
    for (const [who, device] of [
      ['tessa@northfield.example', owner],
      ['dana@northfield.example', dana],
    ] as const) {
      expect(
        (
          (await h.store.call('addDevice', { endpoint: device.endpoint, keys: device.keys }, null, who)) as {
            ok: boolean
          }
        ).ok,
      ).toBe(true)
    }
    expect(await h.store.call('notifyBooking', booking())).toEqual({ handed: 1 })
    expect((await pushed(h, owner)).map((p) => p.kind)).toEqual(['booking'])
    expect(await pushed(h, dana)).toEqual([])
    const bare = harness()
    expect(await bare.store.call('notifyBooking', booking())).toEqual({ handed: 0 })
  })
})
