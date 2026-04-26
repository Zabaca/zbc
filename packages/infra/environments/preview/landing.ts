import { vercelModule } from '../../modules/vercel'

const pr = process.env.PR_NUMBER ?? 'local'

export default vercelModule.instance({
  name: 'landing',
  config: {
    projectName: `zbc-landing-pr-${pr}`,
    teamId: 'team_rbh0EuPftWoCYgGfiHYBstEZ',
    framework: 'nextjs',
    sourceDir: '.',
    rootDirectory: 'packages/landing',
    production: false,
  },
})
