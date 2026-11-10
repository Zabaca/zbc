// The owner is the install's, in meet's words: who can archive another person's channel and who can delete a person is the install's owner, named by the install and not written in. Northfield's words are
// held by the suites that run on Northfield's declaration (space-channels.test.ts); this one runs the same two refusals on an invented company and proves nothing of Northfield's is said.
import { describe, expect, test } from 'bun:test'
import { createInstall, type MeetChannelChange, type SignedIn } from '@space/workspace'
import { type SpaceMeetDeps, spaceMeet } from '../src/space-meet'
import { harness, signedAs } from './helpers'
import { actors } from './workspace.helpers'

const BRIGHTWATER = createInstall({
  company: { id: 'brightwater', name: 'Brightwater Marine Services', domain: 'brightwater.example', timeZone: 'America/Los_Angeles' },
  access: { teamDomain: 'brightwater.cloudflareaccess.com' },
  formsService: { contact: 'help@example.test' },
  space: { host: 'space.brightwater.example', sessionDuration: '730h' },
  people: [
    { address: 'priya@brightwater.example', name: 'Priya', mailName: 'Priya Raman', role: 'owner' },
    { address: 'omar@brightwater.example', name: 'Omar', role: 'member' },
    { address: 'dana@brightwater.example', name: 'Dana', role: 'member' },
  ],
})
const PRIYA = 'priya@brightwater.example'
const OMAR = 'omar@brightwater.example'
const DANA = 'dana@brightwater.example'
const GUEST = 'sam@harbor.example'

async function setup() {
  const h = await harness({ devBypass: false, install: BRIGHTWATER })
  const a = actors(h)
  const deps: SpaceMeetDeps = {
    install: h.deps.install,
    workspace: h.deps.workspace,
    room: h.deps.room,
    ledger: h.deps.ledger,
    appOrigin: h.deps.appOrigin,
    mailer: h.deps.mailer,
    now: () => h.clock.now,
    randomBytes: h.deps.randomBytes,
  }
  const meet = spaceMeet(deps)
  const as = async (email: string): Promise<SignedIn> => signedAs(h.deps.install, email, Math.floor(h.clock.now / 1000) + 3600)
  let n = 0
  const key = (what: string) => `${what}-${++n}`.replace(/[^A-Za-z0-9_-]/g, '-').padEnd(24, 'x')
  return { h, a, meet, as, key, change: async (by: string, c: MeetChannelChange) => meet.changeChannel(await as(by), c) }
}

const refusal = (r: unknown) => r as { ok: false; kind: string; reason: string; message: string }

describe('what meet says the owner alone can do, on another company’s install', () => {
  test('archiving another person’s channel, and deleting a person, name the install’s owner', async () => {
    const s = await setup()
    // Omar makes a channel; Dana, a member who did not make it, may not archive it; the refusal names the owner the install has.
    const made = await s.meet.createChannel(await s.as(OMAR), { key: s.key('make'), name: 'dock', privacy: 'open' })
    expect(made).toMatchObject({ ok: true })
    const conversationId = (made as { value: { conversationId: number } }).value.conversationId
    expect(await s.change(DANA, { do: 'join', conversationId })).toMatchObject({ ok: true })
    const archive = refusal(await s.change(DANA, { do: 'archive', conversationId }))
    expect(archive).toMatchObject({ reason: 'not-admitted', message: 'Only the person who made a channel, or Priya, can archive it.' })

    // A guest invited to the channel is not a teammate: a member may not delete them from the workspace; only the owner may, and the refusal says who.
    const invited = await s.meet.inviteGuest(await s.as(OMAR), { key: s.key('invite'), conversationId, name: 'Sam Ortiz', address: GUEST } as never)
    expect(invited).toMatchObject({ ok: true })
    const personId = (invited as { value: { person: { id: string } } }).value.person.id
    const deleted = refusal(await s.change(DANA, { do: 'delete-person', conversationId, personId }))
    expect(deleted).toMatchObject({ reason: 'not-admitted', message: 'Only Priya can delete a person.' })
    for (const r of [archive, deleted]) expect(r.message).not.toMatch(/tessa|northfield/i)

    // The owner can.
    expect(await s.change(PRIYA, { do: 'join', conversationId })).toMatchObject({ ok: true })
    expect(await s.change(PRIYA, { do: 'archive', conversationId })).toMatchObject({ ok: true })
  })
})
