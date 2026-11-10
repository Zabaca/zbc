// The emails meet sends to Northfield Works people name the space's Meet tab, and the guests' page links to it: no email or page names an address of meet's own (meet.northfield.example was removed at the
// cutover, and /start was gone before it). The address is the install's.
import { describe, expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'
import { createInstall } from '@space/workspace'
import lane from '../../workspace/test/fixtures/pinecrest.json'
import { northfield } from '../../workspace/test/helpers'
import { createElement } from 'react'
import { SPACE_MEET_PATH, SiteContext } from '../src/web/site'
import Home from '../src/web/Home'
import { emergencyEmail, nudgeEmail, voicemailEmail } from '../src/mail'
import { BUNDLED_INSTALL as NORTHFIELD } from '../src/company'
import { OWNER } from './helpers'

const SPACE = 'https://space.northfield.example/meet'

describe('the emails name the space', () => {
  const due = (kind: 'teammate' | 'guest') => ({ person: 'p1', email: kind === 'teammate' ? OWNER : 'gus@client.test', kind, total: 2, senders: [{ name: 'Ana', count: 2 }] }) as never

  test('the nudge: a Northfield Works person is sent to Meet, a guest to the guests’ /w/', () => {
    const team = nudgeEmail(due('teammate'), 'https://space.northfield.example', NORTHFIELD).text
    expect(team).toContain(`Read them at ${SPACE}\n`)
    expect(team).not.toContain('/start')
    expect(team).not.toContain('meet.northfield.example')
    const guest = nudgeEmail(due('guest'), 'https://space.northfield.example', NORTHFIELD).text
    expect(guest).toContain('Read them at https://space.northfield.example/w/\n')
  })

  test('the voicemail and the 911 notice send to the Phone conversation in the space', () => {
    const voicemail = voicemailEmail(OWNER, '+1 626 555 0100', 42, NORTHFIELD).text
    expect(voicemail).toContain(`Listen to it at ${SPACE}/phone,`)
    expect(voicemail).not.toContain('/start')
    const notice = emergencyEmail({ name: 'Ana', email: 'ana@northfield.example', address: '1 Main St', at: Date.UTC(2026, 10, 3, 12, 0) } as never, NORTHFIELD, OWNER).text
    expect(notice).toContain(`${SPACE}/phone`)
    expect(notice).not.toContain('/start')
  })

  test('another company’s emails name its own space', () => {
    const other = createInstall(lane)
    expect(nudgeEmail(due('teammate'), 'https://space.pinecrest.test', other).text).toContain('https://space.pinecrest.test/meet')
    expect(voicemailEmail('lane@pinecrest.test', '+1 626 555 0100', 5, other).text).toContain('https://space.pinecrest.test/meet/phone')
  })

  test('the guests’ home page links to the space’s Meet tab on its own host (the tab’s path is the declaration layer’s) and not to /start, and names the company it was told of', () => {
    const page = renderToStaticMarkup(Home())
    expect(page).not.toContain('/start')
    expect(page).toContain(`href="${SPACE_MEET_PATH}"`)
    expect(page).toContain('href="/w"')
    expect(SPACE_MEET_PATH).toBe(northfield().tabPath('meet'))
    expect(SPACE).toBe(`https://${northfield().declaration.space.host}${SPACE_MEET_PATH}`)
    // Told whose workspace it is, the page says so; told nothing, it names no company.
    const told = renderToStaticMarkup(createElement(SiteContext.Provider, { value: { company: 'Northfield Works', owner: { name: 'Tessa' } } }, createElement(Home)))
    expect(told).toContain('Northfield Works people work in')
    expect(renderToStaticMarkup(createElement(SiteContext.Provider, { value: { company: 'Pinecrest', owner: { name: 'Corin' } } }, createElement(Home)))).not.toContain('Northfield Works')
    expect(page).not.toContain('Northfield Works')
  })
})
