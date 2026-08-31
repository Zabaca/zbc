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
    // Two hostnames, one worker. `agentgit.zabaca.com` is the name the service
    // launches under; `walgit.zabaca.com` stays routed so the remotes that
    // already exist keep resolving — a git remote is configuration on somebody
    // else's disk, and retiring a hostname breaks it silently on their next
    // push. The page renders whichever host the request arrived on, so both
    // read correctly rather than one advertising the other.
    routes: ['agentgit.zabaca.com/*', 'walgit.zabaca.com/*'],
    // wrangler's gradual rollout never drains a single always-warm container,
    // so without this a redeployed image silently never takes effect until the
    // container idle-sleeps.
    //
    // It covers the IMAGE and only the image. A deploy that changes a var below
    // and nothing else produces no new container version for it to roll, so it
    // is not what makes the values in `workerVars` reach the container — see
    // the note above `workerVars`.
    immediateContainerRollout: true,
    workerSecrets: [
      { name: 'WALGIT_S3_ACCESS_KEY_ID', secret: 'WAREHOUSE_R2_ACCESS_KEY_ID' },
      { name: 'WALGIT_S3_SECRET_ACCESS_KEY', secret: 'WAREHOUSE_R2_SECRET_ACCESS_KEY' },
      // The ref-event stream's announce credential, and the variable that turns
      // the stream on at all: with it unset there is no endpoint, and a
      // subscriber gets the same 404 as for any path that does not exist.
      //
      // A SECRET rather than a var, and the distinction is not cosmetic here.
      // `workerVars` are applied through `wrangler deploy --var`, i.e. on a
      // command line, while secrets are piped to `wrangler secret put` on
      // stdin. This value is what separates walgit's own push path from a
      // stranger fabricating ref events, so it takes the stdin path.
      //
      // It is generated for this deployment and shared with nothing: the
      // announcement is walgit talking to itself (the container's
      // `post-receive` calling back into its own Worker), so there is no second
      // party to agree a value with, and the S3-credential argument for reusing
      // an existing secret does not apply.
      { name: 'WALGIT_EVENTS_TOKEN', secret: 'WALGIT_PUBLIC_EVENTS_TOKEN' },
      // Signed pushes, and the whole of turning them on: `git-receive-pack`
      // advertises the `push-cert` capability if, and only if, the receiving
      // repository has `receive.certNonceSeed` set, so this one value is the
      // flag (docs/adr/0011). With it unset a client asking to sign is refused
      // by its OWN git, and both agent-facing documents render from the same
      // predicate, so neither offers a capability this host does not have.
      //
      // A SECRET rather than a var, for the reason above it: git derives every
      // push nonce as an HMAC of this seed, so knowing it is enough to forge
      // one, and `workerVars` are applied on a wrangler command line.
      //
      // GENERATED ONCE, AND NEVER AGAIN. A client holds a nonce across the
      // round trip between the ref advertisement and the push. Rotating this
      // value invalidates every nonce in flight, so a rotation is a window in
      // which signed pushes are silently recorded as unsigned — provenance
      // failing open, exactly as designed, for as long as the change takes to
      // reach every repository.
      { name: 'WALGIT_PUSH_CERT_SEED', secret: 'WALGIT_PUBLIC_PUSH_CERT_SEED' },
    ],
    // ── what propagates, and how ─────────────────────────────────────────
    //
    // Read this before changing anything below — or in `workerSecrets` above,
    // which propagates the same way. There are TWO readers of these values, on
    // two different schedules, and they used to disagree:
    //
    //   the Worker    — reconstructed on every deploy, so never stale. It
    //                   renders the landing page from these values directly.
    //   the container — a separate process that reads its environment ONCE, at
    //                   start. `GET /` in plain text, the `pre-receive` size
    //                   caps and the `/_walgit/expire` sweep endpoint all come
    //                   from that one read.
    //
    // A vars-only deploy therefore used to change the page and nothing else,
    // for as long as traffic kept the container awake — the page promising a
    // retention window the sweeper was not enforcing (ZBC-XR87OB). Neither
    // `immediateContainerRollout` (no new image, nothing to roll) nor reading
    // `process.env` per request in the container (a running process's
    // environment is fixed) fixes that; only a new container does.
    //
    // So the Durable Object fingerprints the environment it would boot with,
    // keeps that fingerprint in its own storage, and destroys the running
    // container the first time the two differ — `reconcileEnv` in
    // packages/walgit/worker/index.ts. Changing a var here costs one container
    // restart on the next request after the deploy, and the value is live.
    //
    // The one thing that does NOT propagate this way is a new NAME: a variable
    // reaches the container only if `CONTAINER_ENV` in
    // packages/walgit/worker/container-env.ts lists it. Adding an entry here
    // and not there deploys a variable the container never sees.
    workerVars: [
      // Not secrets, and none of them reach the client — but every one of them
      // reaches the CONTAINER only because worker/container-env.ts forwards it
      // by name.
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
      // ── expiry ───────────────────────────────────────────────────────────
      //
      // On, and it was gated rather than assumed: this stayed commented out
      // until a push and a clone had both been verified against the LIVE
      // service, because expiry is the only path in walgit that destroys data
      // and turning the destructive path on before the happy path is proven is
      // how a launch loses its first repositories. Both were verified on
      // 2026-08-29 against walgit.zabaca.com — an unauthenticated push, a clone
      // of it back, and a force-push refused by `pre-receive`.
      //
      // One variable, three consumers, which is the point: the sweeper
      // (worker/index.ts's cron) collects on it, `GET /` states it, and the
      // landing page claims it. Unset, all three go quiet together — no
      // sweep endpoint, no promise, no copy — so the window can never be
      // advertised by one of them and not enforced by another. That property
      // needs the container restart described above to hold across a deploy;
      // it was written before the restart existed, and did not.
      { name: 'WALGIT_RETENTION_HOURS', value: '24' },
      // ── ref events ───────────────────────────────────────────────────────
      //
      // Where the container announces a push TO — this deployment's own public
      // origin. The announcement is an outbound HTTP request made from inside
      // the container by `post-receive`, so it needs an address the container
      // can dial, and the Worker in front of these routes is the only thing
      // that can reach the Durable Object holding the sockets.
      //
      // `agentgit.zabaca.com` of the two routed hostnames, because that is the
      // name the service launches under; either would work (one worker answers
      // both), and this one is not a client-visible choice — no subscriber ever
      // sees this value, they connect to whichever host they already use.
      //
      // The credential half lives in `workerSecrets` above. Both are required:
      // `src/announce.ts` reads the pair and stays silent unless both are set,
      // so a half-configured deployment announces nothing rather than
      // announcing unauthenticated.
      { name: 'WALGIT_EVENTS_URL', value: 'https://agentgit.zabaca.com' },
    ],
  },
})
