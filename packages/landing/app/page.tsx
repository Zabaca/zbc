import { Section, Container, Stack, Measure, PrimaryButton } from '@zbc/design-system'
import { LiveClicks } from './live-clicks'

export default function Page() {
  // Statically exported (output: 'export'), so this timestamp is stamped at
  // BUILD time, not per request. The runtime-freshness demo moved to the
  // Worker's /api/hello, which returns a fresh value on every hit.
  const builtAt = new Date().toISOString()

  return (
    <Section>
      <Container>
        <Stack gap="lg">
          <Measure size="display" as="h1">
            zbc landing — static export on Cloudflare.
          </Measure>
          <Measure as="p">
            Built at <code>{builtAt}</code>. The page is a statically exported Next.js app consuming
            primitives from <code>@zbc/design-system</code>, served by a Cloudflare Worker.
          </Measure>
          <Measure as="p">
            API route smoke test: <a href="/api/hello">/api/hello</a> is handled by the Worker and
            returns fresh JSON on every hit.
          </Measure>
          <PrimaryButton type="button">A button from the design system</PrimaryButton>
          <LiveClicks />
        </Stack>
      </Container>
    </Section>
  )
}
