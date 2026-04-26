import { vercelModule } from '../../modules/vercel'

const pr = process.env.PR_NUMBER ?? 'local'

export default vercelModule.instance({
  name: 'design-system-viewer',
  config: {
    projectName: `zbc-design-system-viewer-pr-${pr}`,
    teamId: 'team_rbh0EuPftWoCYgGfiHYBstEZ',
    production: false,
    build: {
      command: 'bun run build -- --filter=@zbc/design-system-viewer',
      outputDir: 'packages/design-system-viewer/dist',
    },
  },
})
