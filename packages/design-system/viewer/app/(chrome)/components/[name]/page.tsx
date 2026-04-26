/**
 * /components/[name] — component showcase page.
 * Header block: component label + description.
 * Below the hairline: the showcase (full-bleed).
 *
 * Hero shows all 3 variants stacked with mono variant labels.
 * All other components render with their default props.
 */

import { notFound } from 'next/navigation'
import { Section, Container, Stack, Measure } from '@ds/index'
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
  PrimaryButton,
} from '@ds/index'

// ---- Showcase registry -------------------------------------------------------

interface Entry {
  label: string
  description: string
  Showcase: () => React.ReactNode
}

const REGISTRY: Record<string, Entry> = {
  header: {
    label: 'Header',
    description:
      'Sticky top navigation with wordmark, nav links, CTA, and theme toggle. Collapses to a mobile menu button below 720 px.',
    Showcase: () => <Header active="Manual" />,
  },
  hero: {
    label: 'Hero',
    description:
      'Three layout variants for the top-of-page moment. Display is full-width centred; asymmetric splits text and a text aside; quiet is a compact single-column.',
    Showcase: () => (
      <>
        <VariantLabel label="variant: display" />
        <Hero variant="display" />
        <VariantLabel label="variant: asymmetric" />
        <Hero variant="asymmetric" />
        <VariantLabel label="variant: quiet" />
        <Hero variant="quiet" />
      </>
    ),
  },
  manifesto: {
    label: 'Manifesto',
    description:
      'Numbered principles rendered with display-size numerals. Each item has a heading and a body paragraph.',
    Showcase: () => <Manifesto />,
  },
  editorial: {
    label: 'Editorial',
    description:
      'Two-column layout with a body column and a pull-quote column. The quote uses an accent left border.',
    Showcase: () => <Editorial />,
  },
  features: {
    label: 'Features',
    description:
      'Three-column feature grid. Each cell has a mono eyebrow, heading, and body. Hairline separates the columns.',
    Showcase: () => <Features />,
  },
  pricing: {
    label: 'Pricing',
    description:
      'Two-tier pricing table. The paid tier has an accent-coloured top border to distinguish it from the free tier.',
    Showcase: () => <Pricing />,
  },
  faq: {
    label: 'FAQ',
    description:
      'Accordion-style FAQ using the HTML <details> / <summary> pattern. Accent "+" marker rotates to "×" when open.',
    Showcase: () => <FAQ />,
  },
  newsletter: {
    label: 'Newsletter',
    description:
      'Email capture with inline success state. No external dependencies — controlled with local React state.',
    Showcase: () => <Newsletter />,
  },
  footer: {
    label: 'Footer',
    description:
      'Five-column footer that collapses to two columns then one. Mono section headings, muted link list, and a meta strip.',
    Showcase: () => <Footer />,
  },
  'primary-button': {
    label: 'PrimaryButton',
    description:
      'The one button style in Prose. Dark ink background, lightens to pure black on hover. Uses the prose-primary-button CSS class.',
    Showcase: () => (
      <Section>
        <Container>
          <Stack gap="md">
            <PrimaryButton>Get started</PrimaryButton>
            <PrimaryButton>Subscribe now</PrimaryButton>
          </Stack>
        </Container>
      </Section>
    ),
  },
}

// ---- Helper ------------------------------------------------------------------

function VariantLabel({ label }: { label: string }) {
  return (
    <div
      style={{
        borderTop: '1px solid var(--paper-3)',
        borderBottom: '1px solid var(--paper-3)',
        padding: 'var(--sp-3) var(--page-gutter)',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-xs)',
        letterSpacing: 'var(--tr-wide)',
        color: 'var(--ink-3)',
      }}
    >
      {label}
    </div>
  )
}

// ---- Route -------------------------------------------------------------------

interface Props {
  params: Promise<{ name: string }>
}

export function generateStaticParams() {
  return Object.keys(REGISTRY).map((name) => ({ name }))
}

export async function generateMetadata({ params }: Props) {
  const { name } = await params
  const entry = REGISTRY[name]
  return {
    title: entry ? `${entry.label} — Prose DS` : 'Not found — Prose DS',
  }
}

export default async function ComponentPage({ params }: Props) {
  const { name } = await params
  const entry = REGISTRY[name]
  if (!entry) notFound()

  return (
    <>
      {/* ---- Component header ---- */}
      <Section style={{ paddingBottom: 'var(--sp-9)' }}>
        <Container>
          <Stack gap="md">
            <Measure
              size="display"
              as="h1"
              style={{
                fontSize: 'clamp(2rem, 5vw, var(--fs-3xl))',
                lineHeight: 'var(--lh-tight)',
                letterSpacing: 'var(--tr-tighter)',
                fontWeight: 400,
              }}
            >
              {entry.label}
            </Measure>
            <Measure as="p" style={{ margin: 0 }}>
              {entry.description}
            </Measure>
          </Stack>
        </Container>
      </Section>

      {/* ---- Showcase (full-bleed) ---- */}
      <div style={{ borderTop: '1px solid var(--paper-3)' }}>
        <entry.Showcase />
      </div>
    </>
  )
}
