import { Section, Container, Stack, Measure, Columns } from '@zbc/design-system'
import { SiteHeader } from './site-header'
import { InstallCommand } from './install-command'
import { LiveCursors } from './live-cursors'

const REPO = 'https://github.com/Zabaca/zbc'

/**
 * Composed from the design system's layout primitives rather than its page
 * sections: those carry Prose's own hardcoded marketing copy and take no props.
 *
 * Accent budget (Prose allows three static marks per page): the header wordmark
 * underscore, the headline period, and the footer wordmark underscore. Hover
 * states and the base layer's link underline don't count against the budget,
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
                Describe your database, your workers and your whole applications in TypeScript.{' '}
                <code>zbc apply</code> provisions what is missing, converges what drifted, and
                deploys your code, on your laptop and in CI, by the same path. There is no state
                file.
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
                Five commands is the entire surface area.
              </Measure>

              {/* A ledger, not a card grid: five rows read down in order. */}
              <div>
                {COMMANDS.map((c, i) => (
                  <div
                    key={c.name}
                    className="grid grid-cols-[3rem_1fr] items-baseline gap-x-4 gap-y-2 border-t border-ink-4 py-5 wide:grid-cols-[3rem_12rem_1fr]"
                  >
                    <span className="label-mono">{`0${i + 1}`}</span>
                    <code className="font-mono text-sm text-ink-0">{c.name}</code>
                    <p className="col-start-2 m-0 max-w-[56ch] text-sm leading-[1.55] wide:col-start-3">
                      {c.body}
                    </p>
                  </div>
                ))}
              </div>
            </Stack>
          </Container>
        </Section>

        {/* ---- app templates -------------------------------------------- */}
        <Section id="apps">
          <Container>
            <Stack gap="2xl">
              <Stack gap="md">
                <span className="eyebrow">App templates</span>
                <Measure size="display" as="h2">
                  <code className="font-mono text-[0.62em]">zbc add inbox</code> is not a resource.
                  It&rsquo;s an inbox.
                </Measure>
                <Measure size="wide" as="p" className="lede">
                  A Cloudflare Worker that receives routed mail, stores raw MIME in R2, and exposes
                  a bearer-authed JSON API, an MCP server at <code>/mcp</code>, and a web UI. Three
                  instance files and <code>zbc apply</code>. Vendored into your repo as source: read
                  it, change it, it&rsquo;s yours.
                </Measure>
              </Stack>

              <div>
                {APP_TEMPLATES.map((a) => (
                  <div
                    key={a.name}
                    className="grid grid-cols-1 items-baseline gap-x-6 gap-y-3 border-t border-ink-4 py-6 wide:grid-cols-[16rem_1fr]"
                  >
                    <code className="font-mono text-md text-ink-0">{`zbc add ${a.name}`}</code>
                    <p className="m-0 max-w-[56ch] text-sm leading-[1.55]">{a.body}</p>
                  </div>
                ))}
              </div>
            </Stack>
          </Container>
        </Section>

        {/* ---- previews ------------------------------------------------- */}
        <Section id="modules" tone="quiet">
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
                  Close it and <code>zbc destroy preview</code> takes them down again, dependents
                  first, dependencies after.
                </p>
                <p className="m-0 text-sm leading-prose">
                  Four modules ship today: <strong>turso</strong> provisions the libSQL database,
                  mints its token and runs your migrations; <strong>cloudflare</strong> builds and
                  deploys the Worker or Container; <strong>r2</strong> provisions object storage;{' '}
                  <strong>cloudflare-email</strong> onboards a sending domain and routes inbound
                  mail. <code>zbc add</code> vendors any of them into your repo as source you can
                  read and change.
                </p>
                <a href={REPO} className="font-ui text-sm font-medium text-ink-0">
                  Read the source →
                </a>
              </Stack>
            </Columns>
          </Container>
        </Section>

        {/* ---- secrets --------------------------------------------------- */}
        <Section id="secrets">
          <Container>
            <Stack gap="2xl">
              <Measure size="display" as="h2">
                Your secrets live in your repo. Encrypted, committed, reviewable.
              </Measure>

              <Columns count={2} gap="2xl" collapseAt="wide">
                <p className="m-0 text-sm leading-prose">
                  No dashboard, no vault, no password manager. <code>.sops.yaml</code> lists the
                  public age keys; private keys never leave a laptop, and the ciphertext sits in the
                  same pull request as the code that reads it. Onboarding a developer is a PR.
                  Offboarding is a PR.
                </p>
                <p className="m-0 text-sm leading-prose">
                  <code>zbc secret request</code> opens a link a non-technical human can paste an
                  API key into. It travels end-to-end encrypted through a relay you deploy yourself
                  and lands in <code>secrets.yaml</code>. Whoever asked for it learns only that it
                  arrived.
                </p>
              </Columns>
            </Stack>
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
                They reach you through a NATS server running as a Cloudflare Container, declared as
                one more instance in the same environment directory as this page, and applied by the
                same command. No special case.
              </Measure>
              <Measure as="p">
                This page, that NATS server, an inbox, a warehouse and a secret relay are five
                instances in one <code>environments/production/</code> directory. One command
                applies all of them.
              </Measure>
              {/* Mounted once. Renders the fixed cursor overlay for the whole
                  page plus the presence line right here. */}
              <LiveCursors />
            </Stack>
          </Container>
        </Section>

        {/* ---- c9s ------------------------------------------------------- */}
        <Section id="c9s">
          <Container>
            <Stack gap="2xl">
              <Stack gap="md">
                <span className="eyebrow">Companion CLI</span>
                <Measure size="display" as="h2">
                  <code className="font-mono text-[0.62em]">apply</code> changes it.{' '}
                  <code className="font-mono text-[0.62em]">c9s</code> is how you look at it.
                </Measure>
                <Measure size="wide" as="p" className="lede">
                  A k9s-style terminal UI for the account you just deployed into. Workers with live
                  request, error and CPU numbers, Containers, Durable Objects, D1, R2, KV and
                  Queues, in one table you can page through, filter and drill into. It never writes:
                  changing infrastructure stays <code>zbc apply</code>&rsquo;s job.
                </Measure>
              </Stack>

              <Columns count={2} ratio="2:1" gap="2xl" collapseAt="wide">
                <C9sTerminal />

                <Stack gap="md">
                  <p className="m-0 text-sm leading-prose">
                    Inside a zbc project there is nothing to configure. It walks up to your{' '}
                    <code>zbc.config.ts</code> and decrypts that project&rsquo;s own{' '}
                    <code>secrets.yaml</code> with your age key, so one global install serves every
                    repo and you always get the account you are standing in.
                  </p>
                  <p className="m-0 text-sm leading-prose">
                    Cloudflare has no namespace, so c9s infers one. It attributes every bucket,
                    database and container to the Worker it belongs to, and{' '}
                    <code>:proj foothill</code> scopes each view to that project as you browse.
                  </p>
                  <p className="m-0 text-sm leading-prose">
                    <code>↵</code> describes a resource, <code>l</code> tails its logs and{' '}
                    <code>s</code> drops you into a running container.
                  </p>
                  <InstallCommand command="bun add -g @zabaca/c9s" />
                </Stack>
              </Columns>
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
    body: 'Scaffolds the infra skeleton, the SOPS config and your CI workflows. Skips anything that already exists; it will not clobber your repo.',
  },
  {
    name: 'zbc add',
    body: 'Vendors a module, or a whole app, into your repo as source, installs its dependencies, and tells you which secrets to add and where to get them.',
  },
  {
    name: 'zbc apply',
    body: 'Sorts the graph from your imports, decrypts your secrets, converges every resource. Idempotent, so run it as often as you like.',
  },
  {
    name: 'zbc destroy',
    body: 'Tears an environment down in reverse dependency order, which is how per-PR previews clean up after themselves.',
  },
  {
    name: 'zbc secret',
    body: 'request, list, edit. Reads and writes an environment’s encrypted secrets file without ever printing a value to your terminal.',
  },
]

const APP_TEMPLATES = [
  {
    name: 'inbox',
    body: 'An agent-accessible email inbox. Routed mail lands as raw MIME in R2 with its metadata in a SQLite Durable Object; reads and sends go through a bearer-authed JSON API, an MCP server at /mcp, and a small web UI.',
  },
  {
    name: 'warehouse',
    body: 'A Container running dlt and dbt-duckdb. Connectors extract incrementally into a durable append-only raw layer in R2; a daily Cron Trigger materializes schema-declared parquet marts, read at the edge with no container wake.',
  },
  {
    name: 'secret-relay',
    body: 'A permanent worker that brokers secret requests between the CLI and a human’s browser. It carries ciphertext only. The value is decrypted on your machine, never in the relay and never in an agent’s context.',
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
 * c9s, rendered as it actually draws: the projects rollup, which is the view the
 * Cloudflare dashboard cannot give you at all. Same inversion as Terminal.
 */
function C9sTerminal() {
  const rows = [
    ['agent-canvas', '8', '2', '2', '3', '0', '1'],
    ['foothill-inbox', '4', '1', '0', '1', '1', '1'],
    ['tour-guide', '3', '1', '0', '1', '0', '1'],
    ['zbc-inbox', '3', '1', '0', '1', '0', '1'],
    ['zbc-nats', '3', '1', '1', '1', '0', '0'],
  ]
  const w = [22, 7, 9, 12, 4, 4, 4]
  const cell = (v: string, i: number) => v.padEnd(w[i] ?? 0)
  const line = (cells: string[]) => cells.map(cell).join('')

  return (
    <div className="w-full overflow-x-auto rounded-1 bg-ink-0 p-6 text-left font-mono text-xs leading-loose">
      <pre className="m-0">
        <span className="text-ink-3">$ </span>
        <span className="text-paper-0">c9s</span>
        {'\n\n'}
        <span className="text-ink-4">{'Account:  99a19e58    Project:  all\n\n'}</span>
        <span className="text-paper-0">
          {`  ${line(['PROJECT', 'TOTAL', 'WORKERS', 'CONTAINERS', 'DO', 'D1', 'R2'])}\n`}
        </span>
        {rows.map((r, i) => (
          <span key={r[0]} className={i === 0 ? 'text-paper-0' : 'text-ink-4'}>
            {`${i === 0 ? '> ' : '  '}${line(r)}\n`}
          </span>
        ))}
        {'\n'}
        <span className="text-ink-4">{'Projects(all)[33]  1-5/33'}</span>
      </pre>
    </div>
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
        <span className="text-paper-0">→ r2:inbox-raw</span>
        {'\n'}
        <span className="text-ink-4"> Bucket "myproject-inbox-raw" ready</span>
        {'\n'}
        <span className="text-paper-0">✓ r2:inbox-raw applied</span>
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
        <span className="text-paper-0">→ cloudflare-email:mail</span>
        {'\n'}
        <span className="text-ink-4">
          {' '}
          SPF, DKIM, DMARC and bounce MX provisioned for mail.myproject.com
        </span>
        {'\n'}
        <span className="text-paper-0">✓ cloudflare-email:mail applied</span>
        {'\n\n'}
        <span className="text-ink-4">Done. 4 instances, 1 graph.</span>
      </pre>
    </div>
  )
}
