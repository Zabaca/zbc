import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkPublic, checkPublicFiles, domainAllowed, isInventedHexId, isReservedPhone } from '../src/public-check'

/**
 * THE PUBLIC CHECK'S OWN TESTS: made-up lines that must be found and made-up lines that must not, for each kind, so the check cannot pass by matching nothing. The offending lines here are what the check exists to
 * catch, so this file is the one the check does not read (`EXEMPT_FILES`).
 */

/** The author's name, assembled so that this file holds no private term even though it names the author's repositories on purpose. */
const AUTHOR = ['Zab', 'aca'].join('')

/** The kinds a line is reported under, for one line of text in one file. */
const kinds = (text: string, path = 'packages/example/src/a.ts') => checkPublic({ path, text }).map((hit) => hit.kind)
const found = (text: string, path?: string) => expect(kinds(text, path).length).toBeGreaterThan(0)
const clean = (text: string, path?: string) => expect(checkPublic({ path: path ?? 'packages/example/src/a.ts', text })).toEqual([])

describe('addresses and hosts', () => {
  test('an address at a domain that is not reserved or a third party’s is found', () => {
    for (const line of ['contact someone@realcorp.com', "to: 'ana@mail.realcorp.io'", 'Priya <priya@realcorp.dev>', 'bounce+x@realcorp.co']) {
      expect(kinds(line)).toEqual(['address'])
    }
  })

  test('a name at a mail provider is a realistic person’s address and is found, though the provider alone is not', () => {
    expect(kinds('sign in as jane.doe@gmail.com')).toEqual(['address'])
    expect(kinds("signIn: 'dana1985@outlook.com'")).toEqual(['address'])
    clean("const GMAIL = 'gmail.com'")
    clean("if (domain === 'gmail.com') return 'google'")
    clean("address.endsWith('@gmail.com')")
    clean('`${local}@gmail.com`')
  })

  test('a name at a mail provider that nobody can hold is not: three characters or fewer anywhere, and at Gmail a name with an underscore or a hyphen', () => {
    for (const line of ["['a@yahoo.com', true]", "normalize('a.b@gmail.com')", "'a+x@gmail.com'", "from: 'Tessa_Marlow@Gmail.com'", "'no-reply@googlemail.com'", "'dana_r+acme@gmail.com'"]) clean(line)
    expect(kinds("signIn: 'dana_r@outlook.com'")).toEqual(['address'])
    expect(kinds("'dana@gmail.com'")).toEqual(['address'])
    expect(kinds("'tessamarlow+x@gmail.com'")).toEqual(['address'])
    expect(kinds("'a@gmail.acme.com'")).toEqual(['address'])
  })

  test('an invented company’s name with more after a hyphen, an all-zero client id, and a provider’s domain before a reserved ending are invented', () => {
    clean("'inbox-push@northfield-mail-000000.iam.gserviceaccount.com'")
    clean("'000000000000-northfieldexample.apps.googleusercontent.com'")
    clean("['news@gmail.com.example', false]")
    clean("link('https://google.com.example/calendar/event?eid=abc')")
    clean("htmlLink: 'https://www.google.com/calendar/event?eid=abc'")
    expect(kinds("'https://www.google.com/maps/place/acme'")).toEqual(['address'])
    expect(kinds("'inbox-push@acme-mail-000000.iam.gserviceaccount.com'")).toEqual(['address'])
    expect(kinds("['news@acmeplumbing.com.example', false]")).toEqual(['address'])
  })

  test('a host that is not reserved or a third party’s is found, in a URL, a quoted name or prose in backticks', () => {
    for (const line of ['fetch("https://app.realcorp.com/login")', "const HOST = 'space.realcorp.io'", 'Open `realcorp.dev` and sign in', 'curl -sI https://realcorp.net/', 'see realcorp.org/guides']) {
      expect(kinds(line)).toEqual(['address'])
    }
  })

  test('a host under any ending is found after ://, and under a country or generic ending in a string, a comment, prose or a data file', () => {
    for (const line of ['https://acmeplumbing.ca/x', 'https://acmeplumbing.co.uk/x', 'http://acmeplumbing.photography/', 'wss://live.acmeplumbing.sh/socket', 'const H = "acmeplumbing.ca"', "const H = 'acmeplumbing.co.uk'", '// the portal is portal.acmeplumbing.io', ' * the portal is portal.acmeplumbing.io']) {
      expect(kinds(line)).toEqual(['address'])
    }
    // Written bare after a key that names a host, in code or in data.
    expect(kinds('host: portal.acmeplumbing.io')).toEqual(['address'])
    expect(kinds('const config = { domain: acmeplumbing.co }')).toEqual(['address'])
    for (const [path, line] of [
      ['README.md', 'visit acmeplumbing.co today'],
      ['README.md', 'The site (realcorp.dev) is down.'],
      ['README.md', 'Open realcorp.app and sign in'],
      ['docs/guide.md', '1. Go to acmeplumbing.ca/start.'],
      ['a.yaml', 'host: portal.acmeplumbing.io'],
      ['a.toml', 'origin = acmeplumbing.dev'],
      ['a.json', '{ "site": "acmeplumbing.co.uk" }'],
      ['a.sh', 'curl acmeplumbing.io/health'],
      ['a.ts', "const note = 'visit acmeplumbing.co today'"],
    ] as const) {
      expect([path, kinds(line, path)]).toEqual([path, ['address']])
    }
  })

  test('an ending that is also an ordinary word needs the name to be a whole quoted string, or a URL', () => {
    for (const line of ['const H = "acmeplumbing.it"', "const U = 'acmeplumbing.id/path'", 'https://acmeplumbing.in/x']) expect(kinds(line)).toEqual(['address'])
    for (const line of ['the acmeplumbing.it site', "'c.id IN (SELECT 1)'", "scopeWhere(scope, 'mb.id', 2)", "const m = 'account.id: the id of the account'", '`row.id` is the key']) clean(line)
    clean('The key is row.id and the user is req.me', 'README.md')
  })

  test('a file name, a property chain or a call is not a host, in code, a string, prose or Markdown code', () => {
    for (const line of [
      'import { x } from "./index.ts"',
      "readFile('README.md')",
      'const a = foo.app.bar',
      'return opts.ca ? 1 : 2',
      'if (navigator.onLine) go()',
      'await h.online.size',
      'const x = window.location.dev',
      'this.ports.ai.run()',
      'list.in(values)',
      'res.json.me()',
      "const f = 'server.ts'",
      "const f = 'archive.tar.gz'",
      '"index.html"',
    ]) {
      clean(line)
    }
    for (const line of ['Edit `index.ts` and `foo.app.bar`.', 'The `row.id` column and `this.app`.', 'See README.md and package.json.', '```ts\nconst v = opts.ca ? a.app : b.dev\n```']) clean(line, 'docs/guide.md')
    clean('opts.ca = 1\nindex.ts has app.dev inside', 'a.ts')
  })

  test('text between JSX tags is prose: a host in it is found, a property in an expression is not', () => {
    for (const line of ['<p>Visit portal.acmeplumbing.io today</p>', '<p>Our site is acmeplumbing.ca</p>', "<p>We're at {'portal.acmeplumbing.io'}</p>", 'return <b>acmeplumbing.dev</b>', '<a href="https://acmeplumbing.ca/x">Open</a>']) {
      expect([line, kinds(line, 'a.tsx')]).toEqual([line, ['address']])
    }
    expect(checkPublic({ path: 'a.tsx', text: 'const a = (\n  <div>\n    <b>one</b>\n    two and acmeplumbing.io\n  </div>\n)' }).map((hit) => hit.line)).toEqual([4])
    for (const line of ['<p>{x.app}</p>', '<a href={link.dev}>Open</a>', '<p>Visit {this.app} now</p>', 'const a = b < c ? d.app : e.dev', 'const s = useState<string>(props.app)', '<p className="a.b">hi</p>']) {
      expect([line, kinds(line, 'a.tsx')]).toEqual([line, []])
    }
    clean('<p>Visit portal.acmeplumbing.io today</p>', 'a.ts') // JSX is read in tsx and jsx files only
    // A generic parameter list is not a tag, so what follows it is code.
    for (const text of [
      'const f = <T extends Element = HTMLElement>(testid: string) => document.querySelector<T>(testid)\nconst b = c.app',
      'const g = <T,>(x: T) => x\nconst b = c.app',
      'const h = <T = string>(x: T) => x\nconst b = c.app',
      'export const pick = <Key extends string>(k: Key) => k\nconst b = c.app',
    ]) {
      expect([text, checkPublic({ path: 'a.tsx', text })]).toEqual([text, []])
    }
    expect(checkPublic({ path: 'a.tsx', text: 'const f = <T,>(x: T) => x\nconst h = "portal.acmeplumbing.io"' }).map((hit) => hit.line)).toEqual([2])
  })

  test('a fenced block in Markdown is read by its language, so a host in a block of JSON, shell or plain text, or in a comment, is found', () => {
    const fenced = (language: string, body: string) => '```' + language + '\n' + body + '\n```'
    for (const [language, body] of [
      ['json', '{ "host": "portal.acmeplumbing.io" }'],
      ['sh', 'dig +short MX acmeplumbing.io'],
      ['bash', 'curl -sI acmeplumbing.co'],
      ['yaml', 'host: portal.acmeplumbing.io'],
      ['', 'open portal.acmeplumbing.io'],
      ['text', 'acmeplumbing.ca'],
      ['ts', '// portal.acmeplumbing.io'],
      ['ts', "const h = 'portal.acmeplumbing.io'"],
      ['sql', "SELECT 'acmeplumbing.dev'"],
    ] as const) {
      expect([language, body, kinds(fenced(language, body), 'README.md')]).toEqual([language, body, ['address']])
    }
    for (const body of ['const v = opts.ca ? a.app : b.dev', 'await res.json.me()', 'foo.app.bar()']) expect(kinds(fenced('ts', body), 'README.md')).toEqual([])
  })

  test('a longer fence holds a shorter one, and what follows it is prose again', () => {
    const text = '````md\n```ts\nconst a = b.app\n```\n````\n\nvisit acmeplumbing.co today'
    expect(checkPublic({ path: 'README.md', text }).map((hit) => hit.line)).toEqual([7])
    expect(checkPublic({ path: 'README.md', text: '~~~\n```\nx\n~~~\nvisit acmeplumbing.co today' }).map((hit) => hit.line)).toEqual([5])
  })

  test('a regular expression with a quote or a backtick, or an apostrophe in JSX, does not hide the host after it', () => {
    expect(kinds("const a = /'/.test(s) ? 'portal.acmeplumbing.io' : ''")).toEqual(['address'])
    expect(kinds('s.replace(/`/g, "x"); const h = "portal.acmeplumbing.io"')).toEqual(['address'])
    expect(checkPublic({ path: 'a.ts', text: "const a = /'/.test(s)\nconst h = 'portal.acmeplumbing.io'\nconst b = c.app" }).map((hit) => hit.line)).toEqual([2])
    expect(checkPublic({ path: 'a.ts', text: 'const a = s.replace(/`/g, "")\n// portal.acmeplumbing.io\nconst b = c.app' }).map((hit) => hit.line)).toEqual([2])
    expect(checkPublic({ path: 'a.tsx', text: "const a = <p>We're at {'portal.acmeplumbing.io'}</p>\nconst b = c.app" }).map((hit) => hit.line)).toEqual([1])
  })

  test('the endings of the businesses the space serves are hosts in prose and strings; the ones that are property names on the real tree are not', () => {
    for (const line of ['visit acmeplumbing.construction today', "const h = 'acme.plumbing'", '// see portal.acmefirm.law', 'Our clinic is acmeclinic.dental', 'the shop: acmeshop.shop', 'acme.services is down']) {
      expect([line, kinds(line, 'README.md')]).toEqual([line, ['address']])
    }
    for (const line of ['Bootstrap.site holds it', 'a message stored by push.live', 'Me.company is the name', 'userinfo.email is the scope', 'calendar.events lists them', 'InboxAttachment.video']) {
      expect([line, kinds(line, 'README.md')]).toEqual([line, []])
    }
  })

  test('the third parties the code recognises as machine mail or standards are safe, and a third party’s own pages are not', () => {
    for (const line of [
      'CAF3b9xR1kq2c8Zw4pVhE5nT7yUo6Lr0aJdG9sXm1BvNc2Hq4Wg@mail.gmail.com',
      "'unsubscribe+9f8e7d6c5b4a3210@bounces.customer.io'",
      'unsub.beehiiv.com and bounces.sendgrid.net',
      '<hash>@reply.craigslist.org',
      'https://zoom.us/j/1234567890',
      'https://meet.google.com/abc-defg-hij',
      'https://accounts.google.com/o/oauth2/v2/auth',
      'https://mail.google.com/mail/u/0/#inbox',
      'https://developers.google.com/gmail/api',
      'abc@group.calendar.google.com',
      "const GOOGLE = 'google.com'",
      'https://web.telegram.org/k/',
      'https://en.wikipedia.org/wiki/Foo',
      'brightwater.example.role holds personas.info@brightwater.example.role',
    ]) {
      expect([line, kinds(line)]).toEqual([line, []])
    }
    for (const line of [
      'https://docs.google.com/document/d/abc/edit',
      'https://sites.google.com/view/acmeplumbing',
      'https://lh3.googleusercontent.com/a/photo=s96',
      'https://www.google.com/maps/place/acme',
      'Received: from mail-wm1-f43.google.com (mail-wm1-f43.google.com [209.85.128.43])',
      'https://drive.google.com/file/d/abc',
      "const photo = 'https://lh3.googleusercontent.com/a/x'",
      'someone@gmail.com',
      'abc@acme.customer.example.io',
    ]) {
      expect([line, kinds(line)]).toEqual([line, ['address']])
    }
  })

  test('a service that gives each customer a name of its own is allowed only bare or at the hosts the code names', () => {
    for (const line of ["'https://acmeplumbing.zoom.us/j/1'", "'acme.beehiiv.com'", "'acme.customer.io'", "'acme.sendgrid.net'", "'sfbay.craigslist.org'", 'https://sfbay.craigslist.org/x', "'acmeplumbing.group.calendar.google.com'", "'acme.mail.gmail.com'", 'https://acme.web.telegram.org/k', 'https://es.wikipedia.org/wiki/X']) {
      expect([line, kinds(line)]).toEqual([line, ['address']])
    }
    for (const line of ["'https://zoom.us/j/1'", "'unsub.beehiiv.com'", "'bounces.customer.io'", "'unsubscribe2.customer.io'", "'mail.sendgrid.net'", "'reply.craigslist.org'", 'abc@group.calendar.google.com', "'mail.gmail.com'", 'https://northfield.zoom.us/j/1']) {
      expect([line, kinds(line)]).toEqual([line, []])
    }
  })

  test('a host written in the name of an address at an allowed domain is read: after =, before _, or as a dotted word', () => {
    for (const line of [
      "'bounces+1-ab-dana=realcorp.com@sendgrid.net'",
      "'acmeplumbing.com_3s7abc@group.calendar.google.com'",
      "'dana.acmeplumbing.ca@bounces.customer.io'",
      "'x=acmeplumbing.io@mail.sendgrid.net'",
      '<a=realcorp.org@mail.gmail.com>',
    ]) {
      expect([line, kinds(line)]).toEqual([line, ['address']])
    }
    for (const line of ["'bounces+1-ab-dana=example.com@sendgrid.net'", "'example.com_3s7abc@group.calendar.google.com'", "'unsubscribe+9f8e7d6c5b4a3210@bounces.customer.io'", "'71.q4x8w2n6b0c5t9hd@unsubscribe2.customer.io'", "'CAF3b9xR1kq2c8Zw4pVhE5nT7yUo6Lr0aJdG9sXm1BvNc2Hq4Wg@mail.gmail.com'", "'0f1e2d3c-4b5a-4697-8a8b-9c0d1e2f3a4b+5c6d7e8f@unsub.beehiiv.com'", "'dana.r@example.com'"]) {
      expect([line, kinds(line)]).toEqual([line, []])
    }
  })

  test('a camel-case property path in a string of code is not a host; a brand-cased domain is one in prose, comments, Markdown, JSX text and strings alike', () => {
    for (const [path, line] of [
      ['a.ts', "expect(bad({ runBy: { site: 'x' } })).toContain('formsService.runBy.site')"],
      ['a.ts', "const field = 'formsService.runBy.company'"],
      ['a.ts', 'const field = "settings.mailBox.events"'],
      ['README.md', 'the field `InboxAttachment.video` is a property'],
      ['a.ts', "headers: { origin: o.company }"],
      ['a.ts', 'url: o.live'],
    ] as const) {
      expect([path, line, kinds(line, path)]).toEqual([path, line, []])
    }
    for (const [path, line] of [
      ['README.md', 'Visit AcmePlumbing.io for quotes.'],
      ['README.md', 'Visit BrightSmile.dental today.'],
      ['a.tsx', '<p>Visit AcmePlumbing.ca</p>'],
      ['a.ts', '// the portal is Portal.AcmePlumbing.io'],
      ['a.ts', "const H = 'AcmePlumbing.co'"],
      ['README.md', 'Open `AcmePlumbing.io` and sign in'],
      ['a.yaml', 'host: AcmePlumbing.dev'],
    ] as const) {
      expect([path, line, kinds(line, path)]).toEqual([path, line, ['address']])
    }
  })

  test('the name just before the ending, not the first label, must be a name: a subdomain does not make a property path a host, and a short first label does not hide a host', () => {
    for (const [path, line] of [
      ['a.ts', 'host: my.acme.site'],
      ['a.ts', "host: 'go.acmeplumbing.company'"],
      ['a.ts', "const H = 'my.acme.company'"],
      ['README.md', 'Their site is my.acme.live.'],
      ['README.md', 'Their portal is at go.acmeplumbing.email'],
      ['a.ts', "const H = 'x.acmeplumbing.site'"],
    ] as const) {
      expect([path, line, kinds(line, path)]).toEqual([path, line, ['address']])
    }
    for (const [path, line] of [
      ['a.ts', "const H = 'a.company'"],
      ['a.ts', 'host: o.site'],
      ['README.md', 'Their site is o.live.'],
      ['README.md', 'the company is Me.company'],
    ] as const) {
      expect([path, line, kinds(line, path)]).toEqual([path, line, []])
    }
  })

  test('a dotted personal name before a reserved domain is a person, not a host; a host that ends in a generic ending or is marked as one still is', () => {
    for (const line of ["'dreyes.dental@mail.example'", "'dana.acmeplumbing.ca@northfield.example'", "'dana.smith@example.com'", "'first.last@app.northfield.example'", "'ana.law@tessa.example'"]) {
      expect([line, kinds(line)]).toEqual([line, []])
    }
    for (const line of ["'bank.com@evil.test'", "'https://bank.com@evil.test/login'", "'bounces+1-ab-dana=realcorp.com@example.com'", "'acmeplumbing.com_3s7abc@northfield.example'", "'x=acmeplumbing.dental@mail.example'"]) {
      expect([line, kinds(line)]).toEqual([line, ['address']])
    }
    // At an allowed third party's domain a dotted word in the name is still read.
    expect(kinds("'dana.acmeplumbing.ca@bounces.customer.io'")).toEqual(['address'])
  })

  test('a real host with a reserved ending after it is still a real host', () => {
    for (const line of ["'priya@realcorp.com.example.org'", "'jane@acmeplumbing.com.invalid'", "'acmeplumbing.ca.example.net'", "'https://acmeplumbing.com.example.com/x'", "'acmeplumbing.io.test'", "'portal.acmeplumbing.co.localhost'"]) {
      expect([line, kinds(line)]).toEqual([line, ['address']])
    }
    for (const line of ["'priya@northfield.example'", "'tessa@app.northfield.example'", "'ana@mail.example.com'", "'a@staging.dev.example.com'", "'http://api.localhost:8787'", "'x.northfield.example.org'"]) {
      expect([line, kinds(line)]).toEqual([line, []])
    }
  })

  test('the endings that are property names on the real tree are hosts only as a whole quoted name, after a key that names a host, or after ://', () => {
    for (const line of ['const h = "acmeplumbing.site"', "const u = 'acmeplumbing.live/x'", 'url: acmeplumbing.live', 'domain = acmeplumbing.company', 'host: portal.acmeplumbing.email', 'https://acmeplumbing.events/x', 'the page is at "acmeplumbing.directory"']) {
      expect([line, kinds(line)]).toEqual([line, ['address']])
    }
    for (const line of ['Bootstrap.site holds it', 'a message stored by push.live', 'Me.company is the name', 'userinfo.email is the scope', 'calendar.events lists them', 'const x = state.company', "`Me.company` is it"]) {
      expect([line, kinds(line, 'README.md')]).toEqual([line, []])
    }
  })

  test('a team, account or project name under a service that names its customers is checked label by label', () => {
    expect(kinds('https://realco.team.cloudflareaccess.com/certs')).toEqual(['address'])
    expect(kinds('https://northfield.team.cloudflareaccess.com/certs')).toEqual(['address'])
    clean('https://team.cloudflareaccess.com/certs')
    clean('https://api.worker.northfield.workers.dev/x')
    expect(kinds('https://api.worker.acmeplumbing.workers.dev/x')).toEqual(['address'])
    clean('https://northfield.github.io/docs')
    clean('https://notofonts.github.io/noto-fonts')
    expect(kinds('https://acmeplumbing.github.io/docs')).toEqual(['address'])
    expect(kinds("'acme.workers.dev'")).toEqual(['address'])
    expect(kinds('https://realco.team.github.io/docs')).toEqual(['address'])
  })

  test('a path on GitHub is the author’s own repository, an organisation the code names, or a finding', () => {
    const own = `github.com/${AUTHOR}`
    for (const line of [`see https://${own}/zbc`, `git clone https://${own}/zbc-core.git`, `[the copy](https://${own}/zbc-space/tree/main)`, 'https://github.com/notofonts/noto-fonts', 'github.com/NotoFonts/x']) clean(line)
    for (const line of [`https://${own}/zbc-anything`, `https://${own}/zbc-spacex`, `https://${own}/another-repo`, `https://${own}`, 'https://github.com/acmeplumbing/site', 'https://raw.githubusercontent.com/acmeplumbing/site/main/a.txt', 'git@github.com:acmeplumbing/site.git https://github.com/acmeplumbing/site']) {
      expect(kinds(line)).toEqual(['address'])
    }
    clean('https://github.com')
  })

  test('a domain written with an at sign and no name before it (a rule about a domain) is a host', () => {
    expect(kinds("if (address.endsWith('@acmeplumbing.com')) return")).toEqual(['address'])
    clean("if (address.endsWith('@gmail.com')) return")
    clean("if (address.endsWith('@example.com')) return")
  })

  test('an address written URL-encoded is still an address', () => {
    expect(kinds("goto('/people/ana%40realcorp.com')")).toEqual(['address'])
    clean("goto('/people/ana%40example.test')")
  })

  test('reserved names are safe: the example domains and the example, test, invalid and localhost top-level domains, with any subdomain', () => {
    for (const line of [
      'ana@example.com',
      'ana@example.org, bo@example.net',
      'https://space.example.com/inbox',
      'host: space.northfield.example',
      'tessa@northfield.example',
      "to: 'owen@brightwater.example'",
      'https://a.b.test/x',
      'nobody@mail.invalid',
      "origin: 'http://app.localhost:8787'",
    ]) {
      clean(line)
    }
  })

  test('the third parties the code talks to are safe, as hosts and in addresses', () => {
    for (const line of [
      'https://api.cloudflare.com/client/v4/accounts',
      'https://accounts.google.com/o/oauth2/v2/auth',
      "fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile')",
      "https://api.telnyx.com/v2/calls",
      'https://registry.npmjs.org/zod',
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '"$schema": "https://json-schema.org/draft-07/schema"',
      'From: Google <no-reply@accounts.google.com>',
      'publisher gmail-api-push@system.gserviceaccount.com',
      'mx: route1.mx.cloudflare.net',
    ]) {
      clean(line)
    }
  })

  test('a team, account or project name under a service that names its customers must be an invented one', () => {
    clean('https://northfield.cloudflareaccess.com/cdn-cgi/access/certs')
    clean('teamDomain: "https://cloudflareaccess.com"')
    clean('`https://${team}.cloudflareaccess.com`')
    clean("clientId: '123456789012-abcdefghij.apps.googleusercontent.com'")
    clean('push@proj.iam.gserviceaccount.com')
    expect(kinds('https://acmeplumbing.cloudflareaccess.com/certs')).toEqual(['address'])
    expect(kinds("clientId: '4829104731-q1w2e3r4t5.apps.googleusercontent.com'")).toEqual(['address'])
    expect(kinds('inbox-push@realproject-12345.iam.gserviceaccount.com')).toEqual(['address'])
    expect(kinds('https://acme-mail.workers.dev/')).toEqual(['address'])
  })

  test('code that only looks like a host is not one', () => {
    for (const line of [
      'logo@2x.png',
      'react@18.3.1',
      'bun@1.3.14 and zod@3.24.0',
      "import { x } from '@space/inbox'",
      'import type { Env } from "@cloudflare/workers-types"',
      'console.info("ready")',
      'this.app.get("/")',
      'const dev = import.meta.env.DEV',
      'await res.json.me()',
      'readFileSync("data.json")',
      'see README.md and package.json',
      'the object.property.value chain',
      'user.me.profile',
    ]) {
      clean(line)
    }
  })

  test('one line with several addresses is one hit, naming each', () => {
    const hits = checkPublic({ path: 'a.ts', text: 'cc: a@realcorp.com, b@realcorp.com and https://site.realcorp.io' })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.detail).toContain('a@realcorp.com')
    expect(hits[0]?.detail).toContain('b@realcorp.com')
    expect(hits[0]?.detail).toContain('site.realcorp.io')
  })

  test('domainAllowed on its own: reserved and listed domains, never a lookalike', () => {
    expect(domainAllowed('SPACE.Example.COM', { inAddress: false })).toBe(true)
    expect(domainAllowed('notexample.com', { inAddress: false })).toBe(false)
    expect(domainAllowed('evilcloudflare.com', { inAddress: false })).toBe(false)
    expect(domainAllowed('cloudflare.com.evil.example.dev', { inAddress: false })).toBe(false)
    expect(domainAllowed('gmail.com', { inAddress: true })).toBe(false)
    expect(domainAllowed('gmail.com', { inAddress: false })).toBe(true)
  })
})

describe('32-character hex ids', () => {
  const id = '3f9a1c7e5b2d4086a1b7c9d0e2f45a68'

  test('an account-shaped id is found, in code, config and prose, in either case', () => {
    expect(kinds(`export CLOUDFLARE_ACCOUNT_ID=${id}`)).toEqual(['hex-id'])
    expect(kinds(`{ "account_id": "${id.toUpperCase()}" }`, 'a.json')).toEqual(['hex-id'])
    expect(kinds(`the zone is \`${id}\`, in the account`, 'a.md')).toEqual(['hex-id'])
  })

  test('an obviously invented id is not: one repeated block, a listed sequence, or zeros with a short number at the end', () => {
    for (const hex of ['0'.repeat(32), 'a'.repeat(32), 'ab'.repeat(16), 'deadbeef'.repeat(4), '0123456789abcdef'.repeat(2), '0123456789abcdef0123456789abcdef', `${'0'.repeat(28)}a001`, `${'0'.repeat(24)}0000b003`]) {
      expect(isInventedHexId(hex)).toBe(true)
      clean(`ID = '${hex}'`)
    }
    expect(isInventedHexId(id)).toBe(false)
    expect(isInventedHexId(`${'0'.repeat(23)}1${'a'.repeat(8)}`)).toBe(false)
  })

  test('a run of another length is not an id of this shape (a commit, a SHA-256, a UUID, a 31 or 33 character run)', () => {
    for (const other of ['b582e87c0b5e1f4e9a3d27c68a8d0f4e1c2b3a49', '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', '123e4567-e89b-12d3-a456-426614174000', id.slice(1), `${id}a`]) {
      clean(`value ${other}`)
    }
  })

  test('a hash is expected in a lockfile, a source map or a minified bundle, and nowhere else', () => {
    clean(`"integrity": "${id}"`, 'bun.lock')
    clean(`"integrity": "${id}"`, 'packages/example/package-lock.json')
    clean(`x = "${id}"`, 'assets/app.min.js')
    expect(kinds(`x = "${id}"`, 'assets/app.js')).toEqual(['hex-id'])
  })
})

describe('phone numbers', () => {
  test('a number outside the reserved 555-01xx range is found, however it is written', () => {
    for (const line of ['call (415) 555-2671', 'call 415-555-2671', 'call 415.555.2671', 'call +1 415 555 2671', "number: '+14155552671'", "to: '+44 20 7123 0958'", "to: '+52 55 2345 6789'", 'sms +1 (415) 555-2671']) {
      expect(kinds(line)).toEqual(['phone'])
    }
  })

  test('a number in the reserved range is not, with any area code', () => {
    for (const line of ['call (415) 555-0123', 'call 415-555-0100', 'call 626.555.0199', 'call +1 415 555 0142', "number: '+14155550100'", "number: '+16265550150'"]) {
      clean(line)
    }
    expect(isReservedPhone('+1 (212) 555-0100')).toBe(true)
    expect(isReservedPhone('(212) 555-0200')).toBe(false)
    expect(isReservedPhone('(212) 556-0100')).toBe(false)
  })

  test('a number no person can hold is not: an unassigned area code, an exchange no number has, a service or premium exchange, London’s drama range, and the listed invented ones', () => {
    for (const line of ["to: '+15551234567'", 'call 626 155 0123', 'call 626 411 1234', 'call (626) 976-0000', 'call +1 213 976 5555', "to: '+44 20 7946 0958'", "to: '+442079460958'", 'call 626 977 1234', "to: '+52 55 1234 5678'"]) {
      clean(line)
    }
    expect(isReservedPhone('626 977 1235')).toBe(false)
    expect(isReservedPhone('+44 20 7947 0958')).toBe(false)
  })

  test('spaces only, bare digits that a line calls a phone number, and tel: or sms: are found; reserved ones are not', () => {
    for (const line of ['call 415 555 2671', 'call +1 415 555 2671', 'phone: 4155552671', "dial('14155552671')", 'tel:4155552671', 'tel:+1-415-555-2671', '<a href="sms:+14155552671">', 'tel:+44 20 7123 0958']) {
      expect(kinds(line)).toEqual(['phone'])
    }
    for (const line of ['call 415 555 0123', 'phone: 4155550100', 'tel:+14155550123', 'tel:415-555-0100', 'order 4155552671', 'at 1700000000', 'phone id 1700000000', 'row 415 555 2671 of the table']) {
      if (line.startsWith('row')) expect(kinds(line)).toEqual(['phone']) // a table of figures looks like a number; only path data is let through
      else clean(line)
    }
    clean('<path d="M 415 555 2671 L 100 200"/>')
    clean('<path d="M 415 555 2671"/>', 'icon.svg')
  })

  test('digits that are not a phone number are not found: a timestamp, a date, a version, an id, a price, a table of figures', () => {
    for (const line of ['at 1700000000000', 'on 2026-11-10', 'v1.2.3', 'order 4829104731', 'total $1,234,567.89', 'path d="M 100 200 300 400 500 600"', 'range 100-200']) {
      clean(line)
    }
  })
})

describe('references to a private record', () => {
  test('a plan’s own step numbers, cited in brackets or as a moment, are found; a format’s name and a variable are not', () => {
    for (const line of ['// Calls in the space (P13): huddles', '// the guests’ bundles (U6)', '// where calls are joined since U6', '// (P10 review)', '// Signing, on a Client’s page (C5)', '// its own until R5; every refusal']) expect(kinds(line)).toEqual(['record'])
    for (const line of ["if (token() !== 'P6') throw new Error('not a P6 ppm')", 'const P1 = 1', '// a P-256 key', 'then `arm(U2)` for the bookmark']) clean(line)
  })

  test('the folder a project keeps its installs in is named by the files about a project’s layout, and by no other', () => {
    const line = 'the declaration is packages/infra/environments/production/workspace.json'
    for (const path of ['zbc-app.json', 'docs/install.md', 'starter/glue/install.ts.template', 'starter/environment/space.ts.template', 'kit/test/starter.test.ts']) clean(line, path)
    for (const path of ['packages/space/src/app.ts', 'kit/instances.ts', 'README.md', 'docs/other.md', 'packages/space/docs/install.md', 'kit/test/kit.test.ts']) expect(kinds(line, path), path).toEqual(['record'])
    // Those files are read for everything else as any file is.
    expect(kinds('see docs/problems/some-problem/problem.md', 'docs/install.md')).toEqual(['record'])
    expect(kinds('write to someone@realcorp.com', 'starter/environment/workspace.json')).toEqual(['address'])
  })

  test('a placeholder company’s sign-in team is not a real one', () => {
    clean('"access": { "teamDomain": "yourcompany.cloudflareaccess.com" }', 'starter/environment/workspace.json')
    expect(kinds('"access": { "teamDomain": "realcorp.cloudflareaccess.com" }', 'starter/environment/workspace.json')).toEqual(['address'])
  })

  test('a path into a private repository’s records is found', () => {
    for (const line of [
      'see docs/problems/some-problem/problem.md',
      '[x](../../docs/decisions/0012-x.md)',
      'in docs/clients/some-client.md',
      'rules are in docs/agents/issue-tracker.md',
      'deployed from packages/infra/environments/production/space.ts',
      "import { x } from '@ceo/infra'",
      'see docs/open-threads.md',
      'recorded in CHECKPOINT.md',
    ]) {
      expect(kinds(line)).toEqual(['record'])
    }
  })

  test('a home directory path is found unless its name is generic', () => {
    expect(kinds('cd /Users/jsmith/code')).toEqual(['record'])
    expect(kinds("const dir = '/home/jsmith/work'")).toEqual(['record'])
    expect(kinds('cd ~/Projects/example')).toEqual(['record'])
    for (const line of ['cd /Users/you/code', 'cd /home/runner/work', 'cat ~/.config/example/keys.txt', 'GET https://x.example/home/dashboard']) clean(line)
  })

  test('a choice cited by number, which names a record the reader cannot open, is found', () => {
    for (const line of [
      '// as option 2 of the plan chose',
      'Status: accepted with option 04 of a plan',
      '// the third slice (slice 3) adds the tab',
      'Slices 2 and 4 add no table',
      '- decision 12 of the earlier plan',
      '// option 01',
    ]) {
      expect(kinds(line)).toEqual(['record'])
    }
  })

  test('ordinary prose and public references are not: a screen’s own "Option 2 of 3", an ADR’s numbered decision, a numbered ADR', () => {
    for (const line of [
      'Option 2 of 3',
      'choose option 2 or option 3',
      'the second option of the dialog',
      'Supersedes, in part, decision 21 of ADR 0001',
      "Decision 15 of the inbox's ADR: Claude drafts and the owner sends.",
      'see ADR 0018 and the space’s ADR 0002',
      'const rest = list.slice(2)',
      'a decision of the owner',
      'docs/adr/0004-every-feature-is-a-switch.md',
      "import { x } from '@space/inbox'",
      "import type { T } from '@types/bun'",
    ]) {
      clean(line)
    }
  })

  test('a step of a plan cited by number is found, and a screen’s own steps are not', () => {
    for (const line of ['// step 2 of the plan adds it', 'done in step 3 of option 2', 'see step 4 in the spec', '- decision 3 of the plan']) expect(kinds(line)).toEqual(['record'])
    for (const line of ['Step 2 of 3', 'step 2: create the zone', 'In step 4, press Save.', 'Go to step 1 of the guide.']) clean(line)
  })

  test('a date used as provenance is found in a comment of any kind, in prose, and in a trailing comment', () => {
    for (const [path, line] of [
      ['a.ts', '// The first draft (2026-10-31), kept word for word'],
      ['a.ts', ' * Added 2026-11-04 after the outage'],
      ['a.ts', 'const x = 1 // 2026-11-04 asked for it'],
      ['a.ts', 'const x = 1 /* since 2026-11-04 */'],
      ['a.tsx', '<p>{/* the copy of 2026-11-04 */}</p>'],
      ['a.astro', '<!-- written 2026-11-04 -->'],
      ['a.sh', '# 2026-11-04 changed to a longer wait'],
      ['a.sh', 'sleep 5 # 2026-11-04 the host was slow'],
      ['a.toml', '# set on 2026-11-04'],
      ['a.yaml', 'name: a # moved 2026-11-04'],
      ['a.sql', '-- 2026-11-04 added the index'],
      ['a.sql', 'CREATE INDEX i ON t (a); -- added 2026-11-04'],
      ['a.css', '/* tuned 2026-11-04 */'],
      ['docs/adr/0001-x.md', 'Status: accepted 2026-11-02, with the owner'],
      ['README.md', 'The row was moved on 2026-11-02.'],
      ['README.md', 'The fix came after the outage of 2026-11-04.'],
      ['README.md', '| Held | 2026-11-04 | from the main checkout |'],
    ] as const) {
      expect([path, line, kinds(line, path)]).toEqual([path, line, ['record']])
    }
  })

  test('a date that is data is not provenance: in a string, a constant, a data file, a value, an example in backticks, a time, or inside a Markdown code block', () => {
    for (const [path, line] of [
      ['a.ts', "const day = '2026-11-10'"],
      ['a.ts', 'const day = "2026-11-10" // the day'],
      ['a.ts', 'expect(parse("2026-11-10")).toBe(1)'],
      ['a.ts', 'The row was moved on 2026-11-02.'],
      ['a.ts', '// 2026-03-08 02:30 does not exist in Los Angeles: the clocks skip it'],
      ['a.ts', 'const at = `2026-11-10T08:00:00Z`'],
      ['a.ts', '/** Whether `key` is a real day (`2026-02-30` is not). */'],
      ['a.json', '{ "date": "2026-11-10" }'],
      ['a.yaml', 'date: 2026-11-10'],
      ['a.toml', 'date = "2026-11-10"'],
      ['a.sql', "INSERT INTO t VALUES ('2026-11-10')"],
      ['README.md', 'The format is `2026-11-10`.'],
      ['README.md', 'Status: accepted, in the order of the list.'],
      ['a.ts', 'Status: accepted, in the order of the list.'],
    ] as const) {
      expect([path, line, kinds(line, path)]).toEqual([path, line, []])
    }
    expect(checkPublic({ path: 'README.md', text: 'Send:\n\n```json\n{ "date": "2026-11-10" }\n```\n\nDone.' })).toEqual([])
    expect(checkPublic({ path: 'README.md', text: 'Send:\n\n```json\n{ "date": "2026-11-10" }\n```\n\nIt broke on 2026-11-10.' }).map((hit) => hit.line)).toEqual([7])
  })

  test('a comment that spans lines, or a template string that does, keeps its kind from one line to the next', () => {
    expect(checkPublic({ path: 'a.ts', text: '/**\n * what it does\n * since 2026-11-04\n */\nconst x = 1' }).map((hit) => hit.line)).toEqual([3])
    expect(checkPublic({ path: 'a.ts', text: 'const q = `\nSELECT 1 -- 2026-11-04\n`\nconst y = 2' })).toEqual([])
    expect(checkPublic({ path: 'a.ts', text: 'const q = `\nsee portal.acmeplumbing.io\n`' }).map((hit) => hit.line)).toEqual([2])
    expect(checkPublic({ path: 'a.ts', text: 'const q = `${a.app}` + b.dev\nconst z = 1' })).toEqual([])
  })
})

describe('the check as a whole', () => {
  test('a clean file reports nothing and a file with one of each reports one hit per kind, with its line', () => {
    expect(checkPublic({ path: 'a.ts', text: "export const x = 1\nconst y = 'ana@example.com'\n" })).toEqual([])
    const hits = checkPublic({
      path: 'a.ts',
      text: ['ok', 'mail someone@realcorp.com', "const id = '3f9a1c7e5b2d4086a1b7c9d0e2f45a68'", 'call (415) 555-2671', '// see docs/problems/x/problem.md'].join('\n'),
    })
    expect(hits.map((hit) => [hit.line, hit.kind])).toEqual([
      [2, 'address'],
      [3, 'hex-id'],
      [4, 'phone'],
      [5, 'record'],
    ])
    expect(hits[0]).toMatchObject({ path: 'a.ts', text: 'mail someone@realcorp.com' })
  })

  test('windows line endings do not hide a line, and a long line is read to its end', () => {
    expect(checkPublic({ path: 'a.ts', text: 'one\r\nmail someone@realcorp.com\r\n' }).map((hit) => hit.line)).toEqual([2])
    expect(kinds(`${'x'.repeat(200_000)} someone@realcorp.com`)).toEqual(['address'])
  })

  test('only the check’s own tests are exempt', () => {
    expect(checkPublic({ path: 'packages/workspace/test/public-check.test.ts', text: 'someone@realcorp.com' })).toEqual([])
    expect(checkPublic({ path: 'test/public-check.test.ts', text: 'someone@realcorp.com' })).toEqual([])
    found('someone@realcorp.com', 'packages/workspace/test/other.test.ts')
    found('someone@realcorp.com', 'packages/workspace/src/public-check.ts')
  })

  test('the check’s own source and the plumbing it uses hold nothing it would find', () => {
    const own = ['../src/public-check.ts', '../src/check-tree.ts', '../src/source-context.ts', '../scripts/public-check.ts'].map((relative) => ({
      path: `packages/workspace/${relative.slice(3)}`,
      text: readFileSync(join(import.meta.dir, relative), 'utf8'),
    }))
    expect(checkPublicFiles(own)).toEqual([])
  })
})
