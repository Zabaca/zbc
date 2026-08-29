import { r2Module } from '../../modules/r2'

// The write-ahead log for the PUBLIC walgit deployment — the source of truth
// for every repository walgit.zabaca.com serves (docs/adr/0007). The bare repos
// on the container's disk are a cache rebuilt from what lands here, and that
// disk is wiped on every container restart, so this bucket outliving the
// container is the whole premise.
//
// Its own bucket, and this is the one hard isolation requirement of the public
// launch. The public instance is the only walgit deployment that DESTROYS data
// on a timer: the expiry sweeper collects anything idle past
// WALGIT_RETENTION_HOURS, and `findOrphans` reclaims by diffing the key prefix
// against index.json. A bucket shared with anything else would put both under a
// collector that does not own them, and a defect in expiry would then reach
// storage this deployment was never meant to touch.
//
// Deliberately NOT `zbc-walgit-wal`: that bucket belongs to the credentialed
// Fly deployment behind git.zabaca.com, whose repositories were pushed under a
// promise of no expiry at all.
export default r2Module.instance({
  name: 'walgit-public-wal',
  config: {
    accountId: '99a19e584439be0568f33aad0477372b',
    bucketName: 'zbc-walgit-public',
  },
})
