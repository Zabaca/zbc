// The leads door on the space (src/leads-door.ts), driven with real requests through the real router: only the door's service token, for the door's application, on its one path, gets through, and
// what it hands on is one request in the shape the inbox takes. The inbox's own rules (the person, a fold, the install's fields, a repeat, who is told) are proven in packages/inbox/test/leads.test.ts
// and leads-door.test.ts; here is what travels the door and what is refused at it.
import { beforeEach, describe, expect, test } from 'bun:test'
import type { LeadFromSource } from '@space/inbox/src/space-part'
import { refused } from '@space/workspace'
import { northfield } from '../../workspace/test/helpers'
import { parseLeadBody } from '../src/leads-door'
import { CLIENTS_AUD, CLIENTS_TOKEN, LEADS_AUD, LEADS_TOKEN, NORTHFIELD_TEAM, world } from './world'

const API = '/agent/leads/api/leads'
const JSON_HEADERS = { 'content-type': 'application/json' }

describe('the leads door on the space', () => {
  let w: Awaited<ReturnType<typeof world>>
  let handed: LeadFromSource[]
  beforeEach(async () => {
    handed = []
    w = await world(northfield(), NORTHFIELD_TEAM, {
      parts: {
        leadsDoor: async (request) => {
          handed.push(request)
          return request.fields && (request.fields as Record<string, unknown>).colour !== undefined
            ? refused('bad-request', 'colour is not a field of this space’s leads.')
            : { ok: true, value: { leadId: 'lead-1', outcome: 'made' } }
        },
      },
    })
  })
  const post = async (body: unknown, jwt?: string, path = API) => w.call(path, { method: 'POST', jwt: jwt ?? (await w.signInLeads()), headers: JSON_HEADERS, body: JSON.stringify(body) })

  test('a request with the door’s token is handed to the inbox in its shape, and the inbox’s answer comes back', async () => {
    const res = await post({ id: 'q-17', name: 'Jo Park', email: 'jo@home.example', phone: '(626) 555-0101', fields: { project: 'New wheels' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ value: { leadId: 'lead-1', outcome: 'made' } })
    expect(handed).toEqual([{ externalId: 'q-17', name: 'Jo Park', email: 'jo@home.example', phone: '(626) 555-0101', fields: { project: 'New wheels' } }])
  })

  test('the inbox’s refusal is the door’s answer, with its reason', async () => {
    const res = await post({ id: 'q-1', name: 'Jo', email: 'jo@home.example', fields: { colour: 'red' } })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: 'bad-request' })
  })

  test('no assertion, another door’s token, a person, or a token that is not the door’s is refused before anything is handed on', async () => {
    expect((await w.call(API, { method: 'POST', headers: JSON_HEADERS, body: '{}' })).status).toBe(401)
    expect((await post({ id: 'q-1', name: 'Jo' }, await w.signInClients({ common_name: CLIENTS_TOKEN }, CLIENTS_AUD))).status).toBe(401)
    expect((await post({ id: 'q-1', name: 'Jo' }, await w.signInLeads({ email: 'tessa@northfield.example' }))).status).toBe(403)
    expect((await post({ id: 'q-1', name: 'Jo' }, await w.signInLeads({ common_name: 'someone-else.access' }, LEADS_AUD))).status).toBe(403)
    expect(handed).toEqual([])
  })

  test('the door has one call: another path under it is a 404, another method a 405', async () => {
    expect((await post({ id: 'q-1', name: 'Jo' }, undefined, '/agent/leads/api/other')).status).toBe(404)
    expect((await w.call(API, { method: 'GET', jwt: await w.signInLeads() })).status).toBe(405)
    expect(handed).toEqual([])
  })

  test('a body that is not one request is refused with what is wrong, and nothing is handed on', async () => {
    for (const body of [{ name: 'Jo' }, { id: 'has spaces', name: 'Jo' }, { id: 'q-1', name: 7 }, { id: 'q-1', name: 'Jo', fields: 'project' }, { id: 'q-1', name: 'Jo', at: 'yesterday' }]) {
      const res = await post(body)
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400])
    }
    expect(handed).toEqual([])
    void LEADS_TOKEN
  })
})

describe('a request’s shape', () => {
  test('a carried-over lead keeps its stage and its moment, written in the one spelling', () => {
    expect(parseLeadBody({ id: 'old-3', name: 'Ann Lee', email: null, phone: '6265550101', stage: 'contacted', at: '2026-09-01T10:00:00Z' })).toEqual({
      ok: true,
      value: { externalId: 'old-3', name: 'Ann Lee', email: null, phone: '6265550101', fields: {}, stage: 'contacted', at: '2026-09-01T10:00:00.000Z' },
    })
  })
})
