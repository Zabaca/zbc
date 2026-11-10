// What keeps the space the same code for every company, read from the source: the four apps have no Worker of their own, a build hands every part the one declaration it was told, and nothing in the
// space, the inbox, the company layer or the Clients part knows a source of Clients by a name of its own. What one install deploys is pinned by that install, beside its files.
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

const inFolder = (path: string) => new URL(`../../${path}`, import.meta.url)
const read = (path: string) => readFileSync(inFolder(path), 'utf8')
/** Every TypeScript file under a folder of the packages, with its path from there. */
const sources = (dir: string, except: string[] = []) =>
  readdirSync(inFolder(dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx?$/.test(f) && !except.some((name) => f.endsWith(name)))
    .map((f) => ({ path: `${dir}/${f}`, text: read(`${dir}/${f}`) }))

describe('one Worker', () => {
  test('the inbox, meet, forms and the knowledge app have no wrangler file and no Worker entry: the space’s Worker is the only one', () => {
    for (const pkg of ['inbox', 'meet', 'forms', 'knowledge']) expect(existsSync(inFolder(`${pkg}/wrangler.jsonc`)), pkg).toBe(false)
    for (const entry of ['inbox/src/worker.ts', 'meet/src/index.ts', 'forms/src/index.ts', 'knowledge/src/worker.ts']) expect(existsSync(inFolder(entry)), entry).toBe(false)
  })

  test('the build hands every part the declaration it was told, and the inbox its content file: a company’s space is built for its own people and businesses', () => {
    const vite = read('space/vite.config.ts')
    for (const part of ['space', 'forms', 'knowledge', 'meet', 'inbox', 'calendar', 'clients']) expect(vite, part).toContain(`'@${part}/declaration': declaration`)
    expect(vite).toContain("'@inbox/content': content")
    expect(vite).toContain("'workspace-content.json'")
    // The deploy ships the settings the build wrote for the install: there is no settings file to choose between.
    expect(vite).not.toContain('WRANGLER_CONFIG')
  })
})

describe('no source of Clients is known by name', () => {
  test('the Clients part names none: no binding to a site, no payment provider, no field of a source’s', () => {
    const part = ['durable.ts', 'store.ts', 'space.ts', 'source.ts', 'inbox.ts', 'store-access.ts'].map((f) => read(`clients/src/${f}`)).join('\n')
    expect(part).not.toMatch(/env\.CLIENTS\b|ClientDirectory|stripe|subscription|signIn/i)
  })

  test('the space, the inbox and the company layer know no source’s field by name: what a source’s extra fields mean, and what they are called, is the declaration’s', () => {
    // The two stand-ins that invent a source's Clients for a local run and for the screens' tests must name such fields, as they stand in for a source. A bare "subscription" cannot be looked for across the
    // three trees (the inbox's push subscriptions, a mail server's, a model's), so it is looked for in the files named for Clients.
    const NAMED = /subscription(Status|At|Text)|client portal|signInAddress|sign-in-address/i
    const all = ['space/src', 'inbox/src', 'workspace/src'].flatMap((dir) => sources(dir, ['stand-in-clients.ts', 'fixture-views.ts']))
    expect(all.length).toBeGreaterThan(100)
    expect(all.filter((f) => NAMED.test(f.text)).map((f) => f.path)).toEqual([])
    const aboutClients = all.filter((f) => /clients/i.test(f.path.split('/').at(-1) ?? ''))
    expect(aboutClients.length).toBeGreaterThan(5)
    expect(aboutClients.filter((f) => /subscription/i.test(f.text)).map((f) => f.path)).toEqual([])
  })

  test('the space and the inbox read no site’s directory of Clients and have no binding to one', () => {
    // The code only: a comment may say what was removed.
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const file of [...sources('space/src'), ...sources('inbox/src')]) {
      expect(code(file.text), file.path).not.toMatch(/readDirectory|ClientDirectory|env\.CLIENTS\b|\bCLIENTS\??:\s/)
    }
  })
})
