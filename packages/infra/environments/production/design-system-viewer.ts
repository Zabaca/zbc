import { vercelModule } from '../../modules/vercel'

// Static deploy: build locally with Turbo, upload the prebuilt dist.
// No SSR, no Vercel-side build — Vercel just serves the static files.
export default vercelModule.instance({
  name: 'design-system-viewer',
  config: {
    projectName: 'zbc-design-system-viewer',
    teamId: 'team_rbh0EuPftWoCYgGfiHYBstEZ',
    build: {
      command: 'bun run build -- --filter=@zbc/design-system-viewer',
      outputDir: 'packages/design-system-viewer/dist',
    },
  },
})
