// The build reads an install's three files against each other, for any install: a declaration that is not whole,
// an install file that does not fit it and a mailbox content file that disagrees with it each stop `vite build` at the config, with every problem named, before anything is built or written. Not only at the
// Worker's start, which is too late: that is a deploy that ships a Worker whose first request fails.
//
// What is run is the real `vite build` with SPACE_DECLARATION naming a copy of Northfield's pair in a scratch folder with one thing wrong. It fails while the config loads, so nothing is built and `dist/` is left alone.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NORTHFIELD_DIR } from '../../workspace/northfield/paths'

const root = fileURLToPath(new URL('..', import.meta.url))
const invented = NORTHFIELD_DIR
const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/** Loads the build's config and nothing else: the checks and the settings file are the config's, and loading it builds nothing, so the dist other suites read is left alone. */
const LOAD_CONFIG = "import { loadConfigFromFile } from 'vite'; const r = await loadConfigFromFile({ command: 'build', mode: 'production' }, undefined, process.cwd()); console.log(r ? 'config loaded' : 'no config')"

/** A copy of Northfield's declaration, install file and content file in a folder of its own, changed by `change`, and the build's result for it. */
function buildWith(change: (files: { declaration: Record<string, any>; install: Record<string, any>; content: Record<string, any> }) => void, keep: { install?: boolean; configOnly?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'space-build-'))
  scratch.push(dir)
  const read = (name: string) => JSON.parse(readFileSync(join(invented, name), 'utf8')) as Record<string, any>
  const files = { declaration: read('workspace.json'), install: read('workspace-install.json'), content: read('workspace-content.json') }
  change(files)
  writeFileSync(join(dir, 'workspace.json'), JSON.stringify(files.declaration))
  if (keep.install !== false) writeFileSync(join(dir, 'workspace-install.json'), JSON.stringify(files.install))
  writeFileSync(join(dir, 'workspace-content.json'), JSON.stringify(files.content))
  const built = Bun.spawnSync(keep.configOnly ? ['bun', '-e', LOAD_CONFIG] : ['bun', 'run', 'vite', 'build'], { cwd: root, env: { ...process.env, SPACE_DECLARATION: join(dir, 'workspace.json') }, stderr: 'pipe', stdout: 'pipe' })
  return { code: built.exitCode, text: `${built.stderr.toString()}\n${built.stdout.toString()}` }
}

describe('a build refuses an install whose files disagree', () => {
  test('a persona for an address no business of the declaration has', () => {
    const r = buildWith(({ content }) => {
      content.personas['nobody@northfield.test'] = { role: 'a ghost', signature: 'x', us: 'x' }
    })
    expect(r.code).not.toBe(0)
    expect(r.text).toContain('nobody@northfield.test')
  })

  test('spam questions for a mailbox the declaration does not list, and a mailbox with its spam check on and no questions', () => {
    const stray = buildWith(({ content }) => {
      content.spamQuestions['ghost@northfield.test'] = content.spamQuestions['info@ridgewaycycles.example']
    })
    expect(stray.code).not.toBe(0)
    expect(stray.text).toContain('ghost@northfield.test')
    const missing = buildWith(({ content }) => {
      delete content.spamQuestions['info@ridgewaycycles.example']
    })
    expect(missing.code).not.toBe(0)
    expect(missing.text).toContain('declares its spam check on')
  })

  test('an install file that does not name what the declaration’s features need', () => {
    const r = buildWith(({ install }) => {
      delete install.gmail
      delete install.access.telegram
    })
    expect(r.code).not.toBe(0)
    expect(r.text).toContain('gmail: required')
    expect(r.text).toContain('access.telegram: required')
  })

  test('no install file beside the declaration', () => {
    const r = buildWith(() => {}, { install: false })
    expect(r.code).not.toBe(0)
    expect(r.text).toContain('workspace-install.json is missing')
  })

  test('a declaration that is not whole', () => {
    const r = buildWith(({ declaration }) => {
      delete declaration.googleApp
    })
    expect(r.code).not.toBe(0)
    expect(r.text).toContain('googleApp')
  })

  test('and the same files unchanged are accepted: a build for a copy of them in a folder of their own gets past every check and writes its settings', () => {
    // The control that the failures above are the changes’ and not the harness’s. Only the config is loaded (no bundling, so no dist is written under the test runner's NODE_ENV); the settings file it writes is the same text as the default's.
    const r = buildWith(() => {}, { configOnly: true })
    expect(r.code, r.text).toBe(0)
    expect(r.text).toContain('config loaded')
    const written = JSON.parse(readFileSync(join(root, 'wrangler.json'), 'utf8')) as { name: string; routes: { pattern: string }[] }
    expect([written.name, written.routes.map((x) => x.pattern)]).toEqual(['space', ['space.northfield.example', 'inbox-push.northfield.example']])
  })
})

describe('a build names the install it is for', () => {
  /** The environment with no SPACE_DECLARATION in it at all. */
  const unnamed = () => {
    const env: Record<string, string | undefined> = { ...process.env }
    delete env.SPACE_DECLARATION
    return env
  }
  const load = (command: 'build' | 'serve', env: Record<string, string | undefined>) => {
    const script = `import { loadConfigFromFile } from 'vite'; const r = await loadConfigFromFile({ command: '${command}', mode: '${command === 'build' ? 'production' : 'development'}' }, undefined, process.cwd()); console.log(r ? 'config loaded' : 'no config')`
    const done = Bun.spawnSync(['bun', '-e', script], { cwd: root, env, stderr: 'pipe', stdout: 'pipe' })
    return { code: done.exitCode, text: `${done.stderr.toString()}\n${done.stdout.toString()}` }
  }

  test('a build with no declaration named stops, saying how to name one, and falls back to no company’s files', () => {
    for (const env of [unnamed(), { ...unnamed(), SPACE_DECLARATION: '' }, { ...unnamed(), SPACE_DECLARATION: '   ' }]) {
      const r = load('build', env)
      expect(r.code).not.toBe(0)
      expect(r.text).toContain('No install named for this build: set SPACE_DECLARATION')
      expect(r.text).not.toContain('config loaded')
    }
  })

  test('`vite dev` with nothing named serves the invented install', () => {
    const r = load('serve', unnamed())
    expect(r.code, r.text).toBe(0)
    expect(r.text).toContain('config loaded')
    const written = JSON.parse(readFileSync(join(root, 'wrangler.json'), 'utf8')) as { routes: { pattern: string }[] }
    expect(written.routes.map((x) => x.pattern)).toEqual(['space.northfield.example', 'inbox-push.northfield.example'])
  })
})
