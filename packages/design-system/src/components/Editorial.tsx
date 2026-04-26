/**
 * Editorial.tsx — long-form prose section with pull quote.
 * Two columns: aside (eyebrow + meta) left; article content right.
 */

import { Section } from './Layout'
import { Container } from './Layout'
import { Stack } from './Layout'
import { Measure } from './Layout'
import { Columns } from './Layout'

export function Editorial() {
  return (
    <Section id="journal">
      <Container>
        <Columns count={2} ratio="1:2" gap="xl">
          <aside>
            <span className="eyebrow" style={{ display: 'block', marginBottom: 'var(--sp-3)' }}>
              From the Journal
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-xs)',
                color: 'var(--ink-2)',
                letterSpacing: 'var(--tr-wide)',
              }}
            >
              No. 04 · Reading time 4 min
            </span>
          </aside>

          <Stack gap="md">
            <Measure size="display" as="h2" style={{ marginBottom: 'var(--sp-3)' }}>
              Why most landing pages read like the back of a vitamin bottle.
            </Measure>

            <Measure>
              <p>
                The standard playbook is older than most of us remember. A hero with a gradient. A
                row of three cards with rounded icons. Logos of companies that probably forgot they
                signed up. A second hero. A third hero. By the time the reader reaches the footer,
                the page has said nothing you couldn't fit on the back of a vitamin bottle.
              </p>
              <p>
                We're not opposed to imagery, or icons, or any of the patterns above. We're opposed
                to using them as <em>substitutes for thought</em>. A grid of icons is what you reach
                for when you don't yet know what your product is. A photograph of a smiling team is
                what you reach for when you can't think of a sentence.
              </p>
            </Measure>

            <blockquote>
              A grid of three icons is the cheapest possible answer to "what does this thing do."
              The most expensive answer — and usually the right one — is a paragraph.
              <cite>— Prose, journal no. 04</cite>
            </blockquote>

            <Measure>
              <p>
                Prose pulls the visual scaffolding out from under your page on purpose. What's left
                is the writing. If the writing is good, the page is good. If the writing is not, no
                amount of decoration was ever going to save it.
              </p>
            </Measure>
          </Stack>
        </Columns>
      </Container>
    </Section>
  )
}
