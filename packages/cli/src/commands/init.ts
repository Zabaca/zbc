import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { defineCommand } from 'citty'
import { detectMode } from '../utils/detect-mode'
import { copyTemplateDir, copyTemplateFile, templatesRoot } from '../utils/copy-template'

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
    console.log(`  mode:      ${mode.kind}`)

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

    // 2. zbc.config.ts (both modes)
    await copyTemplateFile(path.join(tplRoot, 'zbc.config.ts'), path.join(cwd, 'zbc.config.ts'), {
      vars,
    })

    // 3. .sops.yaml (unless --no-sops)
    if (!args['no-sops']) {
      await copyTemplateFile(path.join(tplRoot, 'sops.yaml'), path.join(cwd, '.sops.yaml'))
    }

    // 4. packages/infra/ skeleton (always). Exclude modules — those are
    //    added on demand via `zbc add`.
    const infraDest = path.join(cwd, 'packages/infra')
    await copyTemplateDir(path.join(tplRoot, 'infra'), infraDest, {
      vars,
      exclude: ['modules'],
    })

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
    console.log('')
    if (mode.kind === 'greenfield') {
      console.log('Next steps:')
      console.log('  1. bun install')
      console.log('  2. Add your age public keys to .sops.yaml')
      console.log('  3. bunx @zabaca/zbc add turso       # or vercel')
    } else {
      console.log('Next steps:')
      console.log('  1. bun install                       # pick up packages/infra')
      console.log('  2. Add your age public keys to .sops.yaml')
      console.log('  3. bunx @zabaca/zbc add turso       # or vercel')
    }
  },
})
