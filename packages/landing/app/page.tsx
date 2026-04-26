import { Section, Container, Stack, Measure, PrimaryButton } from '@zbc/design-system'

// Force dynamic rendering — proves SSR is actually executing per-request,
// not falling back to static generation at build time.
export const dynamic = 'force-dynamic'

export default function Page() {
  const renderedAt = new Date().toISOString()

  return (
    <Section>
      <Container>
        <Stack gap="lg">
          <Measure size="display" as="h1">
            zbc landing — server-rendered.
          </Measure>
          <Measure as="p">
            Rendered at <code>{renderedAt}</code> on every request. The page is a Next.js server
            component consuming primitives from <code>@zbc/design-system</code>.
          </Measure>
          <Measure as="p">
            API route smoke test: <a href="/api/hello">/api/hello</a> returns fresh JSON on every
            hit.
          </Measure>
          <PrimaryButton type="button">A button from the design system</PrimaryButton>
        </Stack>
      </Container>
    </Section>
  )
}
