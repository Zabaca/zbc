import { r2Module } from '../../modules/r2'

// R2 bucket holding the inbox's raw MIME blobs. Owned here (not by wrangler
// prompting at deploy time) so storage lifecycle is explicit infra; the inbox
// instance imports this and wires it in via r2Bindings, which is what lets
// packages/inbox/wrangler.jsonc stay a generic, symlinked template.
export default r2Module.instance({
  name: 'inbox-raw',
  config: {
    accountId: '99a19e584439be0568f33aad0477372b',
    bucketName: 'zbc-inbox-raw',
  },
})
