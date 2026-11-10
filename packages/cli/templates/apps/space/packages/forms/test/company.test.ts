// The company layer inside forms: the operators, the notice address and the sign-in check come from the install the
// Worker is given, so a second company's install (packages/workspace/test/fixtures/pinecrest.json) runs the same code
// and a person of one company is refused in the other, whether Cloudflare signed their assertion or not.
//
// The clients forms sends for (the Pinecrest of the other tests) are rows in the database, not companies: this file's
// "Lane" is the company that would run its own install, a different thing.
import { beforeEach, describe, expect, test } from 'bun:test'
import { createInstall } from '@space/workspace'
import { PINECREST_FILE, lane, readJson } from '../../workspace/test/helpers'
import { sweep } from '../src/signing'
import { bundledInstall, noticeTo } from '../src/workspace'
import { LANE_TEAM, harness } from './harness'
import { TEAM } from './keys'
import { kit } from './signing-kit'

const northfield = harness()
// The second company, on its own Zero Trust team.
const second = harness({}, lane())
// The same second company, but sharing Northfield's team, so Northfield's Access signs for its people too: the case where the
// signature is good and only the install decides.
const sameTeam = harness({}, createInstall({ ...(readJson(PINECREST_FILE) as object), access: { teamDomain: TEAM } }))
beforeEach(() => [northfield, second, sameTeam].forEach((h) => h.reset()))

const TESSA = { email: 'tessa@northfield.example' }
const LANE = { email: 'lane@pinecrest.test' }

describe("Northfield's install", () => {
  test('is the declaration the deploy gives Access, on the space’s Forms path: the same people, so the door and the Worker agree', () => {
    expect(bundledInstall.accessApplication('forms').allowedEmails).toEqual(bundledInstall.people.map((p) => p.signIn))
    expect(bundledInstall.accessApplication('forms')).toEqual({ domain: 'space.northfield.example/forms', allowedEmails: ['tessa@northfield.example'], sessionDuration: '24h' })
  })

  test('tells Tessa when an envelope ends', () => {
    expect(noticeTo(bundledInstall)).toEqual({ email: 'tessa@northfield.example', name: 'Tessa' })
  })

  test("admits Tessa and refuses a second company's owner, signed by that company's own Access or by Northfield's", async () => {
    expect((await northfield.call(TESSA, 'GET', '/admin/api/me')).status).toBe(200)
    // Another team's assertion is not for this application's issuer.
    expect((await northfield.call(null, 'GET', '/admin/api/me', undefined, { headers: { 'cf-access-jwt-assertion': await northfield.signAs(LANE_TEAM, LANE) } })).status).toBe(401)
    // Northfield's Access signs it, and it is still not a person of this install.
    expect((await northfield.call(LANE, 'GET', '/admin/api/clients')).status).toBe(403)
  })
})

describe("a second company's install", () => {
  test('admits its people at the address they sign in with, and records the address that names them', async () => {
    const owner = await second.call(LANE, 'GET', '/admin/api/me')
    expect(owner.status).toBe(200)
    expect(owner.body).toMatchObject({ email: 'lane@pinecrest.test', name: 'Lane', actor: 'lane@pinecrest.test', company: 'Pinecrest Test' })
    // Corin signs in with a Gmail address; the work address is who the app records.
    const corin = await second.call({ email: 'corin.private@example.com' }, 'GET', '/admin/api/me')
    expect(corin.status).toBe(200)
    expect(corin.body).toMatchObject({ email: 'corin@pinecrest.test', name: 'Corin', actor: 'corin@pinecrest.test' })
    // ... and the work address is not a way in.
    expect((await second.call({ email: 'corin@pinecrest.test' }, 'GET', '/admin/api/me')).status).toBe(403)
  })

  test("refuses Northfield's Tessa, signed by Northfield's Access or by its own team's", async () => {
    expect((await second.call(null, 'GET', '/admin/api/clients', undefined, { headers: { 'cf-access-jwt-assertion': await second.signAs(TEAM, TESSA) } })).status).toBe(401)
    expect((await second.call(TESSA, 'GET', '/admin/api/clients')).status).toBe(403)
  })

  test('on a shared Access team the signature is good and the install alone decides: each company refuses the other', async () => {
    expect((await sameTeam.call(LANE, 'GET', '/admin/api/clients')).status).toBe(200)
    expect((await sameTeam.call(TESSA, 'GET', '/admin/api/clients')).status).toBe(403)
    expect((await northfield.call(TESSA, 'GET', '/admin/api/clients')).status).toBe(200)
    expect((await northfield.call(LANE, 'GET', '/admin/api/clients')).status).toBe(403)
  })

  test('refuses a service token and an assertion naming both, as Northfield Works does', async () => {
    expect((await second.call({ common_name: 'abc.access' }, 'GET', '/admin/api/clients')).status).toBe(403)
    expect((await second.call({ ...LANE, common_name: 'abc.access' }, 'GET', '/admin/api/clients')).status).toBe(403)
  })

  test('tells its owner, and not Northfield Works, when an envelope expires', async () => {
    expect(noticeTo(lane())).toEqual({ email: 'lane@pinecrest.test', name: 'Lane' })
    const k = kit(second)
    await k.sent({ extra: { expires_in_days: 5 } })
    second.setClock(Date.UTC(2026, 9, 31, 20) + 5 * 86_400_000 + 1000)
    second.outbox.length = 0
    expect((await sweep(second.core())).expired).toBe(1)
    expect(second.outbox.map((m) => m.to.email)).toEqual(['lane@pinecrest.test'])
  })
})
