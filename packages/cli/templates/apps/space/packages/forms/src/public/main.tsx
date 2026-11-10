import { StrictMode, Suspense, lazy, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import type { ServiceWords } from '../service'
import { Landing, Privacy } from './service-pages'
import { fetchService } from './api'

// The public entry: what the signing service is and a privacy notice, for a stranger who reaches the signer's address (the space's `/s/`) without a link, and the
// signer's page behind /s/<token> (src/public/Signer.tsx). It is a separate entry from the admin, so a signer's page
// carries none of the admin's code. Every name on these pages (the service, who runs it, where its mail comes from, who to write to, who tells Claude what to do) is the install's
// and comes from the one public call that names them (`fetchService`); the sentences (src/public/service-pages.tsx) are the same in every install except where it says its Forms sends only for its own company.

/** The landing page or the privacy notice, once the service has named itself; a service that cannot be read is said plainly and not guessed at. */
function Public({ privacy }: { privacy: boolean }) {
  const [s, setS] = useState<ServiceWords | null | undefined>(undefined)
  useEffect(() => {
    void fetchService().then(setS)
  }, [])
  useEffect(() => {
    document.title = s ? (privacy ? `Privacy notice · ${s.name}` : s.name) : 'Forms'
  }, [s, privacy])
  if (s === undefined) return <p className="p-6 text-sm">One moment…</p>
  if (s === null) return <p className="p-6 text-sm">This page could not be loaded. Try again in a moment.</p>
  return privacy ? <Privacy s={s} /> : <Landing s={s} />
}

const path = location.pathname.replace(/\/+$/, '')
// The signer's page is its own chunk: the landing page and the privacy notice do not load pdf.js.
const Signer = lazy(() => import('./Signer').then((m) => ({ default: m.Signer })))
// A recipient's private link: /s/<256-bit token>. Its page loads nothing from any other site and sends no referrer.
const link = /^\/s\/([A-Za-z0-9_-]{43})$/.exec(path)
createRoot(document.getElementById('root')!).render(<StrictMode>{link ? (
      <Suspense fallback={<p className="p-6 text-sm">One moment…</p>}>
        <Signer token={link[1]!} />
      </Suspense>
    ) : <Public privacy={path === '/privacy'} />}</StrictMode>)
