import { r2Module } from '../../modules/r2'

// The write-ahead log itself — the source of truth for every repository walgit
// serves (docs/adr/0007). The bare repos on the Fly machine's filesystem are a
// cache rebuilt from what lands here, so this bucket outliving the machine is
// the whole premise: losing it is losing every repo, and losing the machine is
// losing nothing.
//
// Its own bucket, not a corner of zbc-warehouse. `findOrphans` reclaims by
// diffing the WAL key prefix against index.json, so anything else writing under
// this bucket would be answered for by a garbage collector that does not own
// it — and the two have unrelated lifecycles besides.
export default r2Module.instance({
  name: 'walgit-wal',
  config: {
    accountId: '99a19e584439be0568f33aad0477372b',
    bucketName: 'zbc-walgit-wal',
  },
})
