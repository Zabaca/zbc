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
              <Stack key={item.eyebrow} gap="sm" className="border-t border-ink-4 pt-5">
                <span className="eyebrow">{item.eyebrow}</span>
                <h3 className="text-xl leading-tight tracking-tight">{item.title}</h3>
                <p className="text-sm leading-[1.55] m-0 max-w-[32ch]">{item.body}</p>
              </Stack>
            ))}
          </Columns>
        </Stack>
      </Container>
    </Section>
  )
}
