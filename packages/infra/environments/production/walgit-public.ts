import { cloudflareModule } from '../../modules/cloudflare'
import walgitPublicWal from './walgit-public-wal'
import zabacaZone from './zabaca-zone'

// walgit.zabaca.com — the public git host: no account, no token, no key.
//
// A Durable-Object-bound Container running packages/walgit's Dockerfile behind
// a thin Worker (docs/adr/0008), with the write-ahead log in its own R2 bucket.
// `git push https://walgit.zabaca.com/<name>.git` creates the repository;
// everything is world-readable and world-writable; refs are append-only, so
// nothing can be destroyed; and the only removal path is idle expiry.
//
// Every capability below is instance configuration and defaults to OFF in the
// package. That is the point: this deployment turns them on, and no other
// walgit deployment changes because it exists.
//
// ── the bucket ────────────────────────────────────────────────────────────
//
// `walgit-public-wal` is new and exclusive to this deployment, which is the one
// hard isolation requirement here: this is the only walgit instance that
// deletes repositories on a timer, and a defect in expiry must not be able to
// reach another deployment's storage.
//
// ── the hostname ──────────────────────────────────────────────────────────
//
// The route lives HERE, not in packages/walgit/wrangler.jsonc. A preview PR
// deploys that same file under a per-PR worker name, and a Cloudflare route is
// unique per zone — a route in the package config would let the most recently
// deployed preview quietly take production's traffic.
//
// The AAAA record lives in `zabaca-zone`, proxied, and this instance imports
// that one for ORDER, not for a value: the record has to exist before the route
// is claimed. Proxied is now correct where `git.zabaca.com` had to be grey —
// that record was unproxied only because SSH needs raw TCP, and SSH is gone.
//
// A wrangler custom domain is deliberately NOT used: it creates its own managed
// DNS record, which the zone module then reads as undeclared drift, and the two
// argue on every apply.
//
// ── credentials ───────────────────────────────────────────────────────────
//
// There are none for clients. `WALGIT_HTTP_TOKENS` is absent on purpose, and
// `WALGIT_PUBLIC=1` is what opens the door — the container REFUSES to boot with
// neither, so a deployment that loses its secrets fails closed rather than
// silently opening to the world.
//
// The log's own credentials are R2's S3-compatible pair, exposed under walgit's
// names via `{ name, secret }` rather than copied into secrets.yaml a second
// time. Cloudflare derives exactly one S3 credential per API token and R2's
// permission group is account-scoped, so a second token would reach every
// bucket this one does while adding a credential to rotate.
export default cloudflareModule.instance({
  name: 'walgit-public',
  imports: [walgitPublicWal, zabacaZone],
  config: {
    workdir: 'packages/walgit',
    accountId: '99a19e584439be0568f33aad0477372b',
    workerName: 'zbc-walgit-public',
    routes: ['walgit.zabaca.com/*'],
    // wrangler's gradual rollout never drains a single always-warm container,
    // so without this a redeployed image silently never takes effect until the
    // container idle-sleeps.
    immediateContainerRollout: true,
    workerSecrets: [
      { name: 'WALGIT_S3_ACCESS_KEY_ID', secret: 'WAREHOUSE_R2_ACCESS_KEY_ID' },
      { name: 'WALGIT_S3_SECRET_ACCESS_KEY', secret: 'WAREHOUSE_R2_SECRET_ACCESS_KEY' },
    ],
    workerVars: [
      // Not secrets, and none of them reach the client — but every one of them
      // reaches the CONTAINER only because worker/index.ts forwards it by name.
      { name: 'WALGIT_S3_BUCKET', from: 'walgit-public-wal', output: 'bucketName' },
      {
        name: 'WALGIT_S3_ENDPOINT',
        value: 'https://99a19e584439be0568f33aad0477372b.r2.cloudflarestorage.com',
      },
      // Open to anyone. Explicit rather than implied by the absence of tokens.
      { name: 'WALGIT_PUBLIC', value: '1' },
      // With writes open to anyone, this is what makes the service safe to
      // hand a stranger: a push may create or fast-forward a ref and may never
      // delete or rewrite one, so nothing anybody pushed can be destroyed.
      { name: 'WALGIT_APPEND_ONLY', value: '1' },
      // 99 MiB, and the number is measured rather than round. A chunked body
      // is uploaded IN FULL before the edge can answer, so a cap above the
      // chunked cutoff would be enforced only after ~37 s of upload, reported
      // as a dropped connection. walgit refuses in `pre-receive` instead,
      // before anything reaches the log.
      { name: 'WALGIT_MAX_PUSH_BYTES', value: String(99 * 1024 * 1024) },
      // 250 MiB total per repository — the size `git repack -adf` was measured
      // succeeding on in the Containers spike, which is the sizing case.
      { name: 'WALGIT_MAX_REPO_BYTES', value: String(250 * 1024 * 1024) },
      // ── expiry, deliberately not yet on ──────────────────────────────────
      //
      // Uncomment after a push and a clone have been verified against the LIVE
      // service. Expiry is the only path in walgit that destroys data, and
      // turning the destructive path on before the happy path is proven is how
      // a launch loses its first repositories. Unset means expiry is off
      // entirely, the container exposes no sweep endpoint, and `GET /` promises
      // no retention window — the page renders from this same variable, so it
      // cannot claim a window the sweeper does not enforce.
      //
      // { name: 'WALGIT_RETENTION_HOURS', value: '24' },
    ],
  },
})
