import { describe, expect, test } from 'bun:test'
import { splitQuoted } from '../src/quote'

/**
 * Where a message's own words end and the email it quotes begins, on samples shaped like what Gmail, Outlook and
 * Apple Mail write in plain text. A quote is folded only when it holds an earlier message of the conversation, so a
 * positive case names the earlier message it quotes, and a negative case says what it looks like and is not.
 */

const split = (body: string, earlier: string[] = [], subject = 'Re: Logo files') =>
  splitQuoted(body, { earlier, subject })
const whole = (body: string) => ({ visible: body, quoted: '' })

const joined = (s: { visible: string; quoted: string }) => (s.quoted === '' ? s.visible : `${s.visible}\n${s.quoted}`)

/** What the other side wrote before, which the replies below quote. */
const DELPHINE = 'Hi Tessa, would a 30 minute conversation about small business websites work for you?'
const MARTA = 'Could you take the spring sale banner off the home page for us?'
const SAM = 'Where are the logo files? We need them for the printer by Friday.'

describe('a reply that quotes an earlier message of the conversation', () => {
  const cases: { name: string; body: string; earlier: string[]; visible: string; quoted: string }[] = [
    {
      name: 'Gmail, plain text',
      earlier: [DELPHINE],
      body: [
        'Tuesday works. Send a link and I will join.',
        '',
        'Best,',
        'Tessa',
        '',
        'On Tue, Mar 3, 2026 at 11:20 AM Delphine Barlow <delphine@castmic.example> wrote:',
        '',
        '> Hi Tessa, would a 30 minute conversation',
        '> about small business websites work for you?',
        '>',
        '> Delphine',
      ].join('\n'),
      visible: 'Tuesday works. Send a link and I will join.\n\nBest,\nTessa',
      quoted: [
        'On Tue, Mar 3, 2026 at 11:20 AM Delphine Barlow <delphine@castmic.example> wrote:',
        '',
        '> Hi Tessa, would a 30 minute conversation',
        '> about small business websites work for you?',
        '>',
        '> Delphine',
      ].join('\n'),
    },
    {
      name: 'Gmail, with the attribution wrapped onto a second line',
      earlier: ['Can you do Thursday for the call about the new pages?'],
      body: [
        'Yes, that is fine.',
        '',
        'On Tue, Mar 3, 2026 at 11:20 AM Delphine Barlow <delphine.barlow@castmic.example>',
        'wrote:',
        '',
        '> Can you do Thursday for the call about the new pages?',
      ].join('\n'),
      visible: 'Yes, that is fine.',
      quoted: [
        'On Tue, Mar 3, 2026 at 11:20 AM Delphine Barlow <delphine.barlow@castmic.example>',
        'wrote:',
        '',
        '> Can you do Thursday for the call about the new pages?',
      ].join('\n'),
    },
    {
      name: 'Apple Mail, attribution on its own line above the quote',
      earlier: [MARTA],
      body: [
        'Sounds good, thanks!',
        '',
        'On Mar 3, 2026, at 11:20 AM, Marta Vidal <marta@tamarackprint.test> wrote:',
        '',
        '> Could you take the spring sale banner off',
        '',
        '> the home page for us?',
      ].join('\n'),
      visible: 'Sounds good, thanks!',
      quoted: [
        'On Mar 3, 2026, at 11:20 AM, Marta Vidal <marta@tamarackprint.test> wrote:',
        '',
        '> Could you take the spring sale banner off',
        '',
        '> the home page for us?',
      ].join('\n'),
    },
    {
      name: 'a quote the mail client wrote with no ">" marks (HTML turned to text)',
      earlier: [MARTA],
      body: [
        'Done.',
        '',
        'On Mar 3, 2026, at 11:20 AM, Marta Vidal <marta@tamarackprint.test> wrote:',
        '',
        'Could you take the spring sale banner off the home page for us?',
        '',
        'Thanks,',
        'Marta',
      ].join('\n'),
      visible: 'Done.',
      quoted: [
        'On Mar 3, 2026, at 11:20 AM, Marta Vidal <marta@tamarackprint.test> wrote:',
        '',
        'Could you take the spring sale banner off the home page for us?',
        '',
        'Thanks,',
        'Marta',
      ].join('\n'),
    },
    {
      name: 'Outlook, original message',
      earlier: [SAM],
      body: [
        'I will check and get back to you.',
        '',
        'Pat',
        '',
        '-----Original Message-----',
        'From: Sam Counsel <sam@samplelegal.test>',
        'Sent: Tuesday, March 3, 2026 11:20 AM',
        'To: Pat Partner <pat@samplelegal.test>',
        'Subject: Logo files',
        '',
        'Where are the logo files? We need them',
        'for the printer by Friday.',
      ].join('\n'),
      visible: 'I will check and get back to you.\n\nPat',
      quoted: [
        '-----Original Message-----',
        'From: Sam Counsel <sam@samplelegal.test>',
        'Sent: Tuesday, March 3, 2026 11:20 AM',
        'To: Pat Partner <pat@samplelegal.test>',
        'Subject: Logo files',
        '',
        'Where are the logo files? We need them',
        'for the printer by Friday.',
      ].join('\n'),
    },
    {
      name: 'Outlook, underscore separator then the header block',
      earlier: [SAM],
      body: [
        'Attached is the signed copy.',
        '',
        '________________________________',
        'From: Sam Counsel <sam@samplelegal.test>',
        'Sent: Tuesday, March 3, 2026 11:20 AM',
        'To: Tessa Marlow <tessa@northfield.example>',
        'Subject: Agreement',
        '',
        SAM,
      ].join('\n'),
      visible: 'Attached is the signed copy.',
      quoted: [
        '________________________________',
        'From: Sam Counsel <sam@samplelegal.test>',
        'Sent: Tuesday, March 3, 2026 11:20 AM',
        'To: Tessa Marlow <tessa@northfield.example>',
        'Subject: Agreement',
        '',
        SAM,
      ].join('\n'),
    },
    {
      name: 'Outlook, a header block with no separator over it',
      earlier: [SAM],
      body: [
        'Thanks.',
        '',
        'From: Sam Counsel <sam@samplelegal.test>',
        'Sent: Tuesday, March 3, 2026 11:20 AM',
        'To: Tessa Marlow <tessa@northfield.example>',
        'Subject: Agreement',
        '',
        SAM,
      ].join('\n'),
      visible: 'Thanks.',
      quoted: [
        'From: Sam Counsel <sam@samplelegal.test>',
        'Sent: Tuesday, March 3, 2026 11:20 AM',
        'To: Tessa Marlow <tessa@northfield.example>',
        'Subject: Agreement',
        '',
        SAM,
      ].join('\n'),
    },
    {
      name: 'Windows line endings',
      earlier: ['Is that ok with you? Tell me before the end of the week.'],
      body: 'Fine by me.\r\n\r\nOn Tue, Mar 3, 2026 at 11:20 AM Sam <sam@samplelegal.test> wrote:\r\n\r\n> Is that ok with you?\r\n> Tell me before the end of the week.\r\n',
      visible: 'Fine by me.',
      quoted:
        'On Tue, Mar 3, 2026 at 11:20 AM Sam <sam@samplelegal.test> wrote:\r\n\r\n> Is that ok with you?\r\n> Tell me before the end of the week.\r\n',
    },
  ]

  for (const c of cases) {
    test(c.name, () => {
      const s = split(c.body, c.earlier)
      expect(s.visible).toBe(c.visible)
      expect(s.quoted).toBe(c.quoted)
    })
  }

  test('the earlier message can be any of the ones before, and may itself have carried an older quote', () => {
    const earlierWithQuote = `${DELPHINE}\n\nOn Mon, Mar 2, 2026 at 9:00 AM Tessa Marlow <tessa@northfield.example> wrote:\n> Are you free next month?`
    const body = `Agreed.\n\nOn Tue, Mar 3, 2026 at 11:20 AM Delphine <d@castmic.example> wrote:\n> ${DELPHINE}\n>\n> On Mon, Mar 2, 2026 at 9:00 AM Tessa Marlow <tessa@northfield.example> wrote:\n>> Are you free next month?`
    expect(split(body, ['Hello', 'Short', earlierWithQuote]).visible).toBe('Agreed.')
    // The client trimmed the older quote out of what it sent back: the earlier message's own words still prove it.
    const trimmed = `Agreed.\n\nOn Tue, Mar 3, 2026 at 11:20 AM Delphine <d@castmic.example> wrote:\n> ${DELPHINE}`
    expect(split(trimmed, [earlierWithQuote]).visible).toBe('Agreed.')
  })

  test('wrapping, ">" marks, spacing, punctuation and curly quotes do not stop it matching', () => {
    const earlier = "It's fine: the page can't go live until the logo files arrive, so please send them today."
    const body = [
      'Will do.',
      '',
      'On Tue, Mar 3, 2026 at 11:20 AM Sam <sam@samplelegal.test> wrote:',
      '> It’s fine: the page can’t go live until the',
      '> logo   files arrive,',
      '> so please send them today.',
    ].join('\n')
    expect(split(body, [earlier]).visible).toBe('Will do.')
  })

  test('a quote of a quote folds at the first attribution, with the older ones inside it', () => {
    const body = [
      'Agreed.',
      '',
      'On Tue, Mar 3, 2026 at 11:20 AM Sam <sam@samplelegal.test> wrote:',
      '> Sounds good, I will start Monday as we discussed.',
      '>',
      '> On Mon, Mar 2, 2026 at 9:00 AM Tessa Marlow <tessa@northfield.example> wrote:',
      '> > Can we start Monday?',
    ].join('\n')
    const s = split(body, ['Sounds good, I will start Monday as we discussed.'])
    expect(s.visible).toBe('Agreed.')
    expect(s.quoted.startsWith('On Tue, Mar 3, 2026')).toBe(true)
    expect(s.quoted).toContain('> > Can we start Monday?')
  })
})

describe('what looks like a quote and is not one, so nothing is folded', () => {
  // The conversation has an earlier message in every one of these, and none of them is in what follows the line.
  const earlier = [SAM, 'Hello Abel, the invoice is for $500. Please confirm the new address is 12 Main St.']

  const cases: { name: string; body: string }[] = [
    {
      name: 'an Outlook forward: underscores, From, Sent and the forwarded mail',
      body: 'FYI see below\n\n________________________________\nFrom: Bank\nSent: Monday\nTo: Abel\nSubject: Wire details\n\nAcct 1234',
    },
    {
      name: 'an Outlook forward with the header block and no separator',
      body: 'Forwarding this.\n\nFrom: Bank <b@b.example.com>\nSent: Monday, October 19, 2026 3:00 PM\nTo: Abel\nSubject: Wire\n\nAcct 1234',
    },
    {
      name: 'an Outlook "Original Message" that is only a forward',
      body: 'FYI\n\n-----Original Message-----\nFrom: Bank\nSent: Mon\nSubject: Wire\n\nAcct 1234',
    },
    {
      name: 'an Outlook inline reply: the answers sit between the questions',
      body: `See answers inline.\n\n-----Original Message-----\nFrom: Tessa\nSent: Mon\nTo: Abel\n\n1. Where are the logo files? -> sent today (Abel)\n2. We need them for the printer by Friday. -> understood (Abel)`,
    },
    {
      name: 'an inline reply under an attribution, with no ">" marks (HTML turned to text)',
      body: 'See below in red.\n\nOn Mon, Mar 2, 2026 at 3:40 PM Tessa <j@z.example.com> wrote:\n\nQ1 price? ANSWER: $500\nQ2 date? ANSWER: Friday',
    },
    {
      name: 'an inline reply under an attribution, with ">" marks',
      body: 'See below.\n\nOn Mon, Mar 2, 2026 at 3:40 PM Tessa <j@z.example.com> wrote:\n> Q1 price?\n$500\n> Q2?\nFriday',
    },
    {
      name: 'the sender’s own prose: "On 10/19 you wrote:"',
      body: 'The site looks great.\nOn 10/19 you wrote:\n"change the phone" - done.\nAnything else?',
    },
    {
      name: 'the sender’s own prose: "On Oct 3 I wrote:"',
      body: 'Hi Tessa,\nOn Oct 3 I wrote:\nthe invoice is $500. Please confirm the new address is 12 Main St.\nThanks',
    },
    {
      name: 'prose with "From:" and "Sent:" lines in it',
      body: 'Notes from the call:\nFrom: the client side, Ana\nSent: the files yesterday\nSubject: still pending the lease\nPlease check.',
    },
    {
      name: 'prose with "From:", "Sent:" and "To:" lines in it',
      body: 'Status:\nFrom: Abel\nSent: Monday\nTo: Wren\nThe contract terms changed, new price is $900.',
    },
    {
      name: 'a signature: "On leave Oct 20 - Oct 24, my assistant wrote:"',
      body: 'Thanks!\n\nAbel Ng, CPA\nOn leave Oct 20 - Oct 24, my assistant wrote:\nnothing',
    },
    {
      name: 'a rule of underscores over a signature block with a "From:" line',
      body: 'Sign here:\n__________________\nFrom: Abel (signature)\nDate:',
    },
  ]

  for (const c of cases) {
    test(c.name, () => {
      expect(split(c.body, earlier)).toEqual(whole(c.body))
    })
  }

  test('a Gmail forward is shown whole, header and all', () => {
    const body = [
      'FYI, see below.',
      '',
      '---------- Forwarded message ---------',
      'From: Sam Counsel <sam@samplelegal.test>',
      'Date: Tue, Mar 3, 2026 at 11:20 AM',
      'Subject: Agreement',
      'To: Tessa Marlow <tessa@northfield.example>',
      '',
      'Please sign.',
      '',
      'On Mon, Mar 2, 2026 at 9:00 AM Pat <pat@samplelegal.test> wrote:',
      '> Draft attached.',
    ].join('\n')
    expect(split(body, ['Draft attached. Please read it before Friday.'])).toEqual(whole(body))
  })

  test('a forward whose quoted part is an earlier message is still whole, because the forward comes first', () => {
    const body = `FYI.\n\nBegin forwarded message:\n\nOn Mon, Mar 2, 2026 at 9:00 AM Pat <p@s.test> wrote:\n> ${SAM}`
    expect(split(body, [SAM])).toEqual(whole(body))
  })
})

describe('never folded, whatever the quote holds', () => {
  const quoting = `Thanks.\n\nOn Tue, Mar 3, 2026 at 11:20 AM Sam <sam@samplelegal.test> wrote:\n> ${SAM}`

  test('it does fold when the quote holds an earlier message (the control for the cases below)', () => {
    expect(split(quoting, [SAM]).visible).toBe('Thanks.')
  })

  test('a message under a Fw: or Fwd: subject', () => {
    for (const subject of ['Fw: Logo files', 'FWD: Logo files', ' fwd: Logo files']) {
      expect(split(quoting, [SAM], subject)).toEqual(whole(quoting))
    }
  })

  test('a "Re: Fwd:" subject is a reply to a forward, which folds as any reply does', () => {
    expect(split(quoting, [SAM], 'Re: Fwd: Logo files').visible).toBe('Thanks.')
  })

  test('a conversation with no earlier message', () => {
    expect(split(quoting, [])).toEqual(whole(quoting))
  })

  test('an earlier message too short to prove anything', () => {
    const body = 'Thanks.\n\nOn Tue, Mar 3, 2026 at 11:20 AM Sam <sam@samplelegal.test> wrote:\n> Thanks!'
    expect(split(body, ['Thanks!'])).toEqual(whole(body))
  })

  test('a quote that holds only part of an earlier message', () => {
    const earlier = `${SAM} Also please send the brand colors and the fonts in a zip file, the way we did for the last job.`
    const body = `Thanks.\n\nOn Tue, Mar 3, 2026 at 11:20 AM Sam <sam@samplelegal.test> wrote:\n> Where are the logo`
    expect(split(body, [earlier])).toEqual(whole(body))
  })

  test('KNOWN GAP: an Outlook inline reply whose answers come after the first 200 letters of the quote folds with it', () => {
    // The proof is the OPENING of an earlier message (PROOF_LENGTH), so an unmarked inline reply that keeps that opening and answers further down is
    // folded, answers and all. This pins today's behaviour so that changing it is a choice: the stricter proof (the whole earlier message) was tried
    // on real mail and unfolded 3 of 31 ordinary replies (a signature link Gmail added to its quote, "Color" for "Colour"),
    // and found no inline reply to protect. See the header of quote.ts.
    const plan =
      'Hi Dana, here is the plan for the flyer. We will print five hundred copies on heavy stock and deliver them to the shop on Thursday morning before you open. The proof is attached for your review and sign off. Second, the price is four hundred dollars, half now and half on delivery. Third, can you confirm the address on the back?'
    const body = [
      'Hi Tessa, answers below in red.',
      '',
      'From: Tessa Marlow <tessa@northfield.example>',
      'Sent: Tuesday, March 10, 2026 9:05 AM',
      'To: Dana Reyes <dana@x.example>',
      'Subject: Flyer',
      '',
      'Hi Dana, here is the plan for the flyer. We will print five hundred copies on heavy stock and deliver them to the shop on Thursday morning before you open. The proof is attached for your review and sign off.',
      'Second, the price is four hundred dollars, half now and half on delivery.',
      'DANA: Can we do three hundred? Budget is tight this month.',
      'Third, can you confirm the address on the back?',
      'DANA: The address should be 12 Main St, not 21.',
    ].join('\n')
    const s = split(body, [plan], 'RE: Flyer')
    expect(s.visible).toBe('Hi Tessa, answers below in red.')
    expect(s.quoted).toContain('DANA: The address should be 12 Main St, not 21.')
  })

  test('a message with no quote is left whole', () => {
    const body = 'Hi Tessa,\n\nWe signed the agreement this morning. What happens next?\n\nSam'
    expect(split(body, [SAM])).toEqual(whole(body))
  })

  test('an empty body is left whole', () => {
    expect(split('', [SAM])).toEqual(whole(''))
  })

  test('">" lines in the new text are not a quote, and the real quote under them still folds', () => {
    const body = [
      'You wrote:',
      '> I will send the schedule tomorrow',
      'and I am holding you to it. Also see:',
      '> https://example.com/schedule',
      '',
      'Tessa',
      '',
      'On Tue, Mar 3, 2026 at 11:20 AM Sam <sam@samplelegal.test> wrote:',
      `> ${SAM}`,
    ].join('\n')
    const s = split(body, [SAM])
    expect(s.visible).toBe(
      [
        'You wrote:',
        '> I will send the schedule tomorrow',
        'and I am holding you to it. Also see:',
        '> https://example.com/schedule',
        '',
        'Tessa',
      ].join('\n'),
    )
    expect(s.quoted).toBe(['On Tue, Mar 3, 2026 at 11:20 AM Sam <sam@samplelegal.test> wrote:', `> ${SAM}`].join('\n'))
  })

  test('">" lines at the end with no attribution are left alone', () => {
    const body = `This is the line I mean:\n> ${SAM}`
    expect(split(body, [SAM])).toEqual(whole(body))
  })

  test('an attribution that is itself quoted is not where a quote starts', () => {
    const body = `Sounds good.\n\n> On Mar 3, 2026, at 11:20 AM, Marta <m@t.test> wrote:\n> ${MARTA}`
    expect(split(body, [MARTA])).toEqual(whole(body))
  })

  test('"wrote:" in a sentence is not an attribution', () => {
    const body = 'On Monday Sam wrote: it is fine.\n\nOn Tuesday he wrote:\n- a\n- b'
    expect(split(body, [SAM])).toEqual(whole(body))
  })

  test('a line of underscores with no "From:" under it is only a rule', () => {
    const body = 'Part one\n\n________________________________\n\nPart two'
    expect(split(body, [SAM])).toEqual(whole(body))
  })

  test('never the whole message: a quote that starts on the first line leaves everything showing', () => {
    const body = `On Tue, Mar 3, 2026 at 11:20 AM Sam <sam@samplelegal.test> wrote:\n> ${SAM}`
    expect(split(body, [SAM])).toEqual(whole(body))
    const outlook = `-----Original Message-----\nFrom: Sam\nSent: Monday\nTo: me\n\n${SAM}`
    expect(split(outlook, [SAM])).toEqual(whole(outlook))
  })
})

describe('the halves', () => {
  test('put back together they are the body, less only the blank lines between them', () => {
    const body = `Fine.\n\n\nOn Tue, Mar 3, 2026 at 11:20 AM Sam <sam@samplelegal.test> wrote:\n> ${SAM}`
    const s = split(body, [SAM])
    expect(s.visible).toBe('Fine.')
    expect(joined(s).replace(/\n+/g, '\n')).toBe(body.replace(/\n+/g, '\n'))
  })
})
