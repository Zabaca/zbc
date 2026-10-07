/**
 * The zbc plugin cannot drift from the CLI it teaches.
 *
 * `packages/cli/plugin/` is what an agent in a consumer repo reads before it
 * touches zbc, and the marketplace serves it from main — so it is always
 * describing the CLI as it stands here. A skill naming a flag that was renamed,
 * or a catalog missing the module that would have fit, is worse than no skill:
 * the agent is confident, and it is wrong.
 *
 * So the parts a test can hold are held: every `zbc …` line in the CLI
 * reference names a real command and real flags, the module catalog lists
 * exactly the directories `zbc add` can install, and every link resolves.
 */

import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { bundledRegistryNames } from './commands/add'
import { applyCommand } from './commands/apply'
import { destroyCommand } from './commands/destroy'
import { initCommand } from './commands/init'
import { listCommand } from './commands/list'
import { runCommand } from './commands/run'
import { secretCommand } from './commands/secret'
import { updateCommand } from './commands/update'
import { addCommand } from './commands/add'

const PLUGIN = path.join(import.meta.dir, '..', 'plugin')
const SKILLS = path.join(PLUGIN, 'skills')
const REPO = path.join(import.meta.dir, '..', '..', '..')

const read = (...parts: string[]) => fs.readFileSync(path.join(...parts), 'utf8')

interface CommandShape {
  args?: Record<string, unknown>
  subCommands?: Record<string, CommandShape>
}

/** The top-level commands, as `src/index.ts` registers them. */
const COMMANDS: Record<string, CommandShape> = {
  add: addCommand,
  apply: applyCommand,
  destroy: destroyCommand,
  init: initCommand,
  list: listCommand,
  run: runCommand,
  secret: secretCommand,
  update: updateCommand,
} as Record<string, CommandShape>

/** Every `zbc …` invocation in a ```bash fence of the CLI reference. */
function documentedInvocations(): string[] {
  const md = read(SKILLS, 'zbc', 'cli.md')
  const fences = [...md.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1])
  return fences.flatMap((body) => body.split('\n').filter((line) => line.startsWith('zbc ')))
}

/** A flag is real when the command declares it, or declares the boolean `--no-x` negates. */
function hasFlag(command: CommandShape, flag: string): boolean {
  const args = command.args ?? {}
  return flag in args || (flag.startsWith('no-') && flag.slice(3) in args)
}

describe('the CLI reference', () => {
  const invocations = documentedInvocations()

  test('documents every top-level command', () => {
    const documented = new Set(invocations.map((line) => line.split(/\s+/)[1]))
    expect([...documented].toSorted()).toEqual(Object.keys(COMMANDS).toSorted())
  })

  test.each(invocations)('%s — names a real command and real flags', (line) => {
    const words = line.split(/\s+/)
    let command = COMMANDS[words[1]]
    expect(command).toBeDefined()
    if (command.subCommands && words[2] && command.subCommands[words[2]]) {
      command = command.subCommands[words[2]]
    }
    for (const [, flag] of line.matchAll(/--([a-z][a-z-]*)/g)) {
      expect(hasFlag(command, flag), `--${flag} on "${line}"`).toBe(true)
    }
  })

  test('documents every public secret subcommand', () => {
    const documented = new Set(
      invocations.filter((l) => l.startsWith('zbc secret ')).map((l) => l.split(/\s+/)[2]),
    )
    const shipped = Object.keys(secretCommand.subCommands ?? {}).filter((n) => !n.startsWith('_'))
    expect([...documented].toSorted()).toEqual(shipped.toSorted())
  })
})

describe('the module catalog', () => {
  /** The first column of every catalog table: `` | `name` | ``. */
  const listed = [...read(SKILLS, 'zbc', 'modules.md').matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map(
    (m) => m[1],
  )

  test('lists exactly what `zbc add` can install, once each', () => {
    expect(listed.toSorted()).toEqual(bundledRegistryNames())
  })

  test('states each entry under the kind its registry.json declares', () => {
    const md = read(SKILLS, 'zbc', 'modules.md')
    for (const name of bundledRegistryNames()) {
      const registry = JSON.parse(
        fs.existsSync(path.join(REPO, 'packages/cli/templates/infra/modules', name))
          ? read(REPO, 'packages/cli/templates/infra/modules', name, 'registry.json')
          : read(REPO, 'packages/cli/templates/apps', name, 'registry.json'),
      ) as { kind?: string }
      const kind = registry.kind ?? 'module'
      if (kind === 'app') {
        expect(md).toMatch(new RegExp(`^\\| \`${name}\` \\| (?!module|library)`, 'm'))
      } else {
        expect(md).toMatch(new RegExp(`^\\| \`${name}\` \\| ${kind} \\|`, 'm'))
      }
    }
  })
})

describe('the plugin', () => {
  test('is listed by the marketplace at its own path, under its own name', () => {
    const marketplace = JSON.parse(read(REPO, '.claude-plugin', 'marketplace.json')) as {
      plugins: Array<{ name: string; source: string }>
    }
    const entry = marketplace.plugins.find((p) => p.name === 'zbc')
    expect(entry).toBeDefined()
    expect(path.resolve(REPO, entry!.source)).toBe(path.resolve(PLUGIN))
    const manifest = JSON.parse(read(PLUGIN, '.claude-plugin', 'plugin.json')) as { name: string }
    expect(manifest.name).toBe('zbc')
  })

  const skills = fs.readdirSync(SKILLS)

  test.each(skills)('skill %s — frontmatter names its directory and has a description', (skill) => {
    const md = read(SKILLS, skill, 'SKILL.md')
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(md)?.[1] ?? ''
    expect(frontmatter).toContain(`name: ${skill}\n`)
    expect(frontmatter).toMatch(/^description: \S/m)
  })

  test.each(skills)('skill %s — every relative link resolves', (skill) => {
    for (const file of fs.readdirSync(path.join(SKILLS, skill))) {
      const md = read(SKILLS, skill, file)
      for (const [, target] of md.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        if (/^[a-z]+:/.test(target)) continue
        expect(fs.existsSync(path.join(SKILLS, skill, target)), `${file} → ${target}`).toBe(true)
      }
    }
  })
})
