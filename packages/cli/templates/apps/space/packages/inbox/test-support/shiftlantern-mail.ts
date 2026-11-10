/**
 * Mail to hello@shiftlantern.example as it really arrives, for the tests of ShiftLantern's spam questions
 * (test/shiftlantern-spam.test.ts). Written by hand to look like what the site hears (packages/inbox/docs/runbooks/inbox-cloudflare-mailbox.md):
 * `KEEP` is mail that must never be judged spam, hard cases included (a worker who writes in capitals, in Spanish with the
 * accents missing, in Chinese, in one line, or who happens to say "invoice" or "crypto" about their own job), and `JUNK` is
 * what a public contact address collects. A fake Workers AI answers the tests, so these show what is put to the model and what
 * the inbox does with each answer. Whether the real model gets each one right is the measurement in the runbook ("The spam
 * questions"), which runs the same list through Clef.
 */

export interface SampleMail {
  /** A short name for the case, for a failure message. */
  id: string
  name: string
  from: string
  subject: string
  body: string
}

export const KEEP: SampleMail[] = [
  {
    id: 'final-paycheck-en',
    name: 'Maria Lopez',
    from: 'maria.lopez84@gmail.example',
    subject: 'Final paycheck question',
    body: 'I was let go on Friday from a restaurant in Fresno. My manager said my last check would come in the mail in a couple of weeks. Is that allowed? I need that money for rent and I dont know who to ask.',
  },
  {
    id: 'fired-en-angry',
    name: 'DERRICK W',
    from: 'dw_2291@yahoo.example',
    subject: 'FIRED FOR NO REASON',
    body: 'They fired me TODAY after I told HR I was pregnant and now they say its "at will". I worked there 4 years. ARE THEY ALLOWED TO DO THIS?? I dont even know what to do. please help me',
  },
  {
    id: 'breaks-es',
    name: 'Rosa Hernandez',
    from: 'rosahdz1971@hotmail.example',
    subject: 'Descansos y comida en el trabajo',
    body: 'Buenas tardes. Trabajo en una bodega en Ontario y casi nunca nos dejan tomar el descanso de comida, a veces trabajamos 9 horas sin parar. Mi supervisor dice que si no me gusta me puedo ir. Tengo derecho a que me paguen por esos descansos? Gracias por su ayuda.',
  },
  {
    id: 'final-paycheck-es-no-accents',
    name: 'jorge m',
    from: 'jorge.mtz.2020@gmail.example',
    subject: 'me despidieron y no me pagaron',
    body: 'hola me despidieron hace 3 semanas y todavia no me dan mi cheque final ni las vacaciones que tenia. la compania dice que tengo que ir a su oficina en otro estado. que puedo hacer? no hablo bien ingles',
  },
  {
    id: 'overtime-zh',
    name: '陈美玲',
    from: 'meiling.chen88@qq.example',
    subject: '加班费的问题',
    body: '你好，我在洛杉矶的一家餐厅工作，每天工作十个小时，老板说我们是按天算工资，所以没有加班费。请问这样合法吗？我应该怎么办？谢谢。',
  },
  {
    id: 'one-line',
    name: 'Tony',
    from: 'tony5551@gmail.example',
    subject: 'help',
    body: 'my boss wont pay me. what do i do',
  },
  {
    id: 'sick-leave-long',
    name: 'Angela Brooks',
    from: 'angela.brooks@outlook.example',
    subject: 'sick days and a write up - long, sorry',
    body: 'Sorry this is long. I work at a warehouse in Riverside. In March I used two sick days for my son who had a fever and my lead gave me a written warning for attendance. Then in June my hours were cut from 38 to 14 a week and nobody will tell me why. I asked HR and they said "business needs". I looked at your page on paid sick leave and I think I have 40 hours a year but my pay stubs dont show any balance. Is the warning legal? Is the cut retaliation? I have the text messages from my lead if that matters. I dont have a lawyer and cant afford one. Thank you for reading this.',
  },
  {
    id: 'misclassified-invoice-crypto',
    name: 'Sam Patel',
    from: 'sam.patel.dev@gmail.example',
    subject: 'Paid as a contractor but I work set hours, invoice not paid',
    body: 'A startup hired me as a "1099 contractor" but I work 9 to 5 on their schedule with their laptop. I sent them my last invoice 60 days ago and they said they will pay me in crypto instead, maybe. Am I really a contractor under California law? Where do I start?',
  },
  {
    id: 'correction',
    name: 'Priya Nair',
    from: 'priya.nair@sfsu.example',
    subject: 'Correction on your overtime page',
    body: 'Hello, I teach employment law and wanted to point out that the daily overtime example on your overtime page says time and a half after 8 hours, but it leaves out double time after 12 hours in a day. Happy to point you to the section of the statute if that is useful. Thanks for the clear writing.',
  },
  {
    id: 'worker-center',
    name: 'Luis Ortega',
    from: 'lortega@workercenter.example.org',
    subject: 'Can we link to your final paycheck guide?',
    body: 'Hi, I am an organizer at a worker center in the Rogue Valley. We help day laborers and warehouse workers with wage claims. Your final paycheck guide is the clearest we have found and we would like to hand it out and link to it from our resources page, in Spanish if you have it. Please let me know if that is ok.',
  },
  {
    id: 'legal-aid',
    name: 'Hannah Kim',
    from: 'hkim@legalaid.example.org',
    subject: 'Referral partner for workers in Orange County',
    body: 'Hello, I am a staff attorney at a legal aid nonprofit. We take wage and hour cases for low-income workers. If a worker writes to you who needs a lawyer, please feel free to send them to our intake line. I am glad to answer questions about what we do.',
  },
  {
    id: 'journalist',
    name: 'Jordan Reyes',
    from: 'jreyes@newsroom.example.com',
    subject: 'Reporter question about wage theft claims',
    body: 'Hi, I am a reporter working on a story about how long wage claims take in California. Do you have any numbers on how many workers write to you about unpaid wages? I am on deadline Friday. Happy to talk by phone.',
  },
  {
    id: 'attorney-intro',
    name: 'Daniel Okafor',
    from: 'dokafor@okaforlaw.example.com',
    subject: 'Introduction, employment attorney in San Diego',
    body: 'Hello, my name is Daniel Okafor and I represent employees in wage and hour and wrongful termination cases in San Diego. I came across shiftlantern.example and think it is a useful resource. I wanted to introduce myself in case you ever get questions from workers in my area. No obligation at all.',
  },
  {
    id: 'librarian',
    name: 'Ellen Park',
    from: 'epark@library.example',
    subject: 'Adding ShiftLantern to our job seeker page',
    body: 'Good morning. I am a librarian at a county library and we keep a page of resources for job seekers and workers. May we add shiftlantern.example to it? Is there a name we should use for the site?',
  },
]

export const JUNK: SampleMail[] = [
  {
    id: 'seo',
    name: 'Kevin Marsh',
    from: 'kevin@rankboost-seo.example.com',
    subject: 'Get shiftlantern.example to page 1 of Google',
    body: 'Hi there, I was looking at shiftlantern.example and noticed it is not ranking for most of its keywords. We help websites like yours get 3x more organic traffic in 90 days. Can I send you a free SEO audit and our pricing? Reply YES and I will send it over. Best, Kevin, Senior SEO Consultant.',
  },
  {
    id: 'backlinks',
    name: 'Olivia',
    from: 'olivia@linkbuilders.example.net',
    subject: 'Backlink opportunity for your site',
    body: 'Hello, we run a network of high authority sites (DA 60+) and can place a dofollow backlink to shiftlantern.example for just $80 per link. We also do link exchanges. Let me know how many links you would like this month.',
  },
  {
    id: 'guest-post',
    name: 'Mark Dillon',
    from: 'mark.dillon@contentdesk.example.com',
    subject: 'Guest post submission for shiftlantern.example',
    body: 'Hi Webmaster, I would love to contribute a guest post to your site on "10 Ways to Boost Your Business Productivity". The article is 100% unique and I only ask for a dofollow link to my client in the author bio. Sponsored post fees are also available on request. Thanks!',
  },
  {
    id: 'web-design',
    name: 'Sunny',
    from: 'sunny@pixelcraft.example',
    subject: 'Redesign your website and double your leads',
    body: 'Dear Sir/Madam, your website looks outdated on mobile. Our team of 40 designers and developers can give shiftlantern.example a modern redesign starting at $499, plus social media marketing. We have done 500+ projects. Please share your requirements and we will send a free mockup.',
  },
  {
    id: 'lead-gen',
    name: 'Brad Fisher',
    from: 'brad@leadsnow.example.com',
    subject: 'Exclusive employment leads, pay per lead',
    body: 'Hi, we generate exclusive employment law leads: workers actively looking for an attorney, delivered to your inbox in real time. Pay per lead, no contracts. Want a sample list of 50 contacts to see the quality? Book a 15 minute call.',
  },
  {
    id: 'crypto',
    name: 'Alex Morgan',
    from: 'alex@cryptoyield.example',
    subject: 'Earn 5% daily, limited spots',
    body: 'Congratulations, you have been selected for our private crypto staking program. Deposit USDT and earn 5% daily, withdraw anytime. Only 12 spots left this week. Click the link below to claim your bonus wallet.',
  },
  {
    id: 'phishing',
    name: 'Domain Services',
    from: 'support@domain-renewal-center.example.com',
    subject: 'Final notice: shiftlantern.example expires in 24 hours',
    body: 'Your domain shiftlantern.example will expire within 24 hours and your website will go offline. To avoid suspension, verify your account and pay the renewal fee immediately using the secure link below. Failure to act will result in permanent loss of the domain.',
  },
  {
    id: 'fake-invoice',
    name: 'Accounts Receivable',
    from: 'billing@invoice-desk.example.com',
    subject: 'Invoice #88213 overdue, payment required',
    body: 'Please find attached invoice #88213 for $1,480.00 for hosting and website maintenance services. Payment is overdue. Remit within 48 hours via the link below to avoid late fees. Do not reply to this message.',
  },
  {
    id: 'partnership',
    name: 'Megan Cole',
    from: 'megan@growthpartners.example.com',
    subject: 'Partnership opportunity with shiftlantern.example',
    body: 'Hi, I hope this finds you well. I am reaching out on behalf of our brand to explore a mutually beneficial partnership and collaboration with your website. We believe our audiences are a great fit. Could we schedule a quick call this week to discuss synergies?',
  },
  {
    id: 'law-firm-marketing',
    name: 'Corin Tate',
    from: 'corin@lawfirmgrowth.example.com',
    subject: 'More clients for your practice',
    body: 'Hello, we help law firms and legal sites get more signed cases with paid listings and a featured spot on our directory. Plans start at $299 a month. Want to see which sites like yours already rank with us?',
  },
]
