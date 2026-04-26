/**
 * DS viewer index — brief orientation, nothing more.
 * The sidebar carries the navigation load.
 * Just: display headline, one-paragraph lede, one start link.
 */

import Link from 'next/link'
import { Section, Container, Stack } from '@ds/index'

export default function DSIndex() {
  return (
    <Section style={{ paddingBottom: 'var(--sp-9)' }}>
      <Container>
        <Stack gap="lg">
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'clamp(2rem, 5vw, var(--fs-3xl))',
              lineHeight: 'var(--lh-tight)',
              letterSpacing: 'var(--tr-tighter)',
              color: 'var(--ink-0)',
              fontWeight: 400,
              margin: 0,
              maxWidth: 'var(--measure-display)',
            }}
          >
            Prose design system viewer
          </h1>

          <p
            style={{
              fontFamily: 'var(--font-text)',
              fontSize: 'var(--fs-md)',
              lineHeight: 'var(--lh-prose)',
              color: 'var(--ink-1)',
              maxWidth: 'var(--measure-prose)',
              margin: 0,
            }}
          >
            A text-only design system. Browse the foundations to see tokens, components for
            primitives, and pages for full reference compositions.
          </p>

          <Link
            href="/foundations/colors"
            style={{
              fontFamily: 'var(--font-ui)',
              fontSize: 'var(--fs-sm)',
              color: 'var(--ink-1)',
              textDecoration: 'underline',
              textDecorationColor: 'var(--accent)',
              textUnderlineOffset: '0.18em',
              textDecorationThickness: '1px',
            }}
          >
            Start with Colors →
          </Link>
        </Stack>
      </Container>
    </Section>
  )
}
