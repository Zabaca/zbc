import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createInstall, type InboxLead, type Install } from '@space/workspace'
import { type CliIo, runCli, USAGE } from '../scripts/cli'
import { receiveLeadFromSource } from '../src/space-leads'
import { bundledContent, bundledInstall } from '../src/workspace'
import {
  AGENT,
  AGENT_ID,
  asker,
  BRIDGE,
  count,
  harness,
  OWNER,
  RIDGEWAY,
  STRANGER,
  TELEGRAM_AUD,
  TEXTS_AUD,
  TEXTS_BRIDGE,
} from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'
import { CLIENT_ID, CLIENT_SECRET, throughSpace } from '../test-support/space-door'

/**
 * The leads at Claude's door (docs/adr/0005 decision 6; src/app.ts, `leadsForClaude` in src/space-leads.ts): on an install with both the `claudeScript` and the `leads` switches, Claude's token reads the board
 * and one person's leads and moves a lead between the install's stages, with the owner's eyes and by the owner's rules, recorded as Claude. Driven through the real router behind the harness's copy of
 * the space's one check, over a real SQLite, and through the real script. Northfield has both switches; the installs without one are Northfield with it turned off.
 */

const SOURCE = 'ridgewaycycles.example'
const DANA = 'dana@northfield.example'

const northfieldJson = () =>
  JSON.parse(readFileSync(new URL('../../workspace/northfield/workspace.json', import.meta.url), 'utf8'))

/** Northfield without its leads: the switch off and nothing declared for it. */
function withoutLeads(): Install {
  const raw = northfieldJson()
  raw.switches.leads = false
  delete raw.leads
  return createInstall(raw)
}

/** A request from the company's site, as its leads door hands one in: how a lead comes to be in these tests (Claude's door makes none). */
async function sent(
  h: ReturnType<typeof harness>,
  externalId: string,
  o: { name?: string; email?: string; fields?: Record<string, string>; install?: Install } = {},
): Promise<InboxLead> {
  const got = await receiveLeadFromSource(
    { store: h.store, install: o.install ?? bundledInstall },
    {
      source: SOURCE,
      externalId,
      name: o.name ?? 'Jo Park',
      email: o.email ?? 'jo@home.example',
      phone: null,
      fields: o.fields ?? {},
    },
  )
  expect(got.ok, JSON.stringify(got)).toBe(true)
  return (got as { value: { lead: InboxLead } }).value.lead
}

/** One email to the leads' mailbox, so the store has its row and its people are seated, as the first mail does on a live install. */
async function mailToTheLeadsMailbox(h: ReturnType<typeof harness>) {
  const raw = [
    'From: Cora Lund <cora@dock.example>',
    `To: ${RIDGEWAY.address}`,
    'Subject: Hello',
    'Message-ID: <d1@mail.example>',
    'Date: Mon, 20 Oct 2026 12:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'Hi there',
    '',
  ].join('\r\n')
  expect((await h.deliver(raw, { to: RIDGEWAY.address })).entered).toBe('filed')
}

describe('Claude reads the leads', () => {
  test('the board: the install’s stages and fields, then every lead with its stage, fields, person and when it came in, the open ones first', async () => {
    const h = harness()
    const jo = await sent(h, 'q1', { fields: { project: 'Tune-up', budget: '200' } })
    h.tick()
    const sam = await sent(h, 'q2', { name: 'Sam Ortiz', email: 'sam@else.example' })
    const res = await h.request(AGENT, 'GET', '/api/leads')
    expect(res.status).toBe(200)
    expect(res.json.stages.map((s: { id: string; settled: boolean }) => [s.id, s.settled])).toEqual([
      ['new', false],
      ['contacted', false],
      ['quoted', false],
      ['won', true],
      ['lost', true],
    ])
    expect(res.json.fields.map((f: { key: string }) => f.key)).toEqual(['project', 'budget', 'timeline', 'notes'])
    expect(res.json.more).toBe(false)
    expect(res.json.leads.map((l: InboxLead) => l.id)).toEqual([sam.id, jo.id])
    expect(res.json.leads[1]).toEqual(jo)
    expect(jo).toMatchObject({
      name: 'Jo Park',
      email: 'jo@home.example',
      stage: 'new',
      fields: { project: 'Tune-up', budget: '200' },
      source: SOURCE,
      requests: 1,
      rev: 0,
    })
    expect(typeof jo.createdAt).toBe('string')
    // The mailbox the leads belong to stays in the Worker, as it does for the page.
    expect(res.text).not.toContain(RIDGEWAY.address)
  })

  test('one person’s leads, and a contact that is not there is not found', async () => {
    const h = harness()
    const jo = await sent(h, 'q1')
    await sent(h, 'q2', { name: 'Sam Ortiz', email: 'sam@else.example' })
    const res = await h.request(AGENT, 'GET', `/api/contacts/${jo.contactId}/leads`)
    expect(res.status).toBe(200)
    expect(res.json.leads.map((l: InboxLead) => l.id)).toEqual([jo.id])
    expect(res.json.stages).toHaveLength(5)
    expect((await h.request(AGENT, 'GET', '/api/contacts/no-such-contact/leads')).status).toBe(404)
  })

  test('reading changes nothing: no row is written and nothing is audited', async () => {
    const h = harness()
    const jo = await sent(h, 'q1')
    const audited = count(h, 'audit')
    await h.request(AGENT, 'GET', '/api/leads')
    await h.request(AGENT, 'GET', `/api/contacts/${jo.contactId}/leads`)
    expect(count(h, 'audit')).toBe(audited)
    expect((await h.request(AGENT, 'GET', '/api/leads')).json.leads[0]).toEqual(jo)
  })
})

describe('Claude moves a lead', () => {
  test('to a declared stage, at the revision it read: recorded as Claude’s on the lead and in the audit', async () => {
    const h = harness()
    const jo = await sent(h, 'q1')
    const res = await h.request(AGENT, 'POST', `/api/leads/${jo.id}/move`, { rev: 0, stage: 'contacted' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ id: jo.id, stage: 'contacted', rev: 1, stageBy: `agent:${AGENT_ID}` })
    expect(
      h.db.query(`SELECT actor, subject FROM audit WHERE action = 'lead.move'`).all() as {
        actor: string
        subject: string
      }[],
    ).toEqual([{ actor: `agent:${AGENT_ID}`, subject: `lead:${jo.id}` }])
    // The owner's board shows the same lead, moved, and who moved it.
    const board = await h.space().leads(asker())
    expect((board as { value: { leads: InboxLead[] } }).value.leads[0]).toMatchObject({
      stage: 'contacted',
      stageBy: `agent:${AGENT_ID}`,
    })
  })

  test('the refusals are the person path’s: a stale revision, a stage the install does not declare, no revision, a lead that is not there; nothing moves', async () => {
    const h = harness()
    const jo = await sent(h, 'q1')
    const move = (id: string, body: unknown) => h.request(AGENT, 'POST', `/api/leads/${id}/move`, body)
    expect((await move(jo.id, { rev: 0, stage: 'contacted' })).status).toBe(200)
    expect((await move(jo.id, { rev: 0, stage: 'won' })).status).toBe(409)
    expect((await move(jo.id, { rev: 1, stage: 'maybe' })).status).toBe(422)
    expect((await move(jo.id, { rev: 1 })).status).toBe(422)
    expect((await move(jo.id, { stage: 'won' })).status).toBe(422)
    expect((await move(jo.id, { rev: '1', stage: 'won' })).status).toBe(422)
    expect((await move('no-such-lead', { rev: 1, stage: 'won' })).status).toBe(404)
    expect((await move('not an id', { rev: 1, stage: 'won' })).status).toBe(404)
    expect((await h.request(AGENT, 'POST', `/api/leads/${jo.id}/move`)).status).toBe(400)
    // To the stage it is in: no change, no revision, nothing audited.
    expect((await move(jo.id, { rev: 1, stage: 'contacted' })).json).toMatchObject({ stage: 'contacted', rev: 1 })
    expect(h.db.query(`SELECT count(*) AS n FROM audit WHERE action = 'lead.move'`).get()).toEqual({ n: 1 })
  })

  test('a move from a page on another site is refused, as every write at the door is', async () => {
    const h = harness()
    const jo = await sent(h, 'q1')
    const res = await h.request(
      AGENT,
      'POST',
      `/api/leads/${jo.id}/move`,
      { rev: 0, stage: 'won' },
      { origin: 'https://evil.example' },
    )
    expect(res.status).toBe(403)
    expect((await h.request(AGENT, 'GET', '/api/leads')).json.leads[0].stage).toBe('new')
  })

  test('nothing else of a lead is at the door: none is made, deleted or changed there', async () => {
    const h = harness()
    const jo = await sent(h, 'q1')
    for (const [method, path] of [
      ['POST', '/api/leads'],
      ['POST', '/api/lead-make'],
      ['POST', `/api/contacts/${jo.contactId}/leads`],
      ['PUT', `/api/leads/${jo.id}`],
      ['PATCH', `/api/leads/${jo.id}`],
      ['DELETE', `/api/leads/${jo.id}`],
      ['GET', `/api/leads/${jo.id}/move`],
    ] as const) {
      const body = method === 'GET' ? undefined : { contactId: jo.contactId, fields: {}, stage: 'won', rev: 0 }
      expect((await h.request(AGENT, method, path, body)).status, `${method} ${path}`).toBe(404)
    }
    expect(count(h, 'lead')).toBe(1)
    expect((await h.request(AGENT, 'GET', '/api/leads')).json.leads[0]).toEqual(jo)
  })
})

describe('Claude sees and moves no more than the owner', () => {
  test('a lead in a mailbox the owner is not on is not Claude’s either: not listed, and not found to move', async () => {
    const raw = northfieldJson()
    raw.people.push({ address: DANA, name: 'Dana', role: 'member' })
    for (const m of raw.cloudflareMailboxes) if (m.address === RIDGEWAY.address) m.people = [DANA]
    const install = createInstall(raw)
    const h = harness({ install }, { install, content: bundledContent, mailboxes: [RIDGEWAY] })
    await mailToTheLeadsMailbox(h)
    const jo = await sent(h, 'q1', { install })
    const space = h.space({ install })
    const seenBy = async (email: string) => {
      const got = await space.leads(asker({ email }, install))
      return (got as { value: { leads: InboxLead[] } }).value.leads.map((l) => l.id)
    }
    expect(await seenBy(DANA)).toEqual([jo.id])
    expect(await seenBy(OWNER_EMAIL)).toEqual([])
    expect((await h.request(AGENT, 'GET', '/api/leads')).json.leads).toEqual([])
    // The person has no mail, so they are the owner's to see; their lead is still not.
    expect((await h.request(AGENT, 'GET', `/api/contacts/${jo.contactId}/leads`)).json.leads).toEqual([])
    expect((await h.request(AGENT, 'POST', `/api/leads/${jo.id}/move`, { rev: 0, stage: 'won' })).status).toBe(404)
    expect(h.db.query(`SELECT stage, rev FROM lead`).all()).toEqual([{ stage: 'new', rev: 0 }])
  })

  test('where the owner is on the leads’ mailbox, Claude reads and moves what the owner does', async () => {
    const h = harness()
    await mailToTheLeadsMailbox(h)
    const jo = await sent(h, 'q1')
    expect((await h.request(AGENT, 'GET', '/api/leads')).json.leads.map((l: InboxLead) => l.id)).toEqual([jo.id])
    expect((await h.request(AGENT, 'POST', `/api/leads/${jo.id}/move`, { rev: 0, stage: 'won' })).status).toBe(200)
  })
})

describe('who does not get the leads', () => {
  test('an install without the leads switch answers each path as it answers any path it does not have, and nothing is written', async () => {
    const install = withoutLeads()
    const h = harness({ install }, { install, content: bundledContent })
    // Each beside a path the door has never had, of the same shape: the two answer alike, word for word.
    for (const [method, path, never] of [
      ['GET', '/api/leads', '/api/no-such-thing'],
      ['GET', '/api/contacts/c-1/leads', '/api/contacts/c-1/no-such-thing'],
      ['POST', '/api/leads/l-1/move', '/api/no-such-thing/l-1/move'],
    ] as const) {
      const body = method === 'GET' ? undefined : { rev: 0, stage: 'won' }
      const res = await h.request(AGENT, method, path, body)
      const unknown = await h.request(AGENT, method, never, body)
      expect([path, res.status, res.json]).toEqual([path, 404, unknown.json])
      expect(unknown.status).toBe(404)
    }
    expect((await h.request(AGENT, 'GET', '/api/leads')).json).toEqual({ error: 'Not found.' })
    expect(count(h, 'audit')).toBe(0)
    // Everything else at the door is as it was.
    expect((await h.request(AGENT, 'GET', '/api/queue')).status).toBe(200)
  })

  test('an install without the claudeScript switch admits no token to the leads, even Claude’s', async () => {
    const raw = northfieldJson()
    raw.switches.claudeScript = false
    delete raw.agent
    const install = createInstall(raw)
    const h = harness({ install }, { install, content: bundledContent })
    const jo = await sent(h, 'q1', { install })
    expect((await h.request(AGENT, 'GET', '/api/leads')).status).toBe(403)
    expect((await h.request(AGENT, 'POST', `/api/leads/${jo.id}/move`, { rev: 0, stage: 'won' })).status).toBe(403)
    expect(h.db.query(`SELECT stage, rev FROM lead`).all()).toEqual([{ stage: 'new', rev: 0 }])
  })

  test('a person at Claude’s door, the owner included, another token and no token are refused as on every route', async () => {
    const h = harness()
    const jo = await sent(h, 'q1')
    const move = { rev: 0, stage: 'won' }
    for (const who of [OWNER, STRANGER, { common_name: 'some-other-token.access' }, BRIDGE, TEXTS_BRIDGE]) {
      expect((await h.request(who, 'GET', '/api/leads')).status, JSON.stringify(who)).toBe(403)
      expect((await h.request(who, 'POST', `/api/leads/${jo.id}/move`, move)).status, JSON.stringify(who)).toBe(403)
    }
    expect((await h.request(null, 'GET', '/api/leads')).status).toBe(401)
    expect((await h.request(null, 'POST', `/api/leads/${jo.id}/move`, move)).status).toBe(401)
    expect(h.db.query(`SELECT stage, rev FROM lead`).all()).toEqual([{ stage: 'new', rev: 0 }])
  })

  test('the other machines’ doors gained nothing: neither bridge’s router has a leads route, for its own token or for Claude’s', async () => {
    const h = harness()
    const jo = await sent(h, 'q1')
    const move = { rev: 0, stage: 'won' }
    for (const path of ['/api/leads', `/api/contacts/${jo.contactId}/leads`]) {
      expect((await h.bridge(BRIDGE, path, undefined, { method: 'GET' })).status, path).toBe(404)
      expect((await h.texts(TEXTS_BRIDGE, path, undefined, { method: 'GET' })).status, path).toBe(404)
    }
    expect((await h.bridge(BRIDGE, `/api/leads/${jo.id}/move`, move)).status).toBe(404)
    expect((await h.texts(TEXTS_BRIDGE, `/api/leads/${jo.id}/move`, move)).status).toBe(404)
    expect((await h.bridge(AGENT, '/api/leads', undefined, { method: 'GET', audience: TELEGRAM_AUD })).status).toBe(403)
    expect((await h.texts(AGENT, '/api/leads', undefined, { method: 'GET', audience: TEXTS_AUD })).status).toBe(403)
    expect(h.db.query(`SELECT stage, rev FROM lead`).all()).toEqual([{ stage: 'new', rev: 0 }])
  })
})

describe('the script’s leads commands, through the space’s agent path', () => {
  const DOOR_URL = bundledInstall.agentDoor()?.url ?? 'no door'
  const parse = (r: { output: string }) => JSON.parse(r.output)

  function script(h: ReturnType<typeof harness>) {
    const door = throughSpace(h)
    const requests: string[] = []
    const io: CliIo = {
      env: { INBOX_URL: DOOR_URL, INBOX_ACCESS_CLIENT_ID: CLIENT_ID, INBOX_ACCESS_CLIENT_SECRET: CLIENT_SECRET },
      sopsKey: () => {
        throw new Error('sops must not be called when the env is set')
      },
      readInput: async (spec) => spec,
      fetch: (url, init) => {
        requests.push(`${init.method ?? 'GET'} ${new URL(url).pathname}`)
        return door.fetch(url, init)
      },
    }
    return { run: (...argv: string[]) => runCli(argv, io), requests }
  }

  test('leads, contact-leads and lead-move, end to end, each one request at the path under the door', async () => {
    const h = harness()
    const jo = await sent(h, 'q1', { fields: { project: 'Tune-up' } })
    const { run, requests } = script(h)
    const board = parse(await run('leads'))
    expect(board.stages[0]).toEqual({ id: 'new', label: 'New', settled: false })
    expect(board.leads).toEqual([jo])
    expect(parse(await run('contact-leads', jo.contactId)).leads).toEqual([jo])
    const moved = parse(await run('lead-move', jo.id, String(board.leads[0].rev), 'quoted'))
    expect(moved).toMatchObject({ stage: 'quoted', rev: 1, stageBy: `agent:${AGENT_ID}` })
    expect(parse(await run('audit')).map((a: { action: string }) => a.action)).toContain('lead.move')
    expect(requests.slice(0, 3)).toEqual([
      'GET /agent/inbox/api/leads',
      `GET /agent/inbox/api/contacts/${jo.contactId}/leads`,
      `POST /agent/inbox/api/leads/${jo.id}/move`,
    ])
  })

  test('a refusal comes back as a failing exit with its reason, and a move with no revision or no stage asks nothing', async () => {
    const h = harness()
    const jo = await sent(h, 'q1')
    const { run, requests } = script(h)
    const stale = await run('lead-move', jo.id, '7', 'won')
    expect([stale.exitCode, stale.output.includes('409')]).toEqual([1, true])
    const wrong = await run('lead-move', jo.id, '0', 'maybe')
    expect([wrong.exitCode, wrong.output.includes('422')]).toEqual([1, true])
    expect(wrong.output).toContain('not a stage')
    const asked = requests.length
    for (const argv of [['lead-move'], ['lead-move', jo.id], ['lead-move', jo.id, 'won'], ['lead-move', jo.id, '0']]) {
      const res = await run(...argv)
      expect([argv.length, res.exitCode, res.output.endsWith(USAGE)]).toEqual([argv.length, 1, true])
    }
    expect((await run('contact-leads')).exitCode).toBe(1)
    expect(requests).toHaveLength(asked)
    expect(h.db.query(`SELECT stage, rev FROM lead`).all()).toEqual([{ stage: 'new', rev: 0 }])
  })

  test('the usage lists the three, and no command that makes a lead', () => {
    expect(USAGE).toContain('\n  leads  ')
    expect(USAGE).toContain('\n  contact-leads <contact-id>')
    expect(USAGE).toContain('\n  lead-move <lead-id> <rev> <stage>')
    expect(USAGE).not.toMatch(/\n {2}(lead-make|make-lead|lead-delete)\b/)
  })
})
