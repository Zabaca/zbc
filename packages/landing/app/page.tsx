import { Section, Container, Stack, Measure, Columns } from '@zbc/design-system'
import { SiteHeader } from './site-header'
import { InstallCommand } from './install-command'
import { LiveCursors } from './live-cursors'

const REPO = 'https://github.com/Zabaca/zbc'

/**
 * Composed from the design system's layout primitives rather than its page
 * sections — those carry Prose's own hardcoded marketing copy and take no props.
 *
 * Accent budget (Prose allows three static marks per page): the header wordmark
 * underscore, the headline period, and the footer wordmark underscore. Hover
 * states and the base layer's link underline don't count against the budget —
 * they're not standing marks on the resting page.
 */
export default function Page() {
  return (
    <>
      <SiteHeader />

      <main>
        {/* ---- hero ---------------------------------------------------- */}
        <Section id="top" gap="md">
          <Container>
            <Stack gap="xl" align="center" className="text-center">
              <span className="eyebrow">Declarative infra · Bun · MIT</span>

              <Measure
                size="display"
                as="h1"
                className="font-normal leading-display tracking-tightest"
                style={{ fontSize: 'clamp(2.5rem, 6.5vw, 5.5rem)' }}
              >
                One command. The whole environment
                <span className="text-accent">.</span>
              </Measure>

              <Measure size="wide" as="p" className="lede">
                Describe your database and your workers in TypeScript. <code>zbc apply</code>{' '}
                provisions what is missing, converges what drifted, and deploys your code — on your
                laptop and in CI, by the same path. There is no state file.
              </Measure>

              <InstallCommand command="bunx @zabaca/zbc apply production" />

              <Terminal />
            </Stack>
          </Container>
        </Section>

        {/* ---- the commands -------------------------------------------- */}
        <Section id="run" tone="quiet">
          <Container>
            <Stack gap="2xl">
              <Measure size="display" as="h2">
                Four commands is the entire surface area.
              </Measure>

              <Columns count={3} gap="xl">
                {COMMANDS.map((c) => (
                  <Stack key={c.name} gap="sm" className="border-t border-ink-4 pt-5">
                    <code className="font-mono text-sm text-ink-0">{c.name}</code>
                    <p className="m-0 max-w-[32ch] text-sm leading-[1.55]">{c.body}</p>
                  </Stack>
                ))}
              </Columns>

              <Measure as="p" className="label-mono m-0">
                destroy tears an environment down in reverse dependency order — how per-PR previews
                clean up after themselves.
              </Measure>
            </Stack>
          </Container>
        </Section>

        {/* ---- previews ------------------------------------------------- */}
        <Section id="modules">
          <Container>
            <Columns count={2} ratio="2:1" gap="2xl" collapseAt="wide">
              <Stack gap="md">
                <span className="eyebrow">Every PR gets its own</span>
                <Measure size="display" as="h2">
                  Preview environments that tear themselves down.
                </Measure>
                <Code>{PREVIEW_SNIPPET}</Code>
              </Stack>

              <Stack gap="md">
                <p className="m-0 text-sm leading-prose">
                  Open a pull request and <code>zbc apply preview</code> stands up an isolated
                  worker and database, then comments the URL back onto the PR.
                </p>
                <p className="m-0 text-sm leading-prose">
                  Close it and <code>zbc destroy preview</code> takes them down again — dependents
                  first, dependencies after.
                </p>
                <p className="m-0 text-sm leading-prose">
                  Two modules ship today: <strong>turso</strong> provisions the libSQL database,
                  mints its token and runs your migrations; <strong>cloudflare</strong> builds and
                  deploys the Worker. <code>zbc add</code> vendors either one into your repo as
                  source you can read and change.
                </p>
                <a href={REPO} className="font-ui text-sm font-medium text-ink-0">
                  Read the source →
                </a>
              </Stack>
            </Columns>
          </Container>
        </Section>

        {/* ---- the live bit --------------------------------------------- */}
        <Section id="live" tone="quiet">
          <Container>
            <Stack gap="md">
              <span className="eyebrow">Live · this page</span>
              <Measure size="display" as="h2">
                Those cursors are other people.
              </Measure>
              <Measure as="p">
                They reach you through a NATS server running as a Cloudflare Container — declared as
                one more instance in the same environment directory as this page, and applied by the
                same command. No special case.
              </Measure>
              {/* Mounted once. Renders the fixed cursor overlay for the whole
                  page plus the presence line right here. */}
              <LiveCursors />
            </Stack>
          </Container>
        </Section>

        {/* ---- closing CTA ---------------------------------------------- */}
        <Section gap="md" className="border-t border-paper-3">
          <Container>
            <Stack gap="md" align="center" className="text-center">
              <Measure size="display" as="h2">
                Start with an empty repo, or the one you have.
              </Measure>
              <Measure as="p">
                <code>init</code> works on greenfield projects and existing Bun workspaces alike,
                and never overwrites a file you already wrote.
              </Measure>
              <InstallCommand command="bunx @zabaca/zbc init --ci github" />
            </Stack>
          </Container>
        </Section>
      </main>

      <footer className="border-t border-paper-3 bg-paper-1 py-8">
        <Container className="flex flex-wrap justify-between gap-4">
          <span className="font-mono text-md font-medium text-ink-0">
            zbc<span className="text-accent">_</span>
          </span>
          <span className="label-mono">
            MIT · @zabaca/zbc · requires Bun ·{' '}
            <a href={REPO} className="text-ink-2">
              github.com/Zabaca/zbc
            </a>
          </span>
        </Container>
      </footer>
    </>
  )
}

const COMMANDS = [
  {
    name: 'zbc init',
    body: 'Scaffolds the infra skeleton, the SOPS config and your CI workflows. Skips anything that already exists — it will not clobber your repo.',
  },
  {
    name: 'zbc add',
    body: "Vendors a module's source into your repo, installs its dependencies, and tells you which secrets to add and where to get them.",
  },
  {
    name: 'zbc apply',
    body: 'Sorts the graph from your imports, decrypts your secrets, converges every resource. Idempotent — run it as often as you like.',
  },
]

const PREVIEW_SNIPPET = `// packages/infra/environments/preview/web.ts
const pr = process.env.PR_NUMBER ?? 'local'

export default cloudflareModule.instance({
  name: 'web',
  config: {
    workdir: 'packages/web',
    workerName: \`zbc-web-pr-\${pr}\`,
    build: { command: 'bun run build' },
  },
})`

/** A code block on the page's own ground. */
function Code({ children }: { children: string }) {
  return (
    <pre className="m-0 overflow-x-auto rounded-1 border border-paper-3 bg-paper-1 p-5 font-mono text-xs leading-loose text-ink-1">
      {children}
    </pre>
  )
}

/**
 * The transcript. Inverted (ink ground, paper text) exactly like PrimaryButton,
 * so it flips correctly in dark mode instead of staying a black box.
 */
function Terminal() {
  return (
    <div className="w-full max-w-[52rem] overflow-x-auto rounded-1 bg-ink-0 p-6 text-left font-mono text-xs leading-loose">
      <pre className="m-0">
        <span className="text-ink-3">$ </span>
        <span className="text-paper-0">zbc apply production</span>
        {'\n\n'}
        <span className="text-paper-0">→ turso:main-db</span>
        {'\n'}
        <span className="text-ink-4">
          {' '}
          Created database "myproject-production" in group "default"
        </span>
        {'\n'}
        <span className="text-paper-0">✓ turso:main-db applied</span>
        {'\n\n'}
        <span className="text-paper-0">→ cloudflare:web</span>
        {'\n'}
        <span className="text-ink-4"> Built packages/web</span>
        {'\n'}
        <span className="text-ink-4"> Deployed: https://myproject-web.workers.dev</span>
        {'\n'}
        <span className="text-paper-0">✓ cloudflare:web applied</span>
        {'\n\n'}
        <span className="text-ink-4">Done.</span>
      </pre>
    </div>
  )
}
