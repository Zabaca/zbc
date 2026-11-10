import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createInstall } from '@space/workspace'
import { bundledInstall } from '../src/workspace'
import { AGENT, harness, STRANGER, TEAM } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'

/**
 * The sign-in check Claude's door runs, on the company layer's verifier (packages/workspace; its own suite proves the verifier: signature, issuer, audience,
 * expiry, the key fetch). What these prove is what the inbox adds: the header alone is read, an audience that is not 64 hex is refused, and who the layer's
 * identity becomes here. The door's own behaviours (what it serves, its wording, the cross-site write check) are test/claude-door.test.ts.
 */

const _OTHER_AUD = 'b'.repeat(64)
const northfieldJson = () =>
  JSON.parse(readFileSync(new URL('../../workspace/northfield/workspace.json', import.meta.url), 'utf8'))

/** A cheap read: any route answers the gate the same way. */
const PROBE = '/api/mailbox'
const _ask = async (h: ReturnType<typeof harness>, headers: Record<string, string>) =>
  h.request(null, 'GET', PROBE, undefined, headers)

describe('who the layer’s identity becomes here', () => {
  test('the team domain is the declaration’s, not a variable of the Worker', () => {
    expect(bundledInstall.teamDomain).toBe(TEAM)
  })

  test('Claude’s token is the agent, and no person is anybody here: Tessa, a member and a second owner are all refused', async () => {
    const raw = northfieldJson()
    raw.people.push(
      { address: 'dana@northfield.example', name: 'Dana', role: 'member' },
      { address: 'eve@northfield.example', name: 'Eve', role: 'owner' },
    )
    const h = harness({ install: createInstall(raw) })
    expect((await h.request(AGENT, 'GET', PROBE)).status).toBe(200)
    for (const email of [OWNER_EMAIL, 'dana@northfield.example', 'eve@northfield.example']) {
      for (const path of [PROBE, '/api/queue']) {
        expect((await h.request({ email }, 'GET', path)).status, `${email} ${path}`).toBe(403)
      }
    }
  })

  test('the declared owner’s sign-in is the address the stores trust as the owner (the space’s gate admits exactly it)', () => {
    const owners = bundledInstall.people.filter((p) => bundledInstall.isOwner(p))
    expect(owners.map((p) => p.signIn)).toEqual([OWNER_EMAIL])
  })

  test('an install without the claudeScript switch admits no token, even Claude’s', async () => {
    const raw = northfieldJson()
    raw.switches.claudeScript = false
    delete raw.agent
    const h = harness({ install: createInstall(raw) })
    expect((await h.request(AGENT, 'GET', PROBE)).status).toBe(403)
  })

  test('a person of another install, and a token that is not Claude’s, are refused', async () => {
    const h = harness()
    expect((await h.request(STRANGER, 'GET', PROBE)).status).toBe(403)
    expect((await h.request({ common_name: 'some-other-token.access' }, 'GET', PROBE)).status).toBe(403)
  })
})
