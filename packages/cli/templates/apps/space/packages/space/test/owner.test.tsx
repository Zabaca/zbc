// The owner is the install's: what the page is told about them (GET /api/me), and the screens that name them. Northfield's words are held by the suites that run on Northfield's declaration
// (settings.test.tsx, knowledge-view.test.tsx, app.test.ts); this one runs the same screens in an invented company's shell and proves nothing of Northfield's, and nobody's, is in them.
import { describe, expect, test } from 'bun:test'
import { createInstall } from '@space/workspace'
import { renderToStaticMarkup } from 'react-dom/server'
import { northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { OwnerContext } from '../src/client/owner'
import { ClaudeSendingPanel, MailboxCard } from '../src/client/Settings'
import { fixtureViews } from '../src/fixture-views'

const BRIGHTWATER = createInstall({
  company: { id: 'brightwater', name: 'Brightwater Marine Services', domain: 'brightwater.example', timeZone: 'America/Los_Angeles' },
  access: { teamDomain: 'brightwater.cloudflareaccess.com' },
  formsService: { contact: 'help@example.test' },
  space: { host: 'space.brightwater.example', sessionDuration: '730h' },
  people: [
    { address: 'priya@brightwater.example', name: 'Priya', mailName: 'Priya Raman', signIn: 'priya.private@mail.example', role: 'owner' },
    { address: 'omar@brightwater.example', name: 'Omar', role: 'member' },
  ],
})
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
const noop = () => undefined
const NORTHFIELD = /tessa|northfield/i

const inShellOf = (me: ReturnType<typeof meOf>, node: React.ReactNode) =>
  renderToStaticMarkup(<OwnerContext.Provider value={me.owner}>{node}</OwnerContext.Provider>)

describe('what the page is told of the owner', () => {
  test('the install’s first owner: their short name and their address, for Northfield’s and for another company’s', () => {
    expect(meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield()).owner).toEqual({ name: 'Tessa', address: 'tessa@northfield.example' })
    // The member who signs in is told who the owner is, and is not the owner.
    const omar = meOf({ address: 'omar@brightwater.example', name: 'Omar' }, BRIGHTWATER)
    expect(omar.owner).toEqual({ name: 'Priya', address: 'priya@brightwater.example' })
    expect(omar.address).toBe('omar@brightwater.example')
  })
})

describe('the screens that name the owner, in another company’s shell', () => {
  const me = meOf({ address: 'priya@brightwater.example', name: 'Priya' }, BRIGHTWATER)

  test('Claude’s sending says it goes out from the owner’s address', () => {
    const on = inShellOf(me, <ClaudeSendingPanel state={{ enabled: true, changedAt: NOW }} busy={false} asking={false} onChange={noop} onAsk={noop} onCancel={noop} />)
    expect(on).toContain('stored in the inbox from priya@brightwater.example')
    expect(on).not.toMatch(NORTHFIELD)
  })

  test('a switch the owner flipped says "you", and one flipped by somebody else says who', () => {
    const view = fixtureViews(NOW)
    const box = view.mailboxes[0] as (typeof view.mailboxes)[number]
    const byOwner = { ...box, spamCheck: { ...box.spamCheck, changedBy: 'priya@brightwater.example' } }
    const byOther = { ...box, spamCheck: { ...box.spamCheck, changedBy: 'agent:claude' } }
    const draw = (b: typeof box) => inShellOf(me, <MailboxCard box={b} assistantKey now={NOW} busy={false} onSwitch={noop} />)
    expect(draw(byOwner)).toContain('Switched by you')
    expect(draw(byOther)).toContain('Switched by Claude')
    // Northfield's address is nobody's in this shell.
    const northfieldAddress = { ...box, spamCheck: { ...box.spamCheck, changedBy: 'tessa@northfield.example' } }
    expect(draw(northfieldAddress)).toContain('Switched by tessa@northfield.example')
  })
})
