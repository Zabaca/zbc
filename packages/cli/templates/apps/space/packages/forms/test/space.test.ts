// forms' admin screens are the space's own page: the team works at space.northfield.example/forms, whose screens ask forms'
// operator API at the space's own address. forms has no address of its own any more, so these drive the real router as the space's
// Worker would ask it: with the assertion of the Forms application, from the space's own address.
import { beforeEach, describe, expect, test } from 'bun:test'
import { harness } from './harness'

const h = harness()
const TESSA = { email: 'tessa@northfield.example' }
const SPACE = 'space.northfield.example'
beforeEach(() => h.reset())

describe('the space asking for the admin', () => {
  test('the API answers the Forms assertion the space passes along, at the space’s address', async () => {
    const me = await h.call(TESSA, 'GET', '/admin/api/me', undefined, { host: SPACE })
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ email: 'tessa@northfield.example', company: 'Northfield Works' })
    expect((await h.call(null, 'GET', '/admin/api/me', undefined, { host: SPACE })).status).toBe(401)
  })

  test('a write from the page is accepted from the space’s own address and refused from any other site', async () => {
    const via = h.clients().add({ name: 'Via space', legalName: 'Via Space Inc' })
    const body = { slug: 'via-space', client_number: via.number, reply_to: 'a@b.test' }
    const same = await h.call(TESSA, 'POST', '/admin/api/clients', body, { host: SPACE, headers: { origin: `https://${SPACE}`, 'sec-fetch-site': 'same-origin' } })
    expect(same.status).toBe(201)
    const other = await h.call(TESSA, 'POST', '/admin/api/clients', { ...body, slug: 'from-elsewhere' }, { host: SPACE, headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } })
    expect(other.status).toBe(403)
  })

  test('forms has no admin page of its own to send anyone from: a read of /admin is the router’s plain 404, not a redirect', async () => {
    for (const path of ['/admin', '/admin/', '/admin/anything/else']) {
      const res = await h.request({}, 'GET', path, undefined, SPACE)
      expect([path, res.status, res.headers.get('location')]).toEqual([path, 404, null])
    }
  })
})
