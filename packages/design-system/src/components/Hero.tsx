/**
 * Hero.tsx — three variants:
 *   "display"     — centered, single big headline, optional period accent
 *   "asymmetric"  — display left, lede right, on different baselines
 *   "quiet"       — small eyebrow, modest h1, narrow lede
 */

import { Section } from './Layout'
import { Container } from './Layout'
import { Stack } from './Layout'
import { Measure } from './Layout'
import { Columns } from './Layout'
import { PrimaryButton } from './PrimaryButton'

export type HeroVariant = 'display' | 'asymmetric' | 'quiet'

export interface HeroProps {
  variant?: HeroVariant
}

export function Hero({ variant = 'display' }: HeroProps) {
  if (variant === 'display') {
    return (
      <Section id="top">
        <Container>
          <Stack gap="xl">
            <span className="eyebrow">Issue 01 — A text-only design system</span>
            <Measure
              size="display"
              as="h1"
              className="leading-display tracking-tightest font-normal"
              style={{ fontSize: 'clamp(3rem, 9vw, 8.5rem)' }}
            >
              A landing page is a piece of{' '}
              <em>
                writing<span className="text-accent not-italic">.</span>
              </em>
            </Measure>
            <Measure size="wide" as="p" className="lede">
              We made a design system that admits this and stops pretending otherwise. No
              screenshots. No icons. No illustrations. Just words, set well, with enough room around
              them to breathe.
            </Measure>
            <div className="flex flex-wrap gap-5 items-center">
              <PrimaryButton>Read the manual</PrimaryButton>
              <a href="#examples" className="font-ui text-sm font-medium text-ink-0">
                See examples →
              </a>
            </div>
          </Stack>
        </Container>
      </Section>
    )
  }

  if (variant === 'asymmetric') {
    return (
      <Section>
        <Container>
          <Columns count={2} ratio="2:1" gap="2xl" align="end">
            <Measure
              size="display"
              as="h1"
              className="leading-display tracking-tightest font-normal m-0"
              style={{ fontSize: 'clamp(2.5rem, 7vw, 5rem)' }}
            >
              The page does the <em>reading</em> for you.
            </Measure>
            <p className="font-text text-md leading-prose text-ink-1 m-0">
              A reader scans for shape before they read for sense. We arranged the shapes so the
              sense lands first.
            </p>
          </Columns>
        </Container>
      </Section>
    )
  }

  // quiet
  return (
    <Section>
      <Container>
        <Stack gap="md">
          <span className="eyebrow eyebrow-accent">Now in beta</span>
          <Measure
            size="display"
            as="h1"
            className="text-3xl leading-tight tracking-tighter font-normal"
          >
            Send an invoice. Get paid.
          </Measure>
          <Measure as="p" className="font-text text-lg leading-normal text-ink-1">
            We made the simplest tool we could and stopped there.
          </Measure>
          <a href="#" className="font-ui text-sm font-medium">
            Read the rest →
          </a>
        </Stack>
      </Container>
    </Section>
  )
}
