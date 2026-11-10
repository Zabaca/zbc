// The Knowledge tab: the organisation's one knowledge base, with the row of choices at the top. Which business is chosen is in the
// address (`/knowledge?business=northfield-works`, like the list's `?view=`), so it can be bookmarked and the back button undoes it; no choice is All. The base itself, its
// entries and every state of them are Knowledge.tsx; this is the page around it.
import type { Me } from '../me'
import { Knowledge } from './Knowledge'
import { knowledgeBusiness, knowledgePath } from './route'

type Go = (path: string) => void

export function KnowledgeTab({ me, search, go }: { me: Me; search: string; go: Go }) {
  const tab = me.tabs.find((t) => t.id === 'knowledge')
  const business = knowledgeBusiness(search)
  return (
    <section className="page knowledge" aria-labelledby="h-knowledge" data-testid="knowledge-tab">
      <h1 id="h-knowledge">Knowledge</h1>
      <Knowledge business={business} onPick={(id) => go(knowledgePath(tab?.path ?? '/knowledge', id))} />
    </section>
  )
}
