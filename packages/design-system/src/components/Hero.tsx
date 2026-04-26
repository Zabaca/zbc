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
              style={{
                fontSize: 'clamp(3rem, 9vw, 8.5rem)',
                lineHeight: 'var(--lh-display)',
                letterSpacing: 'var(--tr-tightest)',
                fontWeight: 400,
              }}
            >
              A landing page is a piece of{' '}
              <em>
                writing<span style={{ color: 'var(--accent)', fontStyle: 'normal' }}>.</span>
              </em>
            </Measure>
            <Measure size="wide" as="p" className="lede">
              We made a design system that admits this and stops pretending otherwise. No
              screenshots. No icons. No illustrations. Just words, set well, with enough room around
              them to breathe.
            </Measure>
            <div
              style={{
                display: 'flex',
                gap: 'var(--sp-5)',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <PrimaryButton>Read the manual</PrimaryButton>
              <a
                href="#examples"
                style={{
                  fontFamily: 'var(--font-ui)',
                  fontSize: 'var(--fs-sm)',
                  fontWeight: 500,
                  color: 'var(--ink-0)',
                }}
              >
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
              style={{
                fontSize: 'clamp(2.5rem, 7vw, 5rem)',
                lineHeight: 'var(--lh-display)',
                letterSpacing: 'var(--tr-tightest)',
                margin: 0,
                fontWeight: 400,
              }}
            >
              The page does the <em>reading</em> for you.
            </Measure>
            <p
              style={{
                fontFamily: 'var(--font-text)',
                fontSize: 'var(--fs-md)',
                lineHeight: 'var(--lh-prose)',
                color: 'var(--ink-1)',
                margin: 0,
              }}
            >
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
          <span className="eyebrow eyebrow--accent">Now in beta</span>
          <Measure
            size="display"
            as="h1"
            style={{
              fontSize: 'var(--fs-3xl)',
              lineHeight: 'var(--lh-tight)',
              letterSpacing: 'var(--tr-tighter)',
              fontWeight: 400,
            }}
          >
            Send an invoice. Get paid.
          </Measure>
          <Measure
            as="p"
            style={{
              fontFamily: 'var(--font-text)',
              fontSize: 'var(--fs-lg)',
              lineHeight: 'var(--lh-normal)',
              color: 'var(--ink-1)',
            }}
          >
            We made the simplest tool we could and stopped there.
          </Measure>
          <a
            href="#"
            style={{
              fontFamily: 'var(--font-ui)',
              fontSize: 'var(--fs-sm)',
              fontWeight: 500,
            }}
          >
            Read the rest →
          </a>
        </Stack>
      </Container>
    </Section>
  )
}
