'use client'

/**
 * FAQ.tsx — Q&A as <details>. Disclosure done in writing.
 * Accent "+" mark on each summary row.
 */

import { Section } from './Layout'
import { Container } from './Layout'
import { Stack } from './Layout'
import { Measure } from './Layout'

const ITEMS = [
  {
    q: 'Is this really just CSS?',
    a: 'Mostly. The stylesheet is the foundation; the UI kit adds a thin layer of React components for composition. You can ignore the React layer entirely and write semantic HTML — the type and rhythm will be there.',
  },
  {
    q: 'Can I add an image?',
    a: 'Yes. The system says no images, but the system also says to override the rules when you need to. A single full-bleed photograph at the start of a long essay is fine. Two of them is a different design system.',
  },
  {
    q: 'Why a serif?',
    a: "Because we're trying to evoke the register of a published essay, not a product brochure. Sans-serif works too; swap --font-text in the stylesheet and the rest of the system holds.",
  },
  {
    q: 'Does this work in dark mode?',
    a: "Yes. Add the .dark class to the html element (or any ancestor) to flip the system; without a setting, it defaults to light. Paper inverts to a deep ink-black, ink inverts to a warm off-white, and the accent shifts warmer + brighter so it still reads as a signal. There's a toggle in the header above.",
  },
  {
    q: 'Why is it called Prose?',
    a: 'Because the name should describe the thing. We considered Essay, Folio, and Margin. Prose won.',
  },
]

export function FAQ() {
  return (
    <Section id="faq">
      <Container>
        <Stack gap="2xl">
          <Stack gap="md">
            <span className="eyebrow">Frequently asked</span>
            <Measure size="display" as="h2">
              Questions you might reasonably have.
            </Measure>
          </Stack>

          <Measure size="wide">
            {ITEMS.map((item, i) => (
              <details
                key={i}
                style={{
                  borderTop: '1px solid var(--color-ink-4)',
                  padding: 'var(--spacing-5) 0',
                }}
              >
                <summary
                  style={{
                    cursor: 'pointer',
                    fontFamily: 'var(--font-display)',
                    fontSize: 'var(--text-xl)',
                    lineHeight: 'var(--leading-snug)',
                    letterSpacing: 'var(--tracking-tight)',
                    color: 'var(--color-ink-0)',
                    listStyle: 'none',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 'var(--spacing-4)',
                  }}
                >
                  <span>{item.q}</span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--text-sm)',
                      color: 'var(--color-accent)',
                      flexShrink: 0,
                    }}
                  >
                    +
                  </span>
                </summary>
                <Measure as="p" style={{ marginTop: 'var(--spacing-4)' }}>
                  {item.a}
                </Measure>
              </details>
            ))}
          </Measure>
        </Stack>
      </Container>
    </Section>
  )
}
