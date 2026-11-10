import { claudeNotice, type ServiceWords, viaSuffix } from '../service'

// The landing page and the privacy notice a stranger reads at the signer's address without a link (the space's /s/ and /privacy), as plain components so a test can render them (main.tsx mounts them). Every name on them
// is the install's (ServiceWords); the sentences are the same in every install, except where the install's Forms sends only for its own company (ownCompanyOnly) and there is no second party to name.


const LINK = 'underline underline-offset-2 hover:text-foreground'

function Shell({ s, children }: { s: ServiceWords; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-4 px-4 py-3">
          <a href="/" className="text-base font-semibold">
            {s.name}
          </a>
          <a href="/privacy" className={`${LINK} text-sm text-muted-foreground`}>
            Privacy notice
          </a>
        </div>
      </header>
      <main className="mx-auto grid max-w-2xl gap-5 px-4 py-8">{children}</main>
      <footer className="mx-auto max-w-2xl px-4 pb-10 text-xs text-muted-foreground">
        {s.ownCompanyOnly ? `${s.name} is the signing service of ${s.company.name}.` : `${s.name} is run by ${s.runBy.legalName} for the businesses it builds websites for.`}{' '}
        <a className={LINK} href={`https://${s.runBy.site}`}>
          {s.runBy.site}
        </a>
      </footer>
    </div>
  )
}

export function Landing({ s }: { s: ServiceWords }) {
  return (
    <Shell s={s}>
      <h1 className="text-2xl font-semibold leading-tight">Forms and agreements, signed on your phone</h1>
      <p className="text-base">
        {s.ownCompanyOnly ? (
          <>
            {s.name} is how {s.company.name} collects signed forms and agreements from its customers. <strong>If {s.company.name} sent you a link to sign, open that link from your email.</strong> This page is not where you sign, and there is nothing to sign in to here.
          </>
        ) : (
          <>
            {s.name} is how the businesses {s.runBy.name} builds websites for collect signed forms and agreements from their customers. <strong>If a business sent you a link to sign, open that link from your email.</strong> This page is not where you sign, and there is nothing to sign in to here.
          </>
        )}
      </p>
      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">What to expect</h2>
        <ol className="grid list-decimal gap-1.5 pl-5 text-sm">
          {s.ownCompanyOnly ? (
            <>
              <li>An email from “{s.company.name}”, sent from {s.sender}. Replying reaches {s.company.name}.</li>
              <li>{s.company.name}’s own page, with its name and logo. Before anything else it tells you how electronic signing works, how to ask for paper instead and how to say no.</li>
            </>
          ) : (
            <>
              <li>An email from “the business’s name {viaSuffix(s)}”, sent from {s.sender}. Replying reaches the business.</li>
              <li>The business’s own page, with its name and logo. Before anything else it tells you how electronic signing works, how to ask for paper instead and how to say no.</li>
            </>
          )}
          <li>You read the document, or answer its questions one at a time, then sign with your finger or a typed name.</li>
          <li>Everyone named on the document gets a finished PDF, sealed so that any later change shows.</li>
        </ol>
      </section>
      {s.ownCompanyOnly ? (
        <section className="grid gap-2">
          <h2 className="text-lg font-semibold">Who keeps the record</h2>
          <p className="text-sm">What you sign is between you and {s.company.name}. {s.company.name} keeps the record of who signed and when. You can ask {s.company.name} for anything about the document.</p>
        </section>
      ) : (
        <section className="grid gap-2">
          <h2 className="text-lg font-semibold">{s.runBy.name} is the service, not a party</h2>
          <p className="text-sm">What you sign is between you and the business that sent it. {s.runBy.name} runs the service and keeps the record of who signed and when. You can ask the business for anything about the document.</p>
        </section>
      )}
      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">Was that email really from us?</h2>
        <p className="text-sm">A real signing link starts with {location.origin}/s/. {s.name} never asks you for a payment or a password. If you were not expecting a document, do not open it; ask the business that is named in the email.</p>
      </section>
    </Shell>
  )
}

export function Privacy({ s }: { s: ServiceWords }) {
  const who = s.ownCompanyOnly ? s.company.name : s.runBy.name
  // Where the install's Forms sends only for its own company, the company is the sender and the runner: no sentence names a business apart from the people who run the service.
  const own = s.ownCompanyOnly === true
  const sections: { h: string; p: React.ReactNode }[] = [
    {
      h: 'Who this covers',
      p: own
        ? `You are reading this because ${who} sent you something to sign through ${s.name}, or you are curious about it. ${who} runs the service itself, decides what it asks and why, and keeps the record of who signed and when.`
        : `You are reading this because a business sent you something to sign through ${s.name}, or you are curious about it. ${s.runBy.legalName} runs the service for the businesses it builds websites for. The business that sent you the document decides what it asks and why; ${who} keeps the record for it.`,
    },
    {
      h: 'What is collected',
      p: 'Your name and email address as the business entered them; the answers you give, the files you upload and the signature you draw or type; and, at each step (opening the link, agreeing to sign electronically, signing, declining), the time, your IP address and your browser and device type. That record is what shows the document was signed by you and was not changed.',
    },
    {
      h: 'Who can see it',
      p: `${own ? `${who}, which sent the document, and the people named on it; the people at ${who} who run the service;` : `The business that sent the document and the people named on it; the ${who} people who run the service;`} and Cloudflare, which hosts the service, stores its records and files and delivers its email. A finished document is emailed to everyone named on it. ${who} does not sell your information, does not share it for advertising and does not use it for anything but running this service${own ? '' : ' for the business that sent you the document'}. Claude, an AI assistant, has no access today; see its section below.`,
    },
    {
      h: 'Claude, an AI assistant made by Anthropic',
      p: claudeNotice(s),
    },
    {
      h: 'The certificate in the finished document',
      p: 'The finished PDF ends with a certificate of completion. It lists each person’s name and email address, the time of each step they took and the IP address and device type it came from, how each signed (a typed name is printed as typed), the full text of the electronic-signing consent each person agreed to and the log of every event. Everyone named on the document gets the finished PDF, so every one of them can see all of it.',
    },
    {
      h: 'Private numbers',
      p: `A tax ID or Social Security number, and any other question a business marks private, is stored encrypted under a key that belongs to that one document. ${own ? `The people at ${who} who run the service` : `The ${who} people who run the service`} cannot see it unless one of them chooses to show it, and each showing is recorded. A finished document that holds one is not attached to an email: it goes to everyone by a private link that works for 90 days, and each download is recorded.`,
    },
    {
      h: 'How it is protected',
      p: 'Everything is sent over an encrypted connection. Your answers, files and the documents themselves are stored encrypted with a key that belongs to that one document, apart from the hosting provider’s own encryption. A finished document carries a digital seal, so a changed copy shows as changed.',
    },
    {
      h: 'Tracking and Do Not Track',
      p: `${s.name} does not track you across other websites or online services. It has no advertising, no analytics and no scripts from other sites; it sets no cookies on the pages you reach through your link, and the emails carry no tracking images. Because nothing here tracks you across sites, a Do Not Track signal from your browser changes nothing: it is treated the same as no signal.`,
    },
    {
      h: 'How long it is kept',
      p: 'A finished record is kept for the period the business has set, seven years unless it chose another, or longer if the law or a legal claim requires it. A document that was not finished (declined, cancelled, expired or abandoned) is deleted 90 days after it stops, unless the law or a legal claim requires it kept longer. When a record is deleted its key is deleted with it.',
    },
    {
      h: 'Changes to this notice',
      p: 'When this notice changes in a way that matters, the new version is posted on this page with a new “Last updated” date, and it applies from then on. A change does not alter the record of what you already signed.',
    },
    {
      h: 'Asking about your information',
      p: (
        <>
          {own ? (
            <>To see, correct or ask to delete what was collected about you, write to {who} at </>
          ) : (
            <>To see, correct or ask to delete what was collected about you, ask the business that sent you the document; it decides what it must keep. You can also write to {who} at </>
          )}
          <a className={LINK} href={`mailto:${s.contact}`}>
            {s.contact}
          </a>
          .
        </>
      ),
    },
  ]
  return (
    <Shell s={s}>
      <h1 className="text-2xl font-semibold leading-tight">Privacy notice</h1>
      <p className="text-xs text-muted-foreground">Last updated November 1, 2026.</p>
      {sections.map((x) => (
        <section key={x.h} className="grid gap-1.5">
          <h2 className="text-lg font-semibold">{x.h}</h2>
          <p className="text-sm">{x.p}</p>
        </section>
      ))}
    </Shell>
  )
}
