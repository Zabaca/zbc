# The SFU only, rules in the Room, outside calls in the router, Access on /start alone

Status: accepted. Section 3 (Access on /start alone) is superseded by [0009](0009-start-is-a-redirect-to-the-space-and-meet-has-no-door-for-people.md): /start is a redirect and meet has no Access application.

Three choices that shape every file in this package. Each could have gone the
other way, and each is cheap to undo now and expensive later.

## 1. Media goes through Cloudflare's SFU, never browser to browser

A call's media goes up once from each browser to Cloudflare's Realtime SFU, which
sends each person everyone else's. There is no mesh of direct connections and no
mode that switches between the two (a mesh, and a mesh-or-SFU switch, were both considered).

**Why.** A mesh makes every browser upload once per other person, which fails on a
phone past about 4. The SFU was chosen knowing it is more to build: two peer
connections per person, an ordered queue on each, and a list of who sends what.
In return each person uploads once whatever the call's size, and nobody's address
is shown to anyone else.

**Cost.** Media is encrypted between each browser and Cloudflare, not end to end.
Spend is Cloudflare's: the free 1,000 GB a month, then $0.05 per GB, which the
usage meter (CONTEXT.md, Meter) is built to stay under.

## 2. The rules live in the Room; everything external lives in the router

One Durable Object per call keeps who is in it and what each person sends, over
its own synchronous SQLite. `RoomCore` (`src/room.ts`) holds every rule (the seat
cap, generations, who may act, expiry, the usage estimate) and never calls the
network. The Worker's router (`src/app.ts`) does everything external: it verifies
Access, validates input, asks the Room to authorize, calls the SFU and TURN, then
tells the Room what succeeded. If the Room has moved on in between, the router
closes what it just created.

**Why.** A Durable Object handles one call at a time and none of the core
awaits, so "the 9th person is refused" and "a seat is taken or not" are true with
no locks. The same class runs over `bun:sqlite` in the tests, so the rules are
tested against real SQL, and the router is tested with a fake SFU that records
what it was asked.

**Cost.** The router must repair a race the Room cannot see: a publish that
lands after its person rejoined. Each `record*` method answers false when the
generation has moved on, and the router then closes the tracks.

A person who is dropped (30 seconds of missed check-ins, a leave, or a rejoin on
a new connection) has their tracks recorded in the Room as orphans (CONTEXT.md),
and the router closes them at the SFU. The check-in reply carries the orphans
due, so that is no extra request; join, leave and the lobby look fetch them
separately. The SFU's own clean-up of tracks with no packets is not enough: a tab
that stops checking in but keeps its connection open keeps sending packets, and
would go on receiving everyone's media, unseen and unmetered. A row stays until
the SFU has taken the close (or says the track is already gone), and comes round
again after a pause of 2 s growing to a minute, for 10 minutes, then is given up
on. There is no alarm, so a call nobody touches again is not cleaned up, which
matters only when nobody is left in it to receive anything.

Every request to the SFU times out after 10 seconds (a 502 to the browser, the
detail in the log), so a hung SFU cannot hold check-ins until people are reaped.

Storage is migrated forward, never rebuilt. `SCHEMA` in `src/room.ts` is the
tables as first written (plus the orphans table the first deploy added), frozen;
every later table is appended to `ADDED_TABLES` (each
`CREATE TABLE IF NOT EXISTS`, run on every boot; chat's, ADR 0002) and every later column to
`ADDITIONS`, added by `ALTER TABLE ADD COLUMN` (guarded by `PRAGMA table_info`) on the next boot of
any call that lacks it. The first deploy already had `members.ice` and
`ice_expires`, so its calls skip those two. `CREATE TABLE IF NOT EXISTS` alone would leave a
call that had already started without the new column.

A rejoin reuses the relay credentials the person still holds (30 minutes or more
left) rather than minting new ones, and while the usage meter has tripped a
rejoin without such credentials is refused like a new person.

## 3. Access covers `/start` alone, and the Worker verifies it too

Everything only an owner may do sits under `/start`: the start page, creating a
call (`/start/api/rooms`) and reading usage (`/start/api/usage`). The deploy
instance puts a Cloudflare Access application on `<meet-host>/start` for the
owner alone. The zbc cloudflare module needed no change: it already makes
applications on a host plus a path for its `bypassPaths`, and Access paths apply
to everything under them. Joining and every call operation stay open, because the
call name is the invitation.

The Worker is the inner door: every request under `/start/api` must carry an
assertion with a valid signature, this application's audience and an unexpired
time, for the owner's address alone. No audience configured refuses everyone.
`workers_dev` and preview URLs are off, so there is one hostname. The development
bypass (`ALLOW_UNAUTHENTICATED=1`) works on a localhost host alone.

> **Amended.** The check is no longer a file in this package: it is the company
> layer's `identify` (`packages/workspace`), which reads only the
> `Cf-Access-Jwt-Assertion` header. "The owner's address alone" is now "a person
> of this install who is an owner" (`isOwner`). The signature, audience, expiry
> and fail-closed rules above are unchanged.

**Why.** The Access edge is bypassable by a request that reaches the Worker some
other way (another hostname, an odd spelling of the path); the Worker's own check
is what holds then. And gating only one path is what lets a stranger join a link
an owner sent with no sign-in, which is the product.

**Cost.** This is the first application here that protects a path rather than a
whole host. The first apply is checked by hand (README, "After the first
deploy"). The verifier is copied into several of the deploy tool's apps; one
shared package is a separate change.
