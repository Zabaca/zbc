// A document's placement screen. Loaded on demand: it carries pdf.js, which the admin's other screens do not need.
import { Suspense, lazy } from 'react'

const Placement = lazy(() => import('./Placement'))

export function DocumentPage({ id }: { id: string }) {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
      <Placement id={id} />
    </Suspense>
  )
}
