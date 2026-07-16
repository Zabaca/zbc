import { cloudflareModule } from '../../modules/cloudflare'
import inboxRaw from './inbox-raw'

// Agent-accessible inbox worker for mail.cedarpad.com (packages/inbox — a
// symlink into the generic cli/templates/apps/inbox package): the email()
// handler receives routed mail (metadata in a SQLite DO, raw MIME in R2), and
// /api/* exposes list/read/send behind the INBOX_TOKEN bearer secret. All
// per-project identity lives HERE, not in wrangler.jsonc: workerName renames
// the worker, r2Bindings attaches the imported bucket, and the DEFAULT_FROM
// var is a workerVars literal. The email instance imports this one so the
// worker exists before the catch-all routing rule references it by name.
export default cloudflareModule.instance({
  name: 'inbox',
  imports: [inboxRaw],
  config: {
    workdir: 'packages/inbox',
    accountId: '99a19e584439be0568f33aad0477372b',
    workerName: 'zbc-inbox',
    workerSecrets: ['INBOX_TOKEN'],
    workerVars: [{ name: 'DEFAULT_FROM', value: 'inbox@mail.cedarpad.com' }],
    r2Bindings: [{ binding: 'RAW', from: 'inbox-raw', output: 'bucketName' }],
  },
})
