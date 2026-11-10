// Where a call link points, and whose workspace a guest's page is in.
//
// A call link is `<the space's address>/r/<name>`, a path the space opens to anyone with no sign-in (the space's ADR 0018). Meet's pages are served only on the space's host (there is no other address
// for them: no workers.dev, no preview, and the old meet host is gone), so the address a page is opened at IS the install's. The page is built once for every install and holds no host of its own: it
// takes its origin from where it is, and its words about whose workspace it is from the guests' API (`GET /w/api/site`, and the bootstrap), which the install answers.

import { createContext, createElement, type ReactNode, useContext, useEffect, useState } from 'react'
import { GUEST_API } from '../model'
import type { PublicSite } from '../workspace-model'

/** The origin a call link is built on and recognised from, for a page at `page`: the page's own, which is the space's. */
export function siteOrigin(page: { origin: string } = window.location): string {
  return page.origin
}

/** The link to a call: what is shown, copied, and put in an email or a message. */
export function callLink(name: string, page?: { origin: string }): string {
  return `${siteOrigin(page)}/r/${name}`
}

/** Where the install's people work: the space's Meet tab, on the same host as the guest's page. */
export const SPACE_MEET_PATH = '/meet'

/** Before the page has heard who it is for (and in a bare component with no page around it), it says nothing of any company. */
export const GENERIC_SITE: PublicSite = { company: '', owner: { name: 'the owner' } }

/** "Northfield people": the install's people as the pages call them, or the plain words when the company is not known. */
export const peopleOf = (site: PublicSite): string => (site.company === '' ? 'The people who run this workspace' : `${site.company} people`)

export const SiteContext = createContext<PublicSite>(GENERIC_SITE)
export const useSite = (): PublicSite => useContext(SiteContext)

/**
 * What a signed-in screen says about whose workspace it is: the `site` its own bootstrap carries (the answer a signed-in guest was given, which names the company and the owner), not the public `GET /w/api/site`, which a
 * screen nobody is signed in to asks and which can be slow or fail, leaving "The company runs meet" in a privacy notice. The public answer stands only until the bootstrap arrives.
 */
export function SignedInSite({ site, children }: { site: PublicSite | null; children?: ReactNode }) {
  const asked = useSite()
  return createElement(SiteContext.Provider, { value: site ?? asked }, children)
}

/** The company's and the owner's names for the pages nobody is signed in to, asked once; the generic words until they come, and after a failure. */
export function useGuestSite(): PublicSite {
  const [site, setSite] = useState<PublicSite>(GENERIC_SITE)
  useEffect(() => {
    let live = true
    void fetch(`${GUEST_API}/site`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<PublicSite>) : null))
      .then((s) => {
        if (live && s && typeof s.company === 'string' && typeof s.owner?.name === 'string') setSite(s)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  return site
}
