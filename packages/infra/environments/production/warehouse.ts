import { cloudflareModule } from '../../modules/cloudflare'
import warehouseBucket from './warehouse-bucket'

// Data warehouse / BI pipeline (docs/adr/0004, packages/warehouse — a
// symlink into the generic cli/templates/apps/warehouse package): a
// DO-bound Container runs dlt + dbt-duckdb one-shot on a daily Cron
// Trigger, materializing schema-declared parquet marts into the imported
// bucket; GET /marts/:name and POST /materialize are gated behind the
// WAREHOUSE_TOKEN bearer secret. Ships with one reference connector
// (GitHub, scoped to GITHUB_OWNER/GITHUB_REPO below — dogfooding this repo
// itself; change if a different target repo is wanted).
//
// No local build — wrangler bundles the worker and builds the container
// from the package's Dockerfile (Docker must be running at apply time, on a
// Workers Paid plan with Containers enabled). Single always-warm-ish DO, but
// the container sleeps between materialize runs rather than staying up —
// roll immediately anyway so a redeployed pipeline image can't linger.
export default cloudflareModule.instance({
  name: 'warehouse',
  imports: [warehouseBucket],
  config: {
    workdir: 'packages/warehouse',
    accountId: '99a19e584439be0568f33aad0477372b',
    workerName: 'zbc-warehouse',
    // WAREHOUSE_R2_ACCESS_KEY_ID/SECRET below are R2's S3-compatible credentials,
    // derived from CLOUDFLARE_API_TOKEN itself (Access Key ID = the token's id,
    // Secret Access Key = sha256(token value) — Cloudflare's documented derivation),
    // not a separately minted credential. The container writes marts directly to R2
    // over the S3 API (it's a separate process outside the Worker's binding graph, so
    // it can't use the WAREHOUSE_BUCKET r2Binding below — that's for the Worker's own
    // edge mart reads only).
    workerSecrets: [
      'WAREHOUSE_TOKEN',
      'GITHUB_TOKEN',
      'WAREHOUSE_R2_ACCESS_KEY_ID',
      'WAREHOUSE_R2_SECRET_ACCESS_KEY',
    ],
    workerVars: [
      { name: 'GITHUB_OWNER', value: 'Zabaca' },
      { name: 'GITHUB_REPO', value: 'zbc' },
      { name: 'WAREHOUSE_BUCKET_NAME', value: 'zbc-warehouse' },
      {
        name: 'WAREHOUSE_R2_ENDPOINT',
        value: 'https://99a19e584439be0568f33aad0477372b.r2.cloudflarestorage.com',
      },
    ],
    r2Bindings: [{ binding: 'WAREHOUSE_BUCKET', from: 'warehouse-bucket', output: 'bucketName' }],
    immediateContainerRollout: true,
  },
})
