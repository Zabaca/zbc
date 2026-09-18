import { cloudflareModule } from '../../modules/cloudflare'
import walgitPublicWal from './walgit-public-wal'
import zabacaZone from './zabaca-zone'
import agentgitZone from './agentgit-zone'

// agentgit.co — the public git host: no account, no token, no key.
//
// A Durable-Object-bound Container running packages/walgit's Dockerfile behind
// a thin Worker (docs/adr/0008), with the write-ahead log in its own R2 bucket.
// `git push https://agentgit.co/<name>.git` creates the repository;
// everything is world-readable until a claimed name writes a Reader List and
// world-writable until one writes a Signer List; refs are append-only, so
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
// The AAAA records live in `agentgit-zone` (agentgit.co, www) and `zabaca-zone`
// (the two legacy names), proxied, and this instance imports both for ORDER,
// not for a value: the record has to exist before the route is claimed. Proxied is now correct where `git.zabaca.com` had to be grey —
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
  imports: [walgitPublicWal, agentgitZone, zabacaZone],
  config: {
    workdir: 'packages/walgit',
    accountId: '99a19e584439be0568f33aad0477372b',
    workerName: 'zbc-walgit-public',
    // Four hostnames, one worker. `agentgit.co` is the name the service
    // launches under (bought 2026-09-18), `www` alongside it; the two
    // `zabaca.com` names stay routed so the remotes that already exist keep
    // resolving — a git remote is configuration on somebody else's disk, and
    // retiring a hostname breaks it silently on their next push. The page
    // renders whichever host the request arrived on, so every one reads
    // correctly rather than advertising another.
    routes: ['agentgit.co/*', 'www.agentgit.co/*', 'agentgit.zabaca.com/*', 'walgit.zabaca.com/*'],
    // Rolls the container APPLICATION to the new image instead of wrangler's
    // gradual default. Necessary, and on its own it has never been sufficient:
    // it does not drain the single always-warm instance this deployment runs,
    // so the old container keeps serving until it idle-sleeps, which under
    // sustained traffic is never. That is not a theory — on 2026-09-14 the
    // 0.16.1 deploy moved the application to v51 with a new image, reported the
    // rollout `completed`, and left the instance started an hour earlier
    // answering git with the pre-0.16.1 clone recipe (ZBC-OA7D84).
    //
    // And it covers the image only: a deploy that changes a var below and
    // nothing else produces no new container version for it to roll.
    //
    // What actually replaces a running container is the line below, in both
    // cases — see the note above `workerVars`.
    immediateContainerRollout: true,
    // Every deploy names itself, as `WALGIT_BUILD_ID`: the deployed commit
    // (`GITHUB_SHA` in CI, `git rev-parse HEAD` locally). It configures
    // nothing. It exists so that a deploy carrying only new CODE still changes
    // the environment the Durable Object fingerprints, which is what makes the
    // replacement below fire for a code-only release exactly as it already
    // fires for a changed var. `WALGIT_BUILD_ID` is on `CONTAINER_ENV`
    // (packages/walgit/shared/container-env.ts), which is the only reason it
    // reaches the container at all.
    //
    // Second thing it buys: Cloudflare numbers container versions itself (v50,
    // v51) and nothing else in a deploy says which commit is inside one. This
    // var does, on the Worker's own settings page.
    deployIdVar: 'WALGIT_BUILD_ID',
    workerSecrets: [
      { name: 'WALGIT_S3_ACCESS_KEY_ID', secret: 'WAREHOUSE_R2_ACCESS_KEY_ID' },
      { name: 'WALGIT_S3_SECRET_ACCESS_KEY', secret: 'WAREHOUSE_R2_SECRET_ACCESS_KEY' },
      // The ref-event stream's announce credential. One of the two variables
      // that turn the stream on — `WALGIT_EVENTS_URL` below is the other, and
      // both are required: with either unset there is no endpoint, and a
      // subscriber gets the same 404 as for any path that does not exist. The
      // token alone would claim the socket while the container's
      // `post-receive` had nowhere to announce to, so the handshake would
      // answer and nothing would ever arrive (shared/capabilities.ts).
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
      // ── Private ──────────────────────────────────────────────────────────
      //
      // A claimed repository may also name the keys allowed to READ it, in a
      // `readers` file beside `signers` on the same ref, and while it has one
      // every clone, fetch, provenance read and event subscription is refused
      // unless the reader signs the host's challenge (docs/adr/0013). No
      // account, no token: the credential is an ssh signature, and
      // `@zabaca/agentgit`'s helper makes it the thing git asks for.
      //
      // A SECRET, and a SEED rather than a flag — the same shape as the
      // certificate seed above and for the same reason. The Read Challenge's
      // nonce is `HMAC(this value, the five-minute window)`, so knowing it is
      // enough to mint a challenge, and `workerVars` are applied on a wrangler
      // command line. Any non-blank value turns the capability on.
      //
      // Set BESIDE `WALGIT_SIGNER_LISTS` and `WALGIT_PUBLIC`, never without
      // either, and the container enforces the first of those itself: a Reader
      // List lives in the Signer List's tree and is written by a push that list
      // judged, so on a name anyone may push to it protects nothing — the next
      // stranger adds themselves to it. The second is a transport limit rather
      // than a policy one: the challenge is answered as Basic auth, in the one
      // `authorization` header a deployment token would occupy, so on a
      // credentialed host nobody could present a signature at all. This
      // deployment has both, above.
      //
      // GENERATED ONCE. A reader holds a nonce for five minutes (two windows
      // are accepted), so rotating this refuses every credential in flight —
      // a clone in progress fails, and a running `agentgit watch` is dropped
      // until it reconnects. Cheaper than the certificate seed's rotation and
      // still not free.
      //
      // Turning it back OFF is not destructive and does not need to be
      // rehearsed: absence of a `readers` file is the switch, so with the seed
      // gone every repository is world-readable again and no document mentions
      // readers (`namesCanBePrivate`, shared/capabilities.ts). What it is NOT
      // is reversible for whoever pushed private work in the meantime.
      { name: 'WALGIT_PRIVATE_REPOS', secret: 'WALGIT_PUBLIC_PRIVATE_REPOS_SEED' },
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
    // A deploy that changes only CODE used to slip past that, for the mirror
    // reason: no var moved, so the fingerprint did not either, and the
    // container kept serving the old image (ZBC-OA7D84). `deployIdVar` above
    // closes it by making every deploy change one var — so both halves of a
    // release, its configuration and its code, now reach the container on the
    // first request after the deploy.
    //
    // The one thing that does NOT propagate this way is a new NAME: a variable
    // reaches the container only if `CONTAINER_ENV` in
    // packages/walgit/shared/container-env.ts lists it. Adding an entry here
    // and not there deploys a variable the container never sees.
    workerVars: [
      // Not secrets, and none of them reach the client — but every one of them
      // reaches the CONTAINER only because shared/container-env.ts forwards it
      // by name.
      { name: 'WALGIT_S3_BUCKET', from: 'walgit-public-wal', output: 'bucketName' },
      {
        name: 'WALGIT_S3_ENDPOINT',
        value: 'https://99a19e584439be0568f33aad0477372b.r2.cloudflarestorage.com',
      },
      // Open to anyone. Explicit rather than implied by the absence of tokens.
      { name: 'WALGIT_PUBLIC', value: '1' },
      // Who runs agentgit, and where a takedown or a question goes. Edge-only:
      // shared/operator.ts reads these in the Worker and `CONTAINER_ENV` does
      // not forward them, so a copy edit here never restarts the container.
      // Neither set means the page prints no operator block at all, which is
      // what agentgit.zabaca.com showed until 2026-09-16.
      { name: 'WALGIT_OPERATOR', value: 'Zabaca' },
      { name: 'WALGIT_CONTACT', value: 'https://github.com/Zabaca/zbc/issues' },
      // With writes open to anyone, this is what makes the service safe to
      // hand a stranger: a push may create or fast-forward a ref and may never
      // delete or rewrite one, so nothing anybody pushed can be destroyed.
      { name: 'WALGIT_APPEND_ONLY', value: '1' },
      // ── ownership ────────────────────────────────────────────────────────
      //
      // A repository may name the keys allowed to push to it, on
      // `refs/walgit/signers`, and while it holds that list a push signed by
      // anything else is refused. Reads are untouched by THIS flag — closing
      // them is the second file and the second variable, `WALGIT_PRIVATE_REPOS`
      // in `workerSecrets` above. The mechanism, the
      // format and the argument are docs/adr/0012; what belongs here is why
      // agentgit runs it and what that costs whoever operates it.
      //
      // HERE rather than in the package, which is the whole reason this line
      // exists. It ships OFF in packages/walgit and stays off for every other
      // deployment; whether a name may refuse a stranger is an opinion about
      // what this host is for, and CONTEXT-MAP puts opinions in the instance —
      // walgit may gain capabilities, never opinions. Same argument as
      // `WALGIT_APPEND_ONLY` above it, and it answers what append-only leaves
      // open: nothing here can be deleted, which is what makes the URL safe to
      // hand a stranger and equally what makes a stranger's write into your
      // name permanent.
      //
      // Set BESIDE `WALGIT_PUSH_CERT_SEED` above and never without it. The
      // seed is what makes `git-receive-pack` advertise certificates at all,
      // so with no seed every push to a claimed name is refused as unsigned
      // and no client can sign its way out. It is its own flag rather than a
      // consequence of the seed because the seed went live on 2026-08-30, and
      // ownership implied by it would have arrived here as a side effect.
      //
      // ON BEFORE ANYONE WRITES A LIST, AND LEFT ON. The ref is authoritative
      // but the Index carries the copy `pre-receive` enforces from, and that
      // copy is maintained only while this is set (src/signers.ts). A list
      // pushed while it was off enforces nothing until it is pushed again, and
      // turning it back off silently un-enforces every claim on the host. This
      // is not a knob to toggle.
      //
      // A var rather than a secret, unlike the seed: a boolean nobody gains
      // anything by knowing. Like every var here it reaches the container only
      // because shared/container-env.ts names it.
      //
      // UN-CLAIMING IS IDLE EXPIRY, and only on a deployment like this one.
      // `WALGIT_RETENTION_HOURS` below collects a repository 24 hours after
      // its last push, so a name frees itself and a claim is a lease. On a
      // walgit with no retention window a list is permanent, and for a company
      // running its own host that is the correct answer rather than a defect —
      // which is why the package does not couple the two. The coupling belongs
      // here, in the deployment that holds both.
      //
      // There is no recovery path for a lost key and none is coming. What
      // bounds it is a list naming TWO keys, revocation by a commit that
      // removes a line, and the 24-hour window above.
      //
      // The one way this reaches UNCLAIMED names: a push writing an empty or
      // unreadable list is now refused everywhere, because an empty list would
      // hand the name to the next stranger and an unreadable one would leave
      // an agent believing it holds a name it does not. Those are refusals
      // about writing a list, not about who may push.
      { name: 'WALGIT_SIGNER_LISTS', value: '1' },
      // Proposals (docs/adr/0018). The one push a CLAIMED name takes from
      // somebody not on its Signer List: a signed push to
      // `refs/walgit/proposals/<target>/<id>`, naming a commit its pusher wants
      // in `refs/heads/<target>`. Every other ref stays under the list above.
      //
      // Set BESIDE `WALGIT_SIGNER_LISTS` and never without it, and it needs the
      // `WALGIT_PUSH_CERT_SEED` in `workerSecrets` too — `capabilitiesFrom`
      // (`shared/capabilities.ts`) refuses to advertise on this flag alone. The
      // reason is the same one Private has: with no seed nothing can sign, so
      // no Proposal could be pushed; and on a name anyone may write to there is
      // no refusal to widen, because that namespace is already open. Both
      // prerequisites are set above, which is what makes this line meaningful
      // here and inert anywhere it were copied without them.
      //
      // `WALGIT_PUBLIC` is deliberately NOT a prerequisite, where Private needs
      // it: a Proposal proves its key with the certificate inside the pack, not
      // with the one `authorization` header a deployment token would occupy.
      //
      // The host still accepts nothing. Merging a Proposal is an ordinary push
      // by a Signer, judged by the same list — this flag only widens what
      // `pre-receive` takes, and `GET /<name>.git/proposals` reports what is
      // there with `merged` derived from ancestry rather than recorded.
      { name: 'WALGIT_PROPOSALS', value: '1' },
      // 99 MiB, and the number is measured rather than round. A chunked body
      // is uploaded IN FULL before the edge can answer, so a cap above the
      // chunked cutoff would be enforced only after ~37 s of upload, reported
      // as a dropped connection. walgit refuses in `pre-receive` instead,
      // before anything reaches the log.
      { name: 'WALGIT_MAX_PUSH_BYTES', value: String(99 * 1024 * 1024) },
      // 250 MiB total per repository — the size `git repack -adf` was measured
      // succeeding on in the Containers spike, which is the sizing case.
      { name: 'WALGIT_MAX_REPO_BYTES', value: String(250 * 1024 * 1024) },
      // ── per-source limits ────────────────────────────────────────────────
      //
      // What one client may spend in an hour (`src/rate-limit.ts`). The two
      // caps above bound how big a thing may be and say nothing about how
      // often one arrives: a hundred 1 MiB pushes are each individually fine,
      // and a hundred new names are each individually free. One container
      // serves every repository here (`max_instances: 1`), so a single visitor
      // filling the bucket is not merely storage — it is the queue everyone
      // else is behind, which is exactly the shape of a launch-day spike.
      //
      // The numbers are chosen to be invisible to the traffic this service is
      // FOR and to bite only on traffic nobody would defend. An agent working
      // in one repository for an hour makes tens of pushes, not three hundred;
      // an agent session creates one or two names, not twenty. Whoever passes
      // these is filling the host on purpose, and reads a `pre-receive` refusal
      // saying so rather than a queue nobody can explain.
      //
      // The window is the default hour, left unstated (`WALGIT_RATE_WINDOW_SECONDS`).
      // The source is the client IP, which is all the Worker can see; a NAT
      // therefore shares a bucket, which is the reason these are generous
      // rather than tight.
      //
      // MEASURED, on 2026-09-16, against this deployment:
      // `docs/research/agentgit-load-2026-09-16.md`. The intent above is
      // unchanged; what the run added is the other ceiling, which no amount of
      // reasoning about one agent's habits produces — ONE CONTAINER SERVES
      // EVERYONE (`max_instances: 1`), so what a single source may take is
      // properly a fraction of the whole host's hourly capacity, and a filled
      // queue is not that source's problem but everyone else's latency. The
      // host sustains 0.35 pushes/s (~1,260 an hour) and ~1.1 MiB/s (~3.9 GiB
      // an hour); each number below names its share of that.
      //
      // A new name costs exactly ONE push — 4.3–5.2 s uncontended, across the
      // 14 repositories the run seeded — so creation is not the expensive act
      // it looks like, and 20 names is ~1.6% of the hourly push capacity. The
      // run confirmed this number rather than moving it.
      { name: 'WALGIT_MAX_NEW_REPOS_PER_SOURCE', value: '20' },
      // ~10% of the host's measured 1,260 pushes an hour. It was 300 — 24% of
      // it — which is a quarter of the service in one visitor's hands on the
      // day the service gets its crowd. Still 4–12× what an agent session
      // spends: the run measured eight concurrent pushes at 20 s each with
      // nothing failing, which is the queue this bounds, not a refusal rate.
      { name: 'WALGIT_MAX_PUSHES_PER_SOURCE', value: '120' },
      // 256 MiB an hour: ~6% of the host's measured ~3.9 GiB. It was 2 GiB,
      // which is HALF the host's hourly bytes for one address — the one value
      // the measurement moved by an order of magnitude. Two full-size pushes
      // still fit, and it is ~25x the largest pack observed to complete
      // reliably (see the write-up's note on 10 MiB pushes failing).
      { name: 'WALGIT_MAX_PUSH_BYTES_PER_SOURCE', value: String(256 * 1024 * 1024) },
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
      // ── who runs it ──────────────────────────────────────────────────────
      //
      // The one thing on the launch page that is not a capability: a capability
      // is something the push path enforces, and this is who is answerable for
      // one. The page and `/llms.txt` render an operator block from the pair
      // (`shared/operator.ts`), and a deployment that sets neither carries no
      // block at all — which is the right default for a walgit somebody runs
      // inside their own company, and the wrong one for a host on an
      // aggregator's front page, where the first question in ten minutes is who
      // to send a takedown to.
      //
      // Vars rather than secrets, and they are the only two values here that
      // are MEANT to be read by a stranger. Edge-only: neither is in
      // `CONTAINER_ENV` (packages/walgit/shared/container-env.ts), because
      // nothing the container serves names an operator — so unlike every other
      // var here, editing one costs no container restart.
      // CONFIRM THE MAILBOX BEFORE THE POST. A contact line pointing at an
      // address nobody receives is worse than no contact line: it converts a
      // takedown into a silence somebody else has to escalate. Swap it for a
      // deliverable address (or a URL — the page links `https://…` too) if this
      // one is not routed.
      { name: 'WALGIT_OPERATOR', value: 'Zabaca' },
      { name: 'WALGIT_CONTACT', value: 'abuse@zabaca.com' },
      // ── browser analytics ────────────────────────────────────────────────
      //
      // PostHog on the landing page (shared/analytics.ts). The project key is
      // a public write-only token — it is in the page source of every site
      // that uses PostHog — so a var, not a secret. Edge-only, like the two
      // above. The edge telemetry (walgit_requests) keeps counting page views
      // with no identity; this answers where readers come from and whether
      // they come back, which that dataset cannot. Host left at the default,
      // PostHog Cloud US.
      { name: 'WALGIT_POSTHOG_KEY', value: 'phc_tvfFcfPyMXbCMCQEvFLp7sVPooGUL7ZBQeG9ktM4agZh' },
      // ── ref events ───────────────────────────────────────────────────────
      //
      // Where the container announces a push TO — this deployment's own public
      // origin. The announcement is an outbound HTTP request made from inside
      // the container by `post-receive`, so it needs an address the container
      // can dial, and the Worker in front of these routes is the only thing
      // that can reach the Durable Object holding the sockets.
      //
      // `agentgit.co` of the four routed hostnames, because that is the name
      // the service launches under; any would work (one worker answers all),
      // and this one is not a client-visible choice — no subscriber ever sees
      // this value, they connect to whichever host they already use.
      //
      // The credential half lives in `workerSecrets` above. Both are required:
      // `src/announce.ts` reads the pair and stays silent unless both are set,
      // so a half-configured deployment announces nothing rather than
      // announcing unauthenticated.
      { name: 'WALGIT_EVENTS_URL', value: 'https://agentgit.co' },
    ],
  },
})
