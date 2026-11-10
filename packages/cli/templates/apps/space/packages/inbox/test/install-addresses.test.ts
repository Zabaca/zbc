// Addresses and names come from the install, in the inbox: the push host, the notification's title and the push service's contact.
// Northfield's are held by push-endpoint.test.ts, notify-rule.test.ts and webpush.test.ts; this one runs them on an invented company and proves Northfield's host and name are nowhere in what it answers.
import { describe, expect, test } from 'bun:test'
import { createInstall } from '@space/workspace'
import { PUSH_PATH } from '../src/gmail/push'
import { testPayload } from '../src/notify/rule'
import { inboxOwnerOf } from '../src/owner'
import { createPushApp } from '../src/push-door'

const BRIGHTWATER = createInstall({
  company: {
    id: 'brightwater',
    name: 'Brightwater Builders',
    domain: 'brightwater.example',
    timeZone: 'America/Chicago',
  },
  access: { teamDomain: 'brightwater.cloudflareaccess.com' },
  formsService: { contact: 'help@example.test' },
  space: { host: 'space.brightwater.example', sessionDuration: '730h' },
  gmailPush: { host: 'inbox-push.brightwater.example' },
  googleApp: {
    clientId: '123456789012-abcdefghijklmnop.apps.googleusercontent.com',
    pushTopic: 'projects/brightwater-mail/topics/inbox-gmail',
  },
  switches: { gmail: true },
  people: [{ address: 'ada@brightwater.example', name: 'Ada', role: 'owner' }],
})

const answer = async (host: string, pushHost: string | null | undefined, path = PUSH_PATH) => {
  const app = createPushApp({ store: () => ({}) as never, ...(pushHost !== undefined && { pushHost }) })
  const res = await app.fetch(new Request(`https://${host}${path}`, { method: 'POST', body: '{}' }), {} as never)
  return res.status
}

describe('the push host is the install’s', () => {
  test('the install’s host is the push hostname even with the settings unset (it refuses a push there: 401), and no other host is (404), Northfield’s included', async () => {
    const host = BRIGHTWATER.gmailPushHost()
    expect(host).toBe('inbox-push.brightwater.example')
    expect(await answer('inbox-push.brightwater.example', host)).toBe(401)
    expect(await answer('inbox-push.northfield.example', host)).toBe(404)
    expect(await answer('space.brightwater.example', host)).toBe(404)
    expect(await answer('inbox-push.brightwater.example', host, '/api/other')).toBe(404)
  })

  test('an install without Gmail has no push host: nothing on any host is answered by the push door', async () => {
    const quiet = createInstall({
      company: { id: 'q', name: 'Quiet Co', domain: 'quiet.example', timeZone: 'America/Chicago' },
      access: { teamDomain: 'example.cloudflareaccess.com' },
      formsService: { contact: 'help@example.test' },
      space: { host: 'space.quiet.example', sessionDuration: '730h' },
      people: [{ address: 'q@quiet.example', name: 'Q', role: 'owner' }],
    })
    expect(quiet.gmailPushHost()).toBeNull()
    expect(await answer('inbox-push.quiet.example', quiet.gmailPushHost())).toBe(404)
    expect(await answer('inbox-push.northfield.example', quiet.gmailPushHost())).toBe(404)
  })
})

describe('the notification says the company and contacts the space', () => {
  test('the test notification’s title is "<company> Space", and the push service’s contact is the install’s space address', () => {
    const owner = inboxOwnerOf(BRIGHTWATER)
    expect(owner.spaceOrigin).toBe('https://space.brightwater.example')
    expect(testPayload(new Date('2026-11-09T12:00:00Z'), owner.company).title).toBe('Brightwater Builders Space')
    expect(JSON.stringify([owner.company, owner.spaceOrigin])).not.toMatch(/northfield|tessa/i)
  })
})
