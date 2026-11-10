// The browser for the end-to-end tests: Playwright's out-of-process mode with its driver run by Node.
//
// Playwright inside Bun's own process lost its pipe to Chrome now and then (README, "How the e2e suite stays reliable"), and its
// WebSocket route does not work from Bun (`http.request` never fires `upgrade`). With the driver in Node, the pipes to Chrome are
// Node's and Bun holds only the driver's stdin and stdout.
import { createRequire } from 'node:module'
import { basename, dirname } from 'node:path'
import type { Browser, BrowserContext } from 'playwright'

type ContextOptions = Parameters<Browser['newContext']>[0]

/** How long a call into the browser may take before it is reported as "not responding" instead of waited for. */
const CONTEXT_MS = 20_000
const CLOSE_BROWSER_MS = 20_000
const STOP_DRIVER_MS = 10_000

export interface E2eBrowser {
  /** A context, closed for you after the test whether or not the test got to its own `ctx.close()`. */
  newContext(options?: ContextOptions): Promise<BrowserContext>
  /** Closes every context still open (the tests' afterEach). */
  closeContexts(): Promise<void>
  /** Closes the browser and stops the driver. */
  stop(): Promise<void>
}

/** Rejects with `what` if the promise has not settled in `ms`: a browser call that does not answer is a failure to report, not a wait. */
export async function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer in ${ms / 1000} s: the browser is not responding`)), ms)
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

type Driver = {
  playwright: { chromium: { launch(options?: { channel?: string }): Promise<Browser> }; driverProcess?: { spawnfile?: string } }
  stop(): Promise<void>
}

/** Playwright's out-of-process client, with its driver forked as Node. `playwright-core/lib/coreBundle` is an exported entry of the pinned playwright-core. */
async function startDriver(): Promise<Driver> {
  const node = Bun.which('node')
  if (!node) throw new Error('node is needed on the PATH: Playwright runs its driver under Node (see e2e/browser.ts)')
  // playwright-core is a dependency of playwright, not of this package, so it is resolved from where playwright lives.
  const fromPlaywright = createRequire(`${dirname(createRequire(import.meta.url).resolve('playwright/package.json'))}/package.json`)
  const { oop } = fromPlaywright('playwright-core/lib/coreBundle') as { oop: { start(): Promise<Driver> } }
  // `start` forks the driver in its first, synchronous step, and fork runs `process.execPath`, which is Bun here.
  const bun = process.execPath
  Object.defineProperty(process, 'execPath', { value: node, configurable: true, writable: true })
  let started: Promise<Driver>
  try {
    started = oop.start()
  } finally {
    Object.defineProperty(process, 'execPath', { value: bun, configurable: true, writable: true })
  }
  const driver = await started
  // If a Playwright upgrade forks later than `start`'s first step, the driver would be Bun again and the flake would come back quietly.
  const forked = driver.playwright.driverProcess?.spawnfile
  if (!forked || basename(forked) !== basename(node)) {
    await driver.stop().catch(() => {})
    throw new Error(`the Playwright driver was forked as "${forked}", not node ("${node}"): see e2e/browser.ts`)
  }
  return driver
}

export async function launchBrowser(): Promise<E2eBrowser> {
  const driver = await startDriver()
  let browser: Browser
  try {
    // Playwright's own Chromium when it is installed; else the Chrome on the machine (the channel Playwright names "chrome").
    browser = await driver.playwright.chromium.launch().catch(() => driver.playwright.chromium.launch({ channel: 'chrome' }))
  } catch (error) {
    await driver.stop().catch(() => {})
    throw error
  }
  const open = new Set<BrowserContext>()
  return {
    async newContext(options) {
      const ctx = await within(CONTEXT_MS, 'opening a browser context', browser.newContext(options))
      open.add(ctx)
      ctx.once('close', () => open.delete(ctx))
      return ctx
    },
    async closeContexts() {
      await Promise.all([...open].map((ctx) => within(CONTEXT_MS, 'closing a browser context', ctx.close())))
    },
    async stop() {
      await within(CLOSE_BROWSER_MS, 'closing the browser', browser.close()).catch(() => {})
      await within(STOP_DRIVER_MS, 'stopping the Playwright driver', driver.stop()).catch(() => {})
    },
  }
}
