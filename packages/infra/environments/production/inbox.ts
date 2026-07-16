import { cloudflareModule } from '../../modules/cloudflare'

// Agent-accessible inbox worker for mail.cedarpad.com (packages/inbox): the
// email() handler receives routed mail (metadata in a SQLite DO, raw MIME in
// R2 bucket zbc-inbox-raw), and /api/* exposes list/read/send behind the
// INBOX_TOKEN bearer secret. No build step — public/ is a static page and
// wrangler bundles the worker. The email instance imports this one so the
// worker exists before the catch-all routing rule references it by name.
export default cloudflareModule.instance({
  name: 'inbox',
  config: {
    workdir: 'packages/inbox',
    accountId: '99a19e584439be0568f33aad0477372b',
    workerSecrets: ['INBOX_TOKEN'],
  },
})
