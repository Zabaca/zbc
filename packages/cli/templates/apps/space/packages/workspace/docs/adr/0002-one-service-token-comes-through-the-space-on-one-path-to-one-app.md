# One service token comes through the space, on one path, to one app, and is never treated as a person

Status: accepted. It amends one rule of [ADR 0001](0001-the-apps-verify-the-assertion-the-space-forwards.md) and keeps every other.

## What changes

ADR 0001 said: "No service token comes through the space. Claude's script reaches the inbox on the inbox's own address with its own token; it never goes through the space, so `identifyForSpace` does not allow tokens." That held while the inbox had an address of its own. The inbox no longer has one (the owner works in the space on every device), and Claude's script is one of the jobs the old address still did. So the rule becomes:

> **One token, one path, one app.** Claude's service token, on the path `<space host>/agent/inbox`, handed to the inbox. Never treated as a person, accepted nowhere else on the space, and never handed to meet, forms or the knowledge app.

Nothing is minted: it is the token Claude already holds, and the script's two secret keys do not change.

## How it is held to that

Each line is pinned by a test; the files are in the order a request meets them.

- **An Access application of its own on that path** (the install's `space-agent-access` instance file): a Service Auth policy for that one token by name, no people policy, session length `0s` (a machine keeps no cookie). It has its own audience, so an assertion minted for the space, for Forms or for the inbox's own address is not one for this path, and one for this path opens nothing else. The declaration says where it is (`agent.path`, `install.agentDoor()`); it is refused for any app but the inbox, without the `claudeScript` switch, and on the space's own API or a tab. (Amended by ADR 0007: the token's NAME is not the declaration's but the install file's, `access.agent.token`; the declaration keeps only the path, and the install file's check that each machine door has a token of its own replaces the declaration's.)
- **The space answers the path before its person check** (the space package's `src/agent.ts`). It verifies the assertion with the company layer's `identify` against the agent audience (`CF_ACCESS_AUD_AGENT`) and accepts a **service token only**: a person's assertion, even a genuine one for that audience, and one naming both, are refused. The person check on every other path is unchanged and still refuses every token (`identify` without `allowServiceTokens`). A path that is not exactly under the door is not on it: the door matches without regard to case, as Access matches a path, and nothing is read from a path that climbs out of it (the URL parser resolves dot segments first).
- **What is handed on is the request and no more.** At the inbox's own `/api/...` path (nothing else under the door is forwarded: no page, no file, a 404 otherwise), without the `Cookie` and without the token's own two headers (`CF-Access-Client-Id` and `-Secret`: the secret half goes no further than the space), with the assertion as it came. The space's write rule (only its listed write paths) does not apply to this path, because the inbox's own rules do: its cross-site check still refuses a write that names another site.
- **The inbox verifies again, itself** (`ClaudeInbox` in the inbox package's `src/worker.ts`, `agentDoor` in `src/app.ts`). It checks the assertion against `AGENT_ACCESS_AUD` (not `CF_ACCESS_AUD`, not `SPACE_ACCESS_AUD`), admits Claude's token by its id (`INBOX_ACCESS_CLIENT_ID`) and nobody else, serves `/api/` and nothing else, and has no push hostname and no dev identity. The space is a hand-over: it holds no rule of the inbox's and no secret.
- **The entrypoint is `fetch` and nothing else, and is not in the space's contract.** `SpaceInbox` stays exactly `INBOX_FOR_SPACE_METHODS`; `ClaudeInbox` is a second class, named in `CLAUDE_ENTRYPOINT`, reached by a second binding (`INBOX_AGENT`) that has no route, no hostname and no Access application. The inbox package's `test/worker-exports.test.ts` pins both classes' methods, because the runtime exposes every method of an entrypoint.

## What it costs, stated

- **The space, which let in people only, lets in exactly one machine on one path.** That is the exception this ADR records. A reader of the company layer who finds "no service token comes through the space" in an older note should read this instead.
- **When the space is down, Claude's reading and drafting stop with it**, and so does the owner's reading of those drafts there. The inbox's old address is gone, so there is no other way for the script: a path that stops answering is fixed, not bypassed.
- **A compromised space could hand on an assertion Cloudflare signed for Claude's token while it lasts**, as it can already hand on the owner's. It cannot mint one: the signature is Cloudflare's, and the inbox checks it, the audience and the token's id itself. Claude can do less than the owner (it cannot change the owner's switches, and it sends only on the owner's recorded instruction with the owner's switch on), so this adds no power the space does not already hold.
- **A client's install** gets none of it unless it declares the door: the declaration refuses a token without an `agent` door of its own, and `agent.path` needs one. (Amended by [ADR 0004](0004-every-feature-is-a-switch-any-install-may-turn-on-and-the-tabs-are-the-installs.md): the switch is no company's alone; the old "any company but the operator's own" refusal and `company.own` are gone.)

## What it does not change

Everything else in ADR 0001: the assertion goes to the apps as the first argument of every method, each verifies it against the space's audience and applies its own visibility rules, refusals and failures stay two different things, writes go out at most once. None of that is about this path, which is HTTP and not a method call, and the answer to a request on it is the inbox's own, as it was at the old address.

## Amendment: each machine its own token on its own path

The rule above says "one token, one path, one app". The Telegram bridge is a second machine that has to push into the inbox, so the rule becomes:

> **Each machine its own token, on its own path, to one narrow router.** Claude: its token, on `/agent/inbox`, to the inbox's Claude router. The Telegram bridge: its own token, on `/agent/telegram`, to the inbox's bridge router. A token is never treated as a person, is accepted nowhere else on the space, is refused on the other machine's path, and is never handed to meet, forms or the knowledge app.

What carries it, in the order a request meets it (every line is pinned by a test):

- **The declaration** (`telegram` beside `agent`, `Install.telegramDoor()`, `telegramRoute()`): present exactly where the `telegram` switch is on, which any install may turn on with a bridge of its own (amended by ADR 0004: it was the operator's alone). It refuses the bridge's path if it is a path of the space's own, Claude's path, inside it or around it, and refuses Claude's token name for the bridge. (The workspace package's `test/agent.test.ts`.)
- **An Access application of its own** (the install's `space-telegram-access` instance file): a Service Auth policy for that one token by name, no people policy, session length `0s`. It has its own audience, so an assertion minted for Claude's path or for the space is not one for this path, and one for this path opens nothing else. Unlike Claude's, the token does not exist before the first apply: the module creates it then and shows its secret exactly once, which goes straight into the environment's secrets store (see `../../../inbox/docs/runbooks/inbox-telegram-bridge.md`). (The infra package's `test/space-telegram-access.test.ts`.)
- **The space answers the path before its person check** (the space package's `src/telegram.ts`, the sibling of `agent.ts`): it verifies the assertion against `CF_ACCESS_AUD_TELEGRAM`, accepts a service token only, and hands the request on, at the inbox's own `/api/` path and without the cookie, the token's two headers or the assertion, to the inbox's bridge router in-process, with the token it verified. A request that is not under the door, or not an `/api/` path of it, goes nowhere. (The space package's `test/telegram.test.ts`.)
- **The inbox's bridge router admits the bridge's token by its id and serves five calls** (`outcomes` being the fifth) (the inbox package's `src/telegram/app.ts`): Claude's token is refused there. Claude's router (`createApp`) admits only Claude's, so the bridge's token is refused on Claude's path. (The inbox package's `test/telegram-door.test.ts` and `space-part.test.ts`.)

What it costs, stated: the space now lets in two machines, and when the space is down the bridge's pushes wait (they are kept in the bridge's memory and Telegram's position does not move, so nothing is lost, and the bridge's own retry is the recovery). A compromised bridge token can push false messages into the owner's Inbox as Telegram's; it cannot read mail, act as Claude, send, or reach any other app. A client's install gets none of it unless it turns the switch on.

## Amendment: a third machine, the Clients door

The rule becomes three machines, each on its own path with its own token, now with one that WRITES instead of asking the inbox:

> **Claude** (`/agent/inbox`, to the inbox's Claude router), **the Telegram bridge** (`/agent/telegram`, to the inbox's bridge router) and **a source of Clients** (`/agent/clients`, to the Clients part's source face), each with a token of its own. A token is never treated as a person, is accepted nowhere else on the space, is refused on the other machines' paths, and is never handed to meet, forms, the knowledge app or the calendar.

Why: the space has no dependency on a client source, so a company's own site pushes its Clients in (the space's ADR 0021). What carries it, as for the others: `clientsDoor` in the declaration (path and `source`: what the Clients that arrive are called), present exactly where the `clientDirectory` switch is on, refused for a path of the space's own or one inside, around or equal to either other door's, and for either other door's token name (the workspace package's `test/declaration.test.ts` and `agent.test.ts`); `Install.clientsDoor()` and `clientsRoute()`; an Access application of its own that mints the token (the install's `space-clients-access` instance file, the infra package's `test/space-clients-access.test.ts`); and the space answering the path before its person check (the space package's `src/clients-door.ts`, `test/clients-door.test.ts`), which also checks the assertion's token against the id the Worker was deployed with (`CLIENTS_ACCESS_CLIENT_ID`).

What it costs, stated: the space lets in three machines, and the third can WRITE. A compromised Clients token can write the Clients of the one declared source (names the owner has not edited, its own fields, gone marks, new Clients with numbers it asks for); it cannot read mail, act as Claude, archive or delete a Client, change a name the owner edited, or reach any other part. A client's install gets none of it unless it turns the switch on.
