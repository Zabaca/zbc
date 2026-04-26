/**
 * Component showcase registry — used by /components/[name].
 * Each entry's Showcase is a React component rendered into the Astro page.
 * `interactive: true` is the signal to wrap with `client:load` on the Astro side.
 */

import type { ReactNode } from 'react'
import {
  Section,
  Container,
  Stack,
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

export interface ComponentEntry {
  label: string
  description: string
  interactive?: boolean
  Showcase: () => ReactNode
}

function VariantLabel({ label }: { label: string }) {
  return (
    <div
      style={{
        borderTop: '1px solid var(--color-paper-3)',
        borderBottom: '1px solid var(--color-paper-3)',
        padding: 'var(--spacing-3) var(--page-gutter)',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
        letterSpacing: 'var(--tracking-wide)',
        color: 'var(--color-ink-3)',
      }}
    >
      {label}
    </div>
  )
}

export const COMPONENT_REGISTRY: Record<string, ComponentEntry> = {
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
    interactive: true,
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
    description: 'The one button style in Prose. Ink-0 background, warms to the accent on hover.',
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
