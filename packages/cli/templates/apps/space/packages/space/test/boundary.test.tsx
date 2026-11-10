// A screen loaded when it is first needed can fail to load: the page was opened, the space was deployed, and a move to the Forms tab asks for a chunk whose old
// address now answers with the page's HTML, so `import()` rejects. The page must keep its shell and say so, with a button to reload, not go blank (src/client/Boundary.tsx).
// The DOM is registered for this file only, so React is imported after it (as settings-dom.test.tsx does).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://space.northfield.example/forms/envelopes' })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

let unmount: (() => Promise<void>) | null = null
afterEach(async () => {
  await unmount?.()
  unmount = null
})

async function mount(load: () => Promise<{ default: () => React.ReactElement }>) {
  const { act, lazy, Suspense } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { Boundary } = await import('../src/client/Boundary')
  const Screen = lazy(load)
  const host = document.createElement('div')
  host.innerHTML = '<nav id="shell">the tabs</nav>'
  document.body.appendChild(host)
  const screen = document.createElement('div')
  host.appendChild(screen)
  const root = createRoot(screen)
  unmount = () => act(async () => root.unmount())
  const quiet = console.error
  console.error = () => undefined // React and the boundary say what failed; the test reads the page
  try {
    await act(async () =>
      root.render(
        <Boundary what="Forms">
          <Suspense fallback="Opening Forms">
            <Screen />
          </Suspense>
        </Boundary>,
      ),
    )
    await act(async () => new Promise((r) => setTimeout(r, 20)))
  } finally {
    console.error = quiet
  }
  return { host, screen }
}

describe('a screen that fails to load', () => {
  test('keeps the rest of the page, says in the space’s words what happened, and offers a reload', async () => {
    const { host, screen } = await mount(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/FormsTab-old.js')))
    expect(host.querySelector('#shell')?.textContent).toBe('the tabs')
    const said = screen.querySelector('[data-testid="screen-failed"]')
    expect(said?.getAttribute('role')).toBe('alert')
    expect(said?.textContent).toContain('Forms could not be opened. The space may have been updated since this page was loaded.')
    const button = screen.querySelector('button')
    expect(button?.textContent).toBe('Reload')
  })

  test('the button reloads the page', async () => {
    const { screen } = await mount(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module')))
    let reloads = 0
    Object.defineProperty(window.location, 'reload', { configurable: true, value: () => void reloads++ })
    ;(screen.querySelector('button') as HTMLButtonElement).click()
    expect(reloads).toBe(1)
  })

  test('shows the screen when it loads, and nothing of the notice', async () => {
    const { screen } = await mount(async () => ({ default: () => <p data-testid="here">Forms is here</p> }))
    expect(screen.querySelector('[data-testid="here"]')?.textContent).toBe('Forms is here')
    expect(screen.querySelector('[data-testid="screen-failed"]')).toBeNull()
  })
})
