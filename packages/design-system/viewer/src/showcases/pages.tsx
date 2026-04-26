/**
 * Page showcase registry — used by /pages/[name].
 * Each Page is a full reference composition rendered into the Astro page.
 * `interactive: true` because the Prose composition includes Newsletter.
 */

import type { ReactNode } from 'react'
import {
  Header,
  Hero,
  Manifesto,
  Editorial,
  Features,
  Pricing,
  FAQ,
  Newsletter,
  Footer,
} from '@ds/index'

export interface PageEntry {
  label: string
  description: string
  interactive?: boolean
  Page: () => ReactNode
}

export const PAGE_REGISTRY: Record<string, PageEntry> = {
  prose: {
    label: 'Prose landing',
    description: 'Full Prose landing — all sections composed in sequence.',
    interactive: true,
    Page: () => (
      <>
        <Header active="Manual" />
        <main>
          <Hero variant="display" />
          <Manifesto />
          <Editorial />
          <Features />
          <Pricing />
          <FAQ />
          <Newsletter />
        </main>
        <Footer />
      </>
    ),
  },
}
