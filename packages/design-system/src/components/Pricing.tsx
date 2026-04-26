/**
 * Pricing.tsx — two-tier pricing as plain prose, not cards.
 * Quiet background. Free tier + Studio tier.
 * Studio tier has accent top-border (one of the three accent uses).
 */

import { Section } from './Layout'
import { Container } from './Layout'
import { Stack } from './Layout'
import { Measure } from './Layout'
import { Columns } from './Layout'
import { PrimaryButton } from './PrimaryButton'

export function Pricing() {
  return (
    <Section id="pricing" tone="quiet">
      <Container>
        <Stack gap="2xl">
          <Stack gap="md">
            <span className="eyebrow">Pricing</span>
            <Measure size="display" as="h2">
              Two tiers, written in sentences.
            </Measure>
          </Stack>

          <Columns count={2} gap="xl">
            {/* Free tier */}
            <Stack gap="md" className="border-t border-ink-4 pt-5">
              <h3 className="text-xl">Free, forever.</h3>
              <Measure as="p">
                The stylesheet, the components, the manual. All of it. For personal projects, side
                projects, and anything you'd rather not pay for.
              </Measure>
              <a href="#start" className="font-ui text-sm font-medium">
                Download the kit →
              </a>
            </Stack>

            {/* Studio tier — accent top-border */}
            <Stack gap="md" className="border-t-2 border-accent pt-5">
              <h3 className="text-xl">
                <span className="font-mono text-[0.7em] text-accent mr-[0.5em]">$8/mo</span>
                Studio.
              </h3>
              <Measure as="p">
                Add three more hero variants, a serial-letter component, full licensing for client
                work, and an opinionated copywriting checklist from a real editor. Cancel anytime;
                we'll be sad but we'll get over it.
              </Measure>
              <PrimaryButton>Start a studio plan</PrimaryButton>
            </Stack>
          </Columns>
        </Stack>
      </Container>
    </Section>
  )
}
