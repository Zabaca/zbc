import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  appCases,
  appPackageOf,
  buildAncestorIndex,
  buildAppIndex,
  classifyAppFile,
  gitBlobHash,
  surveyApp,
  classify,
  findEscapeHatches,
  hatchDirs,
  normalize,
  parseModuleLog,
  revision as rev,
  schemaKeys,
  shippedModules,
  similarity,
} from './consumer-survey'

const v1 = `export const m = defineModule({ name: 'd1', apply() { return 1 } })`
const v2 = `export const m = defineModule({ name: 'd1', apply() { return 2 } })`

describe('classify', () => {
  test('a verbatim copy of any past revision is stale, not a consumer idea', () => {
    const history = [rev('newest', v2), rev('older', v1)]
    expect(classify(v1, history)).toEqual({ verdict: 'stale', matchedRev: 'older' })
  })

  test('a copy of the newest revision is current, not upgrade debt', () => {
    expect(classify(v2, [rev('newest', v2), rev('older', v1)])).toEqual({
      verdict: 'current',
      matchedRev: 'newest',
    })
  })

  test('a module with no upstream of that name is novel', () => {
    expect(classify(v1, [])).toEqual({ verdict: 'novel' })
  })

  test('names the file a revision lived at, so a divergent copy can be diffed against it', () => {
    const history = [
      rev('newest', 'x\ny\nz', '2026-09-01', 'packages/cli/templates/infra/modules/d1/index.ts'),
      rev('42de911', v1, '2026-04-24', 'packages/infra/modules/d1/index.ts'),
    ]
    const result = classify(`${v1}\n// edited`, history)
    expect(result).toMatchObject({ verdict: 'divergent', nearestRev: '42de911' })
    expect(result.nearestPath).toBe('packages/infra/modules/d1/index.ts')
  })

  test('a copy of a module we no longer ship is stale, even at its last revision', () => {
    expect(classify(v2, [rev('newest', v2), rev('older', v1)], false)).toEqual({
      verdict: 'stale',
      matchedRev: 'newest',
    })
  })

  test('a reformatted copy is not an edit — quote style is not a consumer idea', () => {
    const prettier = `export const m = defineModule({ name: "d1", apply() { return 1 } });`
    expect(classify(prettier, [rev('newest', v2), rev('older', v1)])).toEqual({
      verdict: 'stale',
      matchedRev: 'older',
      formattingOnly: true,
    })
  })

  test('an edited copy is divergent and names the revision to diff against', () => {
    const edited = `${v1}\n// plus a thing we needed`
    const result = classify(edited, [rev('newest', v2), rev('older', v1)])
    expect(result.verdict).toBe('divergent')
    expect(result.nearestRev).toBe('older')
    expect(result.similarity).toBeGreaterThan(0)
  })

  test('nearest is by content, not by recency — the point is a readable diff', () => {
    const drifted = `${v1}\n// one extra line`
    // 'newest' is first in history but 'ancestor' is what they actually forked.
    const result = classify(drifted, [rev('newest', 'a\nb\nc\nd\ne\nf'), rev('ancestor', v1)])
    expect(result.nearestRev).toBe('ancestor')
  })
})

describe('similarity', () => {
  test('identical content scores 1', () => {
    expect(similarity(v1, v1)).toBe(1)
  })

  test('nothing shared scores 0', () => {
    expect(similarity('a\nb', 'c\nd')).toBe(0)
  })

  test('blank lines and indentation do not count as difference', () => {
    expect(similarity('a\n\n  b', 'a\nb')).toBe(1)
  })
})

describe('schemaKeys', () => {
  const source = `
export const d1Module = defineModule({
  name: 'd1',
  configSchema: z.object({
    accountId: z.string(),
    dbName: z.string(),
    migrations: z.object({ dir: z.string(), apply: z.boolean() }).optional(),
  }),
  outputs: z.object({
    databaseId: z.string(),
  }),
})`

  test('reads the top-level config keys that make up the interface', () => {
    expect(schemaKeys(source, 'configSchema')).toEqual(['accountId', 'dbName', 'migrations'])
  })

  test('nested keys are not top-level keys', () => {
    expect(schemaKeys(source, 'configSchema')).not.toContain('dir')
  })

  test('outputs read the same way', () => {
    expect(schemaKeys(source, 'outputs')).toEqual(['databaseId'])
  })

  test('a schema built some other way reports nothing rather than guessing', () => {
    expect(schemaKeys('const s = buildSchema()', 'configSchema')).toEqual([])
  })
})

describe('findEscapeHatches', () => {
  test('a provider CLI outside a module is the gap worth finding', () => {
    const hatches = findEscapeHatches([
      { path: 'scripts/deploy.sh', content: 'set -e\nwrangler deploy --env production' },
    ])
    expect(hatches).toEqual([
      {
        file: 'scripts/deploy.sh',
        line: 2,
        tool: 'wrangler',
        snippet: 'wrangler deploy --env production',
      },
    ])
  })

  test('the same call inside a module is the module doing its job', () => {
    expect(
      findEscapeHatches([
        { path: 'packages/infra/modules/cloudflare/index.ts', content: 'exec("wrangler deploy")' },
      ]),
    ).toEqual([])
  })

  test('a sops call counts — it is what `zbc secret get` replaces', () => {
    const calls = [
      `TOKEN=$(sops -d --extract '["X"]' secrets.yaml)`,
      `sops exec-env secrets.yaml 'bun run seed'`,
      `const r = spawnSync('sops', ['-d', file])`,
      `Bun.spawnSync(['sops', '--decrypt', file])`,
      `execFileSync("sops", ["decrypt", file])`,
      // an option before the action
      'sops --output-type dotenv -d secrets.yaml > .env',
      'sops -i -e secrets.yaml',
      `sops --set '["K"] "v"' secrets.yaml`,
      'sops rotate -i secrets.yaml',
    ]
    const hatches = findEscapeHatches(
      calls.map((content, i) => ({ path: `scripts/${i}.ts`, content })),
    )
    expect(hatches.map((h) => h.tool)).toEqual(calls.map(() => 'sops'))
  })

  test('a sops call split over a backslash continuation counts once, on its first line', () => {
    const content = ['TOKEN=$(sops \\', '  --decrypt secrets.yaml)', 'echo done'].join('\n')
    expect(findEscapeHatches([{ path: 'scripts/read.sh', content }]).map((h) => h.line)).toEqual([
      1,
    ])
  })

  test('the word sops in an error, a guard or a comment is not a call', () => {
    const files = [
      {
        path: 'scripts/a.ts',
        content: `throw new Error('set X (see the header for the sops command)')`,
      },
      { path: 'scripts/b.sh', content: 'command -v sops >/dev/null || exit 1' },
      { path: 'scripts/c.sh', content: '# decrypt with sops -d secrets.yaml' },
      { path: '.github/workflows/d.yml', content: '  # sops -d runs in the next step' },
      { path: 'scripts/e.ts', content: 'throw new FleetError("sops", "decrypt failed")' },
      { path: 'scripts/f.sh', content: 'brew install sops age' },
      { path: 'scripts/g.sh', content: 'sops --version' },
    ]
    expect(findEscapeHatches(files)).toEqual([])
  })

  test("a gh api call counts, unless the line is one of zbc's own workflows", () => {
    const line = 'EXISTING=$(gh api "repos/$REPO/issues/$PR/comments" --jq ".[0].id")'
    const ours = new Set([line])
    const copied = [{ path: '.github/workflows/preview.yml', content: `          ${line}` }]
    expect(findEscapeHatches(copied, ours)).toEqual([])
    const own = [{ path: 'scripts/comment.sh', content: line }]
    expect(findEscapeHatches(own, ours).map((h) => h.tool)).toEqual(['gh api'])
  })

  test('comments mentioning a CLI are not calls to it', () => {
    expect(
      findEscapeHatches([{ path: 'scripts/a.ts', content: '// run wrangler deploy by hand' }]),
    ).toEqual([])
  })
})

describe('parseModuleLog', () => {
  const log = [
    '@feee322 2026-07-10',
    '',
    'packages/cli/templates/infra/modules/vercel/index.ts',
    '@d82840f 2026-04-29',
    '',
    'packages/cli/templates/infra/modules/turso/index.ts',
    'packages/cli/modules/vercel/index.ts',
    '@42de911 2026-04-24',
    '',
    'packages/infra/modules/turso/index.ts',
  ].join('\n')

  test('every home a module has lived in, under the name it had there', () => {
    expect(parseModuleLog(log).map((e) => `${e.rev} ${e.name} ${e.file}`)).toEqual([
      'feee322 vercel packages/cli/templates/infra/modules/vercel/index.ts',
      'd82840f turso packages/cli/templates/infra/modules/turso/index.ts',
      'd82840f vercel packages/cli/modules/vercel/index.ts',
      '42de911 turso packages/infra/modules/turso/index.ts',
    ])
  })

  test('carries the commit date onto each entry', () => {
    expect(parseModuleLog(log)[3].date).toBe('2026-04-24')
  })

  test('a file below a module directory is not a module', () => {
    const nested =
      '@abc 2026-01-01\npackages/cli/templates/infra/modules/vm/node_modules/x/index.ts'
    expect(parseModuleLog(nested)).toEqual([])
  })
})

describe('hatchDirs', () => {
  test('a consumer at the repo root is scanned where it always was', () => {
    expect(hatchDirs()).toEqual(['scripts', 'packages/infra', '.github'])
  })

  test('a consumer under a root keeps the repo-level scripts and workflows', () => {
    expect(hatchDirs('deploy')).toEqual([
      'scripts',
      'deploy/scripts',
      'deploy/packages/infra',
      '.github',
    ])
  })
})

/** A throwaway git repo, so the history-reading half can be tested against real git. */
function scratchRepo(): {
  dir: string
  git: (...args: string[]) => void
  write: (rel: string, content: string) => void
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-survey-'))
  const git = (...args: string[]) => {
    const r = spawnSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd: dir, encoding: 'utf8' },
    )
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), content)
  }
  git('init', '-q', '-b', 'main')
  return { dir, git, write }
}

const templateModule = (name: string) => `packages/cli/templates/infra/modules/${name}/index.ts`

describe('shippedModules', () => {
  test('a deleted module is not shipped, even while an ignored file keeps its directory', () => {
    const { dir, git, write } = scratchRepo()
    try {
      write('.gitignore', '.DS_Store\n')
      write(templateModule('turso'), v1)
      write(templateModule('vercel'), v2)
      git('add', '-A')
      git('commit', '-qm', 'two modules')
      write('packages/cli/templates/infra/modules/vercel/.DS_Store', 'x')
      git('rm', '-q', templateModule('vercel'))
      git('commit', '-qm', 'delete vercel')
      expect(fs.existsSync(path.join(dir, 'packages/cli/templates/infra/modules/vercel'))).toBe(
        true,
      )
      expect([...shippedModules(dir)]).toEqual(['turso'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildAncestorIndex', () => {
  test('a revision that only a merge produced is indexed, so a copy of it is current', () => {
    const { dir, git, write } = scratchRepo()
    try {
      const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`)
      write(templateModule('d1'), lines.join('\n'))
      git('add', '-A')
      git('commit', '-qm', 'base')
      git('switch', '-qc', 'side')
      write(templateModule('d1'), ['side', ...lines.slice(1)].join('\n'))
      git('commit', '-qam', 'edit the top')
      git('switch', '-q', 'main')
      write(templateModule('d1'), [...lines.slice(0, 9), 'main'].join('\n'))
      git('commit', '-qam', 'edit the bottom')
      git('merge', '-q', '--no-edit', 'side')
      const merged = fs.readFileSync(path.join(dir, templateModule('d1')), 'utf8')
      expect(merged).toBe(['side', ...lines.slice(1, 9), 'main'].join('\n'))
      expect(classify(merged, buildAncestorIndex(dir).d1)).toMatchObject({ verdict: 'current' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a merge that only carries a branch's blob over adds no revision of its own", () => {
    const { dir, git, write } = scratchRepo()
    try {
      write(templateModule('d1'), v1)
      git('add', '-A')
      git('commit', '-qm', 'base')
      git('switch', '-qc', 'pr')
      write(templateModule('d1'), v2)
      git('commit', '-qam', 'the edit')
      git('switch', '-q', 'main')
      write('README.md', 'unrelated')
      git('add', '-A')
      git('commit', '-qm', 'main moves on')
      git('merge', '-q', '--no-ff', '--no-edit', 'pr')
      const history = buildAncestorIndex(dir).d1
      expect(history).toHaveLength(2)
      expect(classify(`${v2}\n// edited`, history).nearestRev).toBe(history[0].rev)
      expect(history[0].rev).not.toBe(
        spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim(),
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a module that moved keeps its old home's history, under the path it had", () => {
    const { dir, git, write } = scratchRepo()
    try {
      write('packages/cli/modules/turso/index.ts', v1)
      git('add', '-A')
      git('commit', '-qm', 'turso in its first home')
      git('mv', 'packages/cli/modules', 'packages/cli/templates-tmp')
      fs.mkdirSync(path.join(dir, 'packages/cli/templates/infra'), { recursive: true })
      git('mv', 'packages/cli/templates-tmp', 'packages/cli/templates/infra/modules')
      write(templateModule('turso'), v2)
      git('commit', '-qam', 'move it under templates and edit it')
      const history = buildAncestorIndex(dir).turso
      expect(history.map((r) => r.file)).toEqual([
        templateModule('turso'),
        'packages/cli/modules/turso/index.ts',
      ])
      expect(classify(`${v1}\n// edited`, history).nearestPath).toBe(
        'packages/cli/modules/turso/index.ts',
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('revision', () => {
  test('carries the date, so a reviewer can see which side is older', () => {
    expect(rev('abc', v1, '2026-08-19').date).toBe('2026-08-19')
  })
})

describe('normalize', () => {
  test('quote style, trailing punctuation, indent and blank lines all collapse', () => {
    expect(normalize('  const a = "x";\n\n  const b = [1,];\n')).toBe(
      "const a = 'x'\nconst b = [1,]",
    )
  })

  test('comments survive — a consumer comment is often the finding', () => {
    expect(normalize('// recon was public for 20 minutes\ncode()')).toContain(
      '// recon was public for 20 minutes',
    )
  })
})

const appFile = (rel: string) => `packages/cli/templates/apps/demo/${rel}`

/** A repository that shipped an app's folder at two revisions: `a.ts` changed, `b.ts` did not, `c.ts` came second. */
function appUpstream() {
  const repo = scratchRepo()
  repo.write(appFile('packages/one/a.ts'), 'export const a = 1\n')
  repo.write(appFile('packages/one/b.ts'), 'export const b = 1\n')
  repo.write(appFile('zbc-app.json'), '{ "name": "demo" }\n')
  repo.git('add', '-A')
  repo.git('commit', '-qm', 'the app')
  repo.write(appFile('packages/one/a.ts'), 'export const a = 2\n')
  repo.write(appFile('kit/c.ts'), 'export const c = 1\n')
  repo.git('add', '-A')
  repo.git('commit', '-qm', 'a newer app')
  return repo
}

/** A consumer's copy of the app's folder, as plain files. */
function appCopy(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-app-'))
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), content)
  }
  return dir
}

const NEWEST = {
  'packages/one/a.ts': 'export const a = 2\n',
  'packages/one/b.ts': 'export const b = 1\n',
  'kit/c.ts': 'export const c = 1\n',
  'zbc-app.json': '{ "name": "demo" }\n',
}

describe('gitBlobHash', () => {
  test('is the id git gives the same bytes', () => {
    const { dir, write } = scratchRepo()
    try {
      write('x.txt', 'some bytes\n')
      const said = spawnSync('git', ['hash-object', 'x.txt'], { cwd: dir, encoding: 'utf8' })
      expect(gitBlobHash(fs.readFileSync(path.join(dir, 'x.txt')))).toBe(said.stdout.trim())
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a vendored app, file by file', () => {
  test('a copy of the newest revision is current, every file of it', () => {
    const up = appUpstream()
    const copy = appCopy(NEWEST)
    try {
      expect(surveyApp(copy, buildAppIndex('demo', up.dir))).toEqual({
        verdict: 'current',
        files: 4,
        current: 4,
        stale: [],
        edited: [],
        own: [],
        removed: [],
      })
    } finally {
      fs.rmSync(up.dir, { recursive: true, force: true })
      fs.rmSync(copy, { recursive: true, force: true })
    }
  })

  test('a copy of an older revision is stale: the file that moved on, and the file it never received', () => {
    const up = appUpstream()
    const copy = appCopy({
      'packages/one/a.ts': 'export const a = 1\n',
      'packages/one/b.ts': 'export const b = 1\n',
      'zbc-app.json': '{ "name": "demo" }\n',
    })
    try {
      expect(surveyApp(copy, buildAppIndex('demo', up.dir))).toMatchObject({
        verdict: 'stale',
        current: 2,
        stale: ['packages/one/a.ts'],
        edited: [],
        own: [],
        removed: ['kit/c.ts'],
      })
    } finally {
      fs.rmSync(up.dir, { recursive: true, force: true })
      fs.rmSync(copy, { recursive: true, force: true })
    }
  })

  test('a file no revision shipped at that path is an edit, and a file never shipped is the consumer’s own', () => {
    const up = appUpstream()
    const copy = appCopy({
      ...NEWEST,
      'packages/one/b.ts': 'export const b = 1 // ours\n',
      'NOTES.md': 'ours\n',
      'node_modules/dep/index.js': 'not read\n',
    })
    try {
      expect(surveyApp(copy, buildAppIndex('demo', up.dir))).toMatchObject({
        verdict: 'edited',
        files: 5,
        current: 3,
        stale: [],
        edited: ['packages/one/b.ts'],
        own: ['NOTES.md'],
        removed: [],
      })
    } finally {
      fs.rmSync(up.dir, { recursive: true, force: true })
      fs.rmSync(copy, { recursive: true, force: true })
    }
  })

  test('a reformat is an edit here: the folder is pulled, not retyped', () => {
    const up = appUpstream()
    try {
      const index = buildAppIndex('demo', up.dir)
      const reformatted = gitBlobHash(new TextEncoder().encode('export const a = 2;\n'))
      expect(classifyAppFile('packages/one/a.ts', reformatted, index)).toBe('edited')
      // The old content at a path it never had is an edit of that path, not a stale copy of another.
      const old = gitBlobHash(new TextEncoder().encode('export const a = 1\n'))
      expect(classifyAppFile('packages/one/a.ts', old, index)).toBe('stale')
      expect(classifyAppFile('packages/one/b.ts', old, index)).toBe('edited')
    } finally {
      fs.rmSync(up.dir, { recursive: true, force: true })
    }
  })

  test('an app this repository never shipped has an empty index', () => {
    const up = appUpstream()
    try {
      expect(buildAppIndex('nothing', up.dir).newest.size).toBe(0)
    } finally {
      fs.rmSync(up.dir, { recursive: true, force: true })
    }
  })
})

/** One consumer's finding for an app, with what a case reads filled in. */
const finding = (over: object) => ({
  app: 'space',
  verdict: 'edited' as const,
  files: 0,
  current: 0,
  stale: [],
  edited: [],
  own: [],
  removed: [],
  ...over,
})

describe('app cases', () => {
  test('a path belongs to its package, the kit, another top folder, or the root', () => {
    expect(appPackageOf('packages/inbox/src/app.ts')).toBe('inbox')
    expect(appPackageOf('kit/instances.ts')).toBe('kit')
    expect(appPackageOf('docs/install.md')).toBe('docs')
    expect(appPackageOf('README.md')).toBe('(root)')
  })

  test('edits and own files are grouped per app and package, most consumers first; a current or stale copy is no case', () => {
    expect(
      appCases([
        { id: 'one', apps: [finding({ edited: ['packages/inbox/src/a.ts'], own: ['NOTES.md'] })] },
        { id: 'two', apps: [finding({ edited: ['packages/inbox/src/b.ts', 'kit/x.ts'] })] },
        { id: 'three', apps: [finding({ verdict: 'stale', stale: ['packages/meet/m.ts'] })] },
        { id: 'four' },
      ]),
    ).toEqual([
      {
        app: 'space',
        package: 'inbox',
        consumers: 2,
        implementations: [
          { consumer: 'one', edited: ['packages/inbox/src/a.ts'], own: [] },
          { consumer: 'two', edited: ['packages/inbox/src/b.ts'], own: [] },
        ],
      },
      {
        app: 'space',
        package: '(root)',
        consumers: 1,
        implementations: [{ consumer: 'one', edited: [], own: ['NOTES.md'] }],
      },
      {
        app: 'space',
        package: 'kit',
        consumers: 1,
        implementations: [{ consumer: 'two', edited: ['kit/x.ts'], own: [] }],
      },
    ])
  })
})
