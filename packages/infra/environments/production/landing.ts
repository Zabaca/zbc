import { vercelModule } from '../../modules/vercel'
import nats from './nats'

// SSR deploy: upload the whole repo, Vercel auto-detects Turborepo +
// the Next.js project at rootDirectory and handles install + build.
export default vercelModule.instance({
  name: 'landing',
  imports: [nats],
  config: {
    projectName: 'zbc-landing',
    teamId: 'team_rbh0EuPftWoCYgGfiHYBstEZ',
    framework: 'nextjs',
    sourceDir: '.',
    rootDirectory: 'packages/landing',
  },
})
