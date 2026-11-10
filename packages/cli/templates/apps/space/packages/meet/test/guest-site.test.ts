import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GENERIC_SITE, SignedInSite, SiteContext } from '../src/web/site'
import { Privacy } from '../src/web/workspace/Panels'

/**
 * A signed-in guest's screens word whose workspace it is from the bootstrap they were given, not from the public `GET /w/api/site` (a screen nobody is signed in to asks that, and it can be slow or fail). The privacy
 * notice is the one that showed it: told nothing, it said "The company runs meet".
 */
const privacy = () => createElement(Privacy, { onClose: () => undefined, owner: { name: 'Ada', address: 'ada@brightwater.example' } })
const BOOTSTRAP_SITE = { company: 'Brightwater Builders', owner: { name: 'Ada', address: 'ada@brightwater.example' } }

describe('a signed-in guest’s privacy notice', () => {
  test('names the company the bootstrap gave, even when the public answer never came', () => {
    const page = renderToStaticMarkup(createElement(SiteContext.Provider, { value: GENERIC_SITE }, createElement(SignedInSite, { site: BOOTSTRAP_SITE }, privacy())))
    expect(page).toContain('Brightwater Builders runs meet on Cloudflare')
    expect(page).toContain('Brightwater Builders people can see who is in the channels they are in')
    expect(page).not.toContain('The company runs meet')
    expect(page).not.toContain('The people who run this workspace')
  })

  test('the bootstrap’s company wins over a different public one, and the public one stands only until the bootstrap arrives', () => {
    const asked = { company: 'Somebody Else', owner: { name: 'Eve' } }
    const wins = renderToStaticMarkup(createElement(SiteContext.Provider, { value: asked }, createElement(SignedInSite, { site: BOOTSTRAP_SITE }, privacy())))
    expect(wins).toContain('Brightwater Builders runs meet on Cloudflare')
    expect(wins).not.toContain('Somebody Else')
    const before = renderToStaticMarkup(createElement(SiteContext.Provider, { value: asked }, createElement(SignedInSite, { site: null }, privacy())))
    expect(before).toContain('Somebody Else runs meet on Cloudflare')
  })
})
