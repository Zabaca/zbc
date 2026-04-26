/**
 * Features.tsx — three-column hairline-separated row.
 * Not "feature cards" — three short paragraphs sitting side by side.
 */

import { Section } from './Layout'
import { Container } from './Layout'
import { Stack } from './Layout'
import { Measure } from './Layout'
import { Columns } from './Layout'

const ITEMS = [
  {
    eyebrow: 'Setup',
    title: 'One stylesheet.',
    body: 'Drop colors_and_type.css into your <head>. The semantic element styles cascade onto plain HTML; you can ship a page without writing any new CSS.',
  },
  {
    eyebrow: 'Components',
    title: 'Eight sections.',
    body: "Header, hero, manifesto, editorial, features, pricing, FAQ, footer. Compose them. Reorder them. Drop the ones you don't need.",
  },
  {
    eyebrow: 'Convictions',
    title: 'Ten rules, written down.',
    body: 'Read the manual once. The rules are short and the reasoning is in the README. Override them when you need to — but know which one you broke.',
  },
]

export function Features() {
  return (
    <Section id="examples">
      <Container>
        <Stack gap="3xl">
          <Measure size="display" as="h2">
            Everything you need, nothing you don't.
          </Measure>
          <Columns count={3} gap="xl">
            {ITEMS.map((item) => (
              <Stack
                key={item.eyebrow}
                gap="sm"
                style={{
                  borderTop: '1px solid var(--color-ink-4)',
                  paddingTop: 'var(--spacing-5)',
                }}
              >
                <span className="eyebrow">{item.eyebrow}</span>
                <h3
                  style={{
                    fontSize: 'var(--text-xl)',
                    lineHeight: 'var(--leading-tight)',
                    letterSpacing: 'var(--tracking-tight)',
                  }}
                >
                  {item.title}
                </h3>
                <p
                  style={{
                    fontSize: 'var(--text-sm)',
                    lineHeight: 1.55,
                    margin: 0,
                    maxWidth: '32ch',
                  }}
                >
                  {item.body}
                </p>
              </Stack>
            ))}
          </Columns>
        </Stack>
      </Container>
    </Section>
  )
}
