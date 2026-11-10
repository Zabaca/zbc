// The two steps a signer's page asks for that every browser test repeats: the consent (the button waits until the signer has
// opened the sample PDF) and a typed signature (the field starts blank, so the signer types their own name).
import { expect } from 'bun:test'
import type { Page } from 'playwright'

/**
 * Clicks the sample PDF's link as a signer would, checks the button was waiting for it, then agrees. The click's navigation is
 * stopped (a new tab would load the browser's own PDF viewer, which these tests count as another site) and the link's address is
 * fetched instead, so the Worker still serves the sample and records that it was opened.
 */
export async function agree(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: 'I agree, continue' })
  expect(await button.isDisabled()).toBe(true)
  expect(await page.getByRole('link', { name: 'Save these terms (PDF)' }).count()).toBe(1)
  const sample = page.getByRole('link', { name: 'Open sample PDF' })
  await sample.evaluate((el) => el.addEventListener('click', (e) => e.preventDefault(), { capture: true }))
  const href = (await sample.getAttribute('href'))!
  await sample.click()
  const res = await page.request.get(new URL(href, page.url()).href)
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toBe('application/pdf')
  await button.click()
}

/** In the adoption dialog on its Type tab: the field is blank, and the signer types their own name. */
export async function typeName(page: Page, name: string): Promise<void> {
  await page.getByRole('tab', { name: 'Type' }).click()
  const field = page.getByLabel(/^Your (full name|initials)$/)
  expect(await field.inputValue()).toBe('')
  await field.fill(name)
}
