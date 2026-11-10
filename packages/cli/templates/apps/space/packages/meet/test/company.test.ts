// meet serves whatever company its install describes (packages/workspace): the people who may sign in, who owns it, the
// team whose assertions count. These run the same router against Northfield's declaration
// and against the layer's second company (Pinecrest, a test fixture), and check that a person of one is nobody in the
// other, even when Cloudflare signed the assertion.
import { describe, expect, test } from 'bun:test'
import { createInstall } from '@space/workspace'
import lane from '../../workspace/test/fixtures/pinecrest.json'
import { OWNER, harness } from './helpers'
import { W, actors } from './workspace.helpers'

const LANE = createInstall(lane)
const LANE_OWNER = 'lane@pinecrest.test'
// Corin signs in with a personal Gmail address and is named by the work address.
const CORIN_SIGN_IN = 'corin.private@example.com'
const CORIN = 'corin@pinecrest.test'
const DANA = 'dana@pinecrest.test'

const BOOT = `https://meet.test${W}/bootstrap`
const asserted = (jwt: string) => ({ 'cf-access-jwt-assertion': jwt })

describe("Northfield's install", () => {
  test('Tessa opens the workspace, with no bar of links to the other apps: the space is the one address', async () => {
    const h = await harness({ devBypass: false })
    const jwt = await h.access.sign({ email: OWNER })
    const boot = await h.callTeammate('GET', BOOT, undefined, { headers: asserted(jwt) })
    expect(boot.status).toBe(200)
    expect(boot.json.me).toMatchObject({ email: OWNER, kind: 'teammate', owner: true })
    expect(Object.keys(boot.json).sort()).toEqual(['browse', 'conversations', 'me', 'people', 'seq', 'site'])
  })
})

describe("a second company's install", () => {
  test('its owner is the owner and a member is not', async () => {
    const h = await harness({ devBypass: false, install: LANE })
    const owner = asserted(await h.access.sign({ email: LANE_OWNER }))
    const member = asserted(await h.access.sign({ email: DANA }))
    const boot = await h.callTeammate('GET', BOOT, undefined, { headers: owner })
    expect(boot.status).toBe(200)
    expect(boot.json.me).toMatchObject({ email: LANE_OWNER, name: 'Lane', owner: true })
    const dana = await h.callTeammate('GET', BOOT, undefined, { headers: member })
    expect(dana.json.me).toMatchObject({ email: DANA, owner: false })
  })

  test('a person who signs in with another address is that person, and only that address is let in', async () => {
    const h = await harness({ devBypass: false, install: LANE })
    const viaGmail = await h.callTeammate('GET', BOOT, undefined, { headers: asserted(await h.access.sign({ email: CORIN_SIGN_IN })) })
    expect(viaGmail.status).toBe(200)
    expect(viaGmail.json.me).toMatchObject({ email: CORIN, name: 'Corin', kind: 'teammate', owner: false })
    // The work address is not what Access sends the code to here, so an assertion naming it is not Corin.
    const viaWork = await h.callTeammate('GET', BOOT, undefined, { headers: asserted(await h.access.sign({ email: CORIN })) })
    expect(viaWork.status).toBe(403)
  })

  test("a person's Gmail sign-in address cannot be invited as a guest", async () => {
    const h = await harness({ devBypass: false, install: LANE })
    const a = actors(h)
    const conv = (await a.tm(LANE_OWNER, 'POST', '/channels', { name: 'Jobs', privacy: 'private' })).json.conversation.id
    for (const address of [CORIN, CORIN_SIGN_IN]) {
      const r = await a.tm(LANE_OWNER, 'POST', `/channels/${conv}/invite`, { email: address, name: 'Corin' })
      expect([address, r.status]).toEqual([address, 409])
    }
  })

  test('a guest’s first answer has the same keys as a teammate’s', async () => {
    const h = await harness({ devBypass: false, install: LANE })
    const a = actors(h)
    const conv = (await a.tm(LANE_OWNER, 'POST', '/channels', { name: 'Jobs', privacy: 'private' })).json.conversation.id
    expect((await a.tm(LANE_OWNER, 'POST', `/channels/${conv}/invite`, { email: 'gus@client.test', name: 'Gus' })).status).toBe(201)
    const token = await a.signIn('gus@client.test')
    const boot = await a.gu(token, 'GET', '/bootstrap')
    expect(boot.status).toBe(200)
    expect(Object.keys(boot.json).sort()).toEqual(['browse', 'conversations', 'me', 'people', 'seq', 'site'])
  })
})

describe('a person of one install is nobody in the other', () => {
  test("each company's own team signs only its own people", async () => {
    const northfield = await harness({ devBypass: false })
    const other = await harness({ devBypass: false, install: LANE })
    // Tessa, signed by Northfield's team, at Lane's door; Lane, signed by Lane's team, at Northfield's. Neither team's keys or issuer are the other's.
    const tessa = asserted(await northfield.access.sign({ email: OWNER }))
    const lane = asserted(await other.access.sign({ email: LANE_OWNER }))
    expect((await other.callTeammate('GET', BOOT, undefined, { headers: tessa })).status).toBe(401)
    expect((await northfield.callTeammate('GET', BOOT, undefined, { headers: lane })).status).toBe(401)
    expect(northfield.cores.size + other.cores.size).toBe(0)
  })

  test('even a genuine assertion from the right team is refused for a person the install does not name', async () => {
    const northfield = await harness({ devBypass: false })
    const other = await harness({ devBypass: false, install: LANE })
    // Same team, valid signature, but the person belongs to the other company.
    for (const [h, who] of [
      [northfield, LANE_OWNER],
      [other, OWNER],
    ] as const) {
      const headers = asserted(await h.access.sign({ email: who }))
      expect([who, (await h.callTeammate('GET', BOOT, undefined, { headers })).status]).toEqual([who, 403])
    }
    expect(northfield.cores.size + other.cores.size).toBe(0)
  })

  test('a service token is no person in either', async () => {
    for (const install of [undefined, LANE]) {
      const h = await harness({ devBypass: false, ...(install ? { install } : {}) })
      const headers = asserted(await h.access.sign({ common_name: 'abc.access' }))
      expect((await h.callTeammate('GET', BOOT, undefined, { headers })).status).toBe(403)
    }
  })
})
