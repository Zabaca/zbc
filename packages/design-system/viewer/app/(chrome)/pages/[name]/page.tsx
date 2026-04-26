/**
 * /pages/[name] — full-page references shown inside the viewer chrome.
 * The DS shell bar sits above the page (breadcrumb + dark/light toggle).
 * The .with-ds-shell class on the shell wrapper offsets any sticky prose-header.
 */

import { notFound } from 'next/navigation'
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

// ---- Page registry ---------------------------------------------------------

interface PageEntry {
  label: string
  description: string
  Page: () => React.ReactNode
}

const PAGES: Record<string, PageEntry> = {
  prose: {
    label: 'Prose landing',
    description: 'Full Prose landing — all sections composed in sequence.',
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

// ---- Route -----------------------------------------------------------------

interface Props {
  params: Promise<{ name: string }>
}

export function generateStaticParams() {
  return Object.keys(PAGES).map((name) => ({ name }))
}

export async function generateMetadata({ params }: Props) {
  const { name } = await params
  const entry = PAGES[name]
  return {
    title: entry ? `${entry.label} — Prose DS` : 'Not found — Prose DS',
  }
}

export default async function PageReference({ params }: Props) {
  const { name } = await params
  const entry = PAGES[name]
  if (!entry) notFound()

  return <entry.Page />
}
