import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { defineCommand } from 'citty'
import { detectMode } from '../utils/detect-mode'
import { copyTemplateDir, copyTemplateFile, templatesRoot } from '../utils/copy-template'
import { coreRefForVersion, DEFAULT_CORE_URL, subtreeAdd, VENDOR_PREFIX } from '../utils/subtree'
import pkg from '../../package.json' with { type: 'json' }

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function writeIfMissing(filePath: string, body: string): Promise<void> {
  const file = Bun.file(filePath)
  if (await file.exists()) {
    console.log(`  skip ${path.relative(process.cwd(), filePath)} (exists)`)
    return
  }
  await ensureDir(path.dirname(filePath))
  await Bun.write(filePath, body)
  console.log(`  write ${path.relative(process.cwd(), filePath)}`)
}

export const initCommand = defineCommand({
  meta: {
    name: 'init',
    description: 'Scaffold zbc infrastructure into the current repo',
  },
  args: {
    project: {
      type: 'positional',
      description: 'Project name (defaults to current directory name)',
      required: false,
    },
    ci: {
      type: 'string',
      description: 'CI provider to scaffold (e.g. "github")',
      required: false,
    },
    'no-sops': {
      type: 'boolean',
      description: 'Skip writing .sops.yaml',
      default: false,
    },
    'non-interactive': {
      type: 'boolean',
      description: 'Fail instead of prompting',
      default: false,
    },
    subtree: {
      type: 'boolean',
      description:
        'Vendor the zbc engine + modules as a git subtree at vendor/zbc instead of copying them',
      default: false,
    },
    'core-url': {
      type: 'string',
      description: `zbc-core repository for --subtree (default: ${DEFAULT_CORE_URL})`,
    },
    'core-ref': {
      type: 'string',
      description: 'zbc-core ref for --subtree (default: the tag matching this CLI version)',
    },
  },
  async run({ args }) {
    const cwd = process.cwd()
    const projectName = args.project ?? path.basename(cwd)
    const tplRoot = templatesRoot()

    console.log(`zbc init: ${projectName}`)
    console.log(`  cwd:       ${cwd}`)

    const mode = await detectMode(cwd)
    if (mode.kind === 'incompatible') {
      console.error(`✗ ${mode.reason}`)
      process.exit(1)
    }
    console.log(`  mode:      ${mode.kind}${args.subtree ? ' (subtree)' : ''}`)

    // 0. Subtree mode: vendor zbc-core FIRST — `git subtree add` demands a
    //    clean tree, so it must run before any scaffold file is written.
    if (args.subtree) {
      const url = args['core-url'] ?? DEFAULT_CORE_URL
      const ref = args['core-ref'] ?? coreRefForVersion(pkg.version)
      console.log(`  vendoring: ${url} @ ${ref} → ${VENDOR_PREFIX}`)
      try {
        subtreeAdd(cwd, { url, ref })
      } catch (err) {
        console.error(`✗ ${(err as Error).message}`)
        process.exit(1)
      }
    }

    const vars = { PROJECT_NAME: projectName }

    // 1. Greenfield-only root files
    if (mode.kind === 'greenfield') {
      await copyTemplateFile(
        path.join(tplRoot, 'root/package.json'),
        path.join(cwd, 'package.json'),
        { vars },
      )
      await copyTemplateFile(
        path.join(tplRoot, 'root/tsconfig.json'),
        path.join(cwd, 'tsconfig.json'),
        { vars },
      )
      await copyTemplateFile(path.join(tplRoot, 'gitignore'), path.join(cwd, '.gitignore'))
    }

    // 2. zbc.config.ts (both modes). Subtree mode rewrites the engine import:
    //    the '@<project>/infra' package's exports point at packages/infra/src,
    //    which subtree mode deliberately doesn't copy — the engine lives at
    //    vendor/zbc/src instead.
    const configPath = path.join(cwd, 'zbc.config.ts')
    await copyTemplateFile(path.join(tplRoot, 'zbc.config.ts'), configPath, { vars })
    if (args.subtree) {
      // Rewrite whether we just wrote the file or it pre-existed (brownfield
      // migration): any '@<name>/infra' engine import must become the vendor
      // path, since subtree mode doesn't provide packages/infra/src.
      const body = await Bun.file(configPath).text()
      const rewritten = body.replace(/'@[^']+\/infra'/g, `'./${VENDOR_PREFIX}/src/index'`)
      if (rewritten !== body) await Bun.write(configPath, rewritten)
    }

    // 3. .sops.yaml (unless --no-sops)
    if (!args['no-sops']) {
      await copyTemplateFile(path.join(tplRoot, 'sops.yaml'), path.join(cwd, '.sops.yaml'))
    }

    // 4. packages/infra/ skeleton (always). Exclude modules — those are added
    //    on demand via `zbc add` — and README.md, which documents the zbc-core
    //    split repo, not the consumer's infra dir. Subtree mode also excludes
    //    src/: the engine is imported from vendor/zbc, never copied.
    const infraDest = path.join(cwd, 'packages/infra')
    await copyTemplateDir(path.join(tplRoot, 'infra'), infraDest, {
      vars,
      excludeTests: true,
      exclude: ['modules', 'README.md', ...(args.subtree ? ['src'] : [])],
    })

    // 4b. Subtree mode: the infra package.json ships exports "." → ./src/index.ts,
    //     which is unresolvable when src/ lives in vendor/zbc instead. Strip the
    //     exports whenever the engine src is absent (fresh subtree init, or a
    //     brownfield repo migrating after deleting its copied src).
    if (args.subtree && !(await Bun.file(path.join(infraDest, 'src/index.ts')).exists())) {
      const pkgPath = path.join(infraDest, 'package.json')
      const pkgBody = JSON.parse(await Bun.file(pkgPath).text()) as Record<string, unknown>
      if (pkgBody.exports !== undefined) {
        delete pkgBody.exports
        await Bun.write(pkgPath, `${JSON.stringify(pkgBody, null, 2)}\n`)
        console.log('  strip packages/infra/package.json exports (engine lives in vendor/zbc)')
      }
    }

    // 5. environments/ dirs with .gitkeep
    for (const env of ['production', 'preview']) {
      const envDir = path.join(infraDest, 'environments', env)
      await ensureDir(envDir)
      await writeIfMissing(path.join(envDir, '.gitkeep'), '')
    }

    // 6. CI workflows
    if (args.ci === 'github') {
      const wfDest = path.join(cwd, '.github/workflows')
      await copyTemplateDir(path.join(tplRoot, 'workflows'), wfDest)
    } else if (args.ci) {
      console.warn(`  warn: unknown --ci=${args.ci} (only "github" supported)`)
    }

    // 7. Claude Code scaffolding (skip-if-exists, safe in either mode)
    await copyTemplateFile(path.join(tplRoot, 'CLAUDE.md'), path.join(cwd, 'CLAUDE.md'), {
      vars,
    })
    await copyTemplateDir(path.join(tplRoot, 'claude'), path.join(cwd, '.claude'))

    console.log('')
    console.log('✓ init done')
    if (args.subtree) {
      console.log(
        `  engine + modules vendored at ${VENDOR_PREFIX}/ — commit the scaffold, then never mix ${VENDOR_PREFIX}/ and other paths in one commit (subtree push sends prefix-touching commits upstream)`,
      )
    }
    console.log('')
    if (mode.kind === 'greenfield') {
      console.log('Next steps:')
      console.log('  1. bun install')
      console.log('  2. Add your age public keys to .sops.yaml')
      console.log('  3. bunx @zabaca/zbc add turso       # or cloudflare')
    } else {
      console.log('Next steps:')
      console.log('  1. bun install                       # pick up packages/infra')
      console.log('  2. Add your age public keys to .sops.yaml')
      console.log('  3. bunx @zabaca/zbc add turso       # or cloudflare')
    }
  },
})
