import * as path from 'node:path'
import { defineCommand } from 'citty'

export const initCommand = defineCommand({
  meta: {
    name: 'init',
    description: 'Scaffold a new project from template',
  },
  args: {
    project: {
      type: 'positional',
      description: 'Project name',
      required: true,
    },
  },
  async run({ args }) {
    const projectDir = path.resolve(process.cwd(), args.project)

    if (await Bun.file(path.join(projectDir, 'package.json')).exists()) {
      console.error(`Directory "${args.project}" already contains a package.json`)
      process.exit(1)
    }

    console.log(`Scaffolding project "${args.project}" at ${projectDir}...`)

    // TODO: Generate project files from embedded templates
    // For now, just create the directory structure
    const dirs = [
      'packages/web/src',
      'packages/db/src',
      'packages/config/src',
      'packages/cli/src',
      'packages/infra/src',
      'packages/infra/modules',
      'packages/infra/environments/production',
      'packages/infra/environments/preview',
      'packages/infra/environments/development',
      '.github/workflows',
    ]

    for (const dir of dirs) {
      await Bun.write(
        path.join(projectDir, dir, '.gitkeep'),
        '',
      )
    }

    console.log(`Project "${args.project}" scaffolded. Run \`cd ${args.project} && bun install\` to get started.`)
  },
})
