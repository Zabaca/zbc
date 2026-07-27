import { r2Module } from '../../modules/r2'

// R2 bucket holding the warehouse's raw landings + parquet marts. Owned here
// (not by wrangler prompting at deploy time) so storage lifecycle is
// explicit infra; the warehouse instance imports this and wires it in via
// r2Bindings, which is what lets packages/warehouse/wrangler.jsonc stay a
// generic, symlinked template.
export default r2Module.instance({
  name: 'warehouse-bucket',
  config: {
    accountId: '99a19e584439be0568f33aad0477372b',
    bucketName: 'zbc-warehouse',
  },
})
