/**
 * Manifesto.tsx — big numbered list; the rhetorical workhorse.
 * Quiet background (paper-1). Numbered items with display numerals.
 * First numeral is accent; the rest are ink-3.
 */

import { Section } from './Layout'
import { Container } from './Layout'
import { Stack } from './Layout'
import { Measure } from './Layout'
import { Columns } from './Layout'

const TENETS = [
  {
    n: '01',
    t: 'Write the page first.',
    b: 'Open a text file. Write what you want to say. Don’t open Figma. The page is words; everything else is arrangement.',
  },
  {
    n: '02',
    t: 'Cut a third of it.',
    b: 'Half is too aggressive on the first pass. A third is right. Save what you cut for a future page or for nothing.',
  },
  {
    n: '03',
    t: 'Set the longest line in 78 characters or fewer.',
    b: 'Anything longer reads as a wall. Anything much shorter reads as poetry, which is fine if you mean it.',
  },
  {
    n: '04',
    t: 'Use one accent color and use it three times.',
    b: 'A link underline. A blockquote rule. A period at the end of the closing line. That is enough.',
  },
  {
    n: '05',
    t: 'Leave more space than feels comfortable.',
    b: 'Then leave a little more. The space between sections is where the reader takes a breath. A page without breath is a page nobody finishes.',
  },
]

export function Manifesto() {
  return (
    <Section id="manifesto" tone="quiet">
      <Container>
        <Stack gap="3xl">
          <Stack gap="lg">
            <span className="eyebrow">Five tenets</span>
            <Measure size="display" as="h2">
              The discipline of leaving things out.
            </Measure>
          </Stack>
          <Stack gap="xl" as="ol" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {TENETS.map((tenet, i) => (
              <li
                key={tenet.n}
                style={{
                  borderTop: '1px solid var(--color-ink-4)',
                  paddingTop: 'var(--spacing-5)',
                }}
              >
                <Columns count={2} ratio="1:2" gap="lg" align="baseline">
                  <span
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 'clamp(2.5rem, 5vw, 4rem)',
                      lineHeight: 1,
                      color: i === 0 ? 'var(--color-accent)' : 'var(--color-ink-3)',
                      fontWeight: 300,
                      letterSpacing: 'var(--tracking-tightest)',
                    }}
                  >
                    {tenet.n}
                  </span>
                  <Stack gap="sm">
                    <h3
                      style={{
                        fontSize: 'var(--text-2xl)',
                        lineHeight: 'var(--leading-tight)',
                        letterSpacing: 'var(--tracking-tight)',
                        maxWidth: '26ch',
                      }}
                    >
                      {tenet.t}
                    </h3>
                    <Measure as="p" style={{ margin: 0 }}>
                      {tenet.b}
                    </Measure>
                  </Stack>
                </Columns>
              </li>
            ))}
          </Stack>
        </Stack>
      </Container>
    </Section>
  )
}
