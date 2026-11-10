import { describe, expect, test } from 'bun:test'
import { reflow } from '../src/reflow'

/**
 * Display-only reflow of hard-wrapped plain text, on samples shaped like what Gmail's text/plain alternative,
 * Outlook, Thunderbird (format=flowed) and Apple Mail write. A sample that is wrapped is built by `wrap`, which
 * breaks a paragraph greedily at a width the way those clients do, so the expectation is the paragraph itself.
 * The samples are synthetic (the Gmail fixtures are PLACEHOLDERs and none holds a wrapped body): what a real
 * wrapped message looks like is for the hand test against the live inbox.
 */

/** Greedy word wrap at `width`, as a mail client wraps the plain-text copy of what it composed. */
function wrap(paragraph: string, width: number, softSpace = false): string {
  const lines: string[] = []
  let line = ''
  for (const word of paragraph.split(' ')) {
    if (line !== '' && line.length + 1 + word.length > width) {
      lines.push(softSpace ? `${line} ` : line)
      line = word
    } else line = line === '' ? word : `${line} ${word}`
  }
  lines.push(line)
  return lines.join('\n')
}

const P1 =
  'Thanks for sending the first round of the page. I went through it twice and most of it is exactly what we wanted, ' +
  'especially the new header and the way the services are laid out one under the other.'
const P2 =
  'And when a photo is swapped for a new one, should the old one be deleted for good, or kept in a folder? I would rather ' +
  'keep the old wording somewhere in case the client asks for it back next month.'

const cases: { name: string; input: string; output: string }[] = [
  {
    name: 'Gmail plain text, wrapped at 76: paragraphs flow, the greeting and the sign-off stay lines',
    input: ['Hi Tessa,', '', wrap(P1, 76), '', wrap(P2, 76), '', 'Thanks,', 'Dana'].join('\n'),
    output: ['Hi Tessa,', '', P1, '', P2, '', 'Thanks,', 'Dana'].join('\n'),
  },
  {
    name: 'the sentence from the inbox, wrapped mid-sentence',
    input: [
      'The first two pages read well and I would change nothing in them. And when a',
      'photo is swapped for a new one, should the old one be deleted for good, or',
      'kept in a folder?',
    ].join('\n'),
    output:
      'The first two pages read well and I would change nothing in them. And when a photo is swapped for a new one, should the old one be deleted for good, or kept in a folder?',
  },
  {
    name: 'Outlook plain text, wrapped at 72, with a signature block of short lines',
    input: [
      'Tessa,',
      '',
      wrap(P1, 72),
      '',
      'Dana Smith',
      'Director of Operations',
      'Acme Dental Group',
      '1234 Colorado Blvd, Suite 200',
      'Springfield, CA 91101',
      'T: 626-555-0100',
    ].join('\n'),
    output: [
      'Tessa,',
      '',
      P1,
      '',
      'Dana Smith',
      'Director of Operations',
      'Acme Dental Group',
      '1234 Colorado Blvd, Suite 200',
      'Springfield, CA 91101',
      'T: 626-555-0100',
    ].join('\n'),
  },
  {
    name: 'Apple Mail, which does not wrap: one long line per paragraph is untouched',
    input: ['Hi Tessa,', '', P1, '', P2, '', 'Best,', 'Dana'].join('\n'),
    output: ['Hi Tessa,', '', P1, '', P2, '', 'Best,', 'Dana'].join('\n'),
  },
  {
    name: 'format=flowed (Thunderbird): a line ending in a space is a soft break, at any width',
    input: ['Hi Tessa,', '', wrap(P1, 66, true), '', 'Thanks,', 'Dana'].join('\n'),
    output: ['Hi Tessa,', '', P1, '', 'Thanks,', 'Dana'].join('\n'),
  },
  {
    name: 'a short line that ends in a stray space is not a soft break',
    input: ['Thanks, ', 'Dana', '', 'Sent from my phone '].join('\n'),
    output: ['Thanks, ', 'Dana', '', 'Sent from my phone '].join('\n'),
  },
  {
    name: 'bulleted list: items stay apart, a wrapped item is joined, an indented continuation too',
    input: [
      'Here is what I need before the launch of the new site on Friday morning:',
      '- The final logo files in SVG and PNG, including the one with a transparent background for the header',
      '- Photos of the storefront and the two technicians who will be named on the page, if they agree',
      '  to it',
      '- Hours',
      '',
      wrap(P2, 76),
    ].join('\n'),
    output: [
      'Here is what I need before the launch of the new site on Friday morning:',
      '- The final logo files in SVG and PNG, including the one with a transparent background for the header',
      '- Photos of the storefront and the two technicians who will be named on the page, if they agree to it',
      '- Hours',
      '',
      P2,
    ].join('\n'),
  },
  {
    name: 'a numbered list whose items wrap with a hanging indent',
    input: [
      wrap(P1, 76),
      '',
      '1. Send the logo files in both formats so the printer has what it needs and',
      '   can check them on time.',
      '2. Confirm the opening hours on the page.',
      '3) Reply to Marta.',
    ].join('\n'),
    output: [
      P1,
      '',
      '1. Send the logo files in both formats so the printer has what it needs and can check them on time.',
      '2. Confirm the opening hours on the page.',
      '3) Reply to Marta.',
    ].join('\n'),
  },
  {
    name: 'an address and a signature after the delimiter are left alone, even when the lines are long',
    input: [
      wrap(P1, 76),
      '',
      '-- ',
      'Dana Smith, Director of Operations, Acme Dental Group, a member of the California Dental Association',
      'and the American Dental Association since 1998',
      '1234 Colorado Blvd, Suite 200',
    ].join('\n'),
    output: [
      P1,
      '',
      '-- ',
      'Dana Smith, Director of Operations, Acme Dental Group, a member of the California Dental Association',
      'and the American Dental Association since 1998',
      '1234 Colorado Blvd, Suite 200',
    ].join('\n'),
  },
  {
    name: 'short lines the sender typed stay: an address, a poem, a to-do',
    input: [
      wrap(P2, 76),
      '',
      'Please ship to:',
      'Tamarack Print Supply',
      '1234 Colorado Blvd',
      'Springfield, CA 91101',
      '',
      'Roses are red',
      'Violets are blue',
    ].join('\n'),
    output: [
      P2,
      '',
      'Please ship to:',
      'Tamarack Print Supply',
      '1234 Colorado Blvd',
      'Springfield, CA 91101',
      '',
      'Roses are red',
      'Violets are blue',
    ].join('\n'),
  },
  {
    name: 'two long lines the sender typed on separate lines are not read as a wrap (one coincidence of length)',
    input: [
      'The quote for the new site covers the design, the build and one round of changes after launch.',
      'Thanks for waiting.',
    ].join('\n'),
    output: [
      'The quote for the new site covers the design, the build and one round of changes after launch.',
      'Thanks for waiting.',
    ].join('\n'),
  },
  {
    name: 'a line before a sign-off is not joined to it, even when it is full width',
    input: [
      wrap(P1, 76),
      '',
      'Let me know what you think of the page before Friday so we can ship it that week.',
      'Thanks!',
    ].join('\n'),
    output: [
      P1,
      '',
      'Let me know what you think of the page before Friday so we can ship it that week.',
      'Thanks!',
    ].join('\n'),
  },
  {
    name: 'quoted lines are never joined, and the new text above them is',
    input: [
      wrap(P1, 76),
      '',
      'On Tue, Mar 3, 2026 at 11:20 AM Delphine Barlow <delphine@castmic.example> wrote:',
      '',
      '> Hi Tessa, would a 30 minute conversation about small business websites',
      '> work for you? I have time on Tuesday afternoon or any time on Thursday.',
    ].join('\n'),
    output: [
      P1,
      '',
      'On Tue, Mar 3, 2026 at 11:20 AM Delphine Barlow <delphine@castmic.example> wrote:',
      '',
      '> Hi Tessa, would a 30 minute conversation about small business websites',
      '> work for you? I have time on Tuesday afternoon or any time on Thursday.',
    ].join('\n'),
  },
  {
    name: 'a URL on its own line is never joined to the line above or below',
    input: [
      wrap(P1, 76),
      'Here is the preview you asked for, which I will keep up until the end of the week:',
      'https://preview.example.com/pages/tamarack-print-supply/home?draft=2',
      'and the staging copy, in case that one is slow, is on the second address below it.',
    ].join('\n'),
    output: [
      P1,
      'Here is the preview you asked for, which I will keep up until the end of the week:',
      'https://preview.example.com/pages/tamarack-print-supply/home?draft=2',
      'and the staging copy, in case that one is slow, is on the second address below it.',
    ].join('\n'),
  },
  {
    name: 'a table, columns of spaces, pipes and code are left as they are',
    input: [
      wrap(P1, 76),
      '',
      'Item            Qty     Price',
      'Logo design      1      $400.00',
      '| Page | Status                                                   |',
      '| Home | done, waiting on photos from the client for the gallery  |',
      '  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0)',
      '  console.log(total)',
    ].join('\n'),
    output: [
      P1,
      '',
      'Item            Qty     Price',
      'Logo design      1      $400.00',
      '| Page | Status                                                   |',
      '| Home | done, waiting on photos from the client for the gallery  |',
      '  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0)',
      '  console.log(total)',
    ].join('\n'),
  },
  {
    name: 'two near-full lines are joined, and the sign-off under them stays its own lines',
    input: [
      'I went through the first round of the pages twice and most of it is exactly',
      'what we wanted, especially the new header and the services laid out below it',
      'Thanks',
      'Dana',
    ].join('\n'),
    output: [
      'I went through the first round of the pages twice and most of it is exactly what we wanted, especially the new header and the services laid out below it',
      'Thanks',
      'Dana',
    ].join('\n'),
  },
  {
    name: 'a line under a list item indented past where its text starts is not its wrap',
    input: [
      '- The final logo files in SVG and PNG, including the transparent one for the header',
      '    see the folder',
    ].join('\n'),
    output: [
      '- The final logo files in SVG and PNG, including the transparent one for the header',
      '    see the folder',
    ].join('\n'),
  },
  {
    name: 'Windows line endings',
    input: `${wrap(P1, 76).replace(/\n/g, '\r\n')}\r\n\r\nBest,\r\nDana`,
    output: `${P1}\n\nBest,\nDana`,
  },
  {
    name: 'nothing to do: empty',
    input: '',
    output: '',
  },
]

/**
 * Lines a sender typed apart, where one long line without end punctuation is the only line long enough to be a wrap
 * width. That line sets the width by itself, so it is no evidence of a wrap, and none of these may be joined (the
 * review found each one run together).
 */
const typedApart: { name: string; input: string }[] = [
  {
    name: 'a request, then a sign-off and a name with no punctuation',
    input: 'Please send the signed contract back to me at your earliest convenience\nThanks\nRhea',
  },
  {
    name: 'a signature with no delimiter, a long title and address line, then the phone numbers',
    input: [
      'Best regards,',
      'Rhea Lang',
      'Office Manager, Brightpath Dental, 1234 Colorado Blvd, Suite 200, Springfield',
      'Tel 626-555-0163 | Fax 626-555-0164',
    ].join('\n'),
  },
  {
    name: 'a typed line, then an address under it',
    input: [
      'Please ship the proofs to our new office address which is just below this',
      'Brightpath Dental',
      '1234 Colorado Blvd, Suite 200',
      'Springfield, CA 91101',
    ].join('\n'),
  },
  {
    name: 'a typed line, then "Let me know"',
    input: 'I can do Tuesday afternoon or Wednesday morning, whichever suits you best\nLet me know',
  },
  {
    name: 'an Outlook signature with a long company line',
    input: [
      'Thanks,',
      'Teo Ortiz',
      'Sorrel Bookkeeping LLC, Payroll and Bookkeeping for the Willamette Valley',
      'Office 626-555-0100',
      'sora.example',
    ].join('\n'),
  },
]

describe('lines a sender typed apart stay apart', () => {
  for (const c of typedApart) {
    test(c.name, () => {
      expect(reflow(c.input)).toBe(c.input)
    })
  }
})

describe('reflow', () => {
  for (const c of cases) {
    test(c.name, () => {
      expect(reflow(c.input)).toBe(c.output)
    })
  }

  test('reflowing twice changes nothing more', () => {
    for (const c of cases) expect(reflow(reflow(c.input))).toBe(reflow(c.input))
  })

  test('the words are all still there, in order', () => {
    const words = (s: string) => s.split(/\s+/).filter(Boolean).join(' ')
    for (const c of cases) expect(words(reflow(c.input))).toBe(words(c.input))
  })
})
