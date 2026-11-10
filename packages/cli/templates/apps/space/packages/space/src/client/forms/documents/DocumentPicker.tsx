// What Send draws under "A client's PDF": which of the client's uploaded documents to send, and for how many signers it was set up.
// Reports `ready` once one with fields is chosen; the rest of `source` is its id (src/documents/source.ts).
import { useEffect, useState } from 'react'
import { INPUT, Notice, useLoad } from '../kit'
import type { PickerValue } from '../sendSources'
import { href } from '../route'
import { documents } from './api'

export function DocumentPicker({ clientId, onChange }: { clientId: string; onChange: (v: PickerValue) => void }) {
  const list = useLoad(() => (clientId ? documents.list(clientId) : Promise.resolve(null)), [clientId])
  const [id, setId] = useState('')
  const all = list.data?.documents ?? []
  const doc = all.find((d) => d.id === id) ?? null

  useEffect(() => {
    onChange(doc && doc.fields_placed > 0 ? { source: { documentId: doc.id }, ready: true } : { ready: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id, doc?.fields_placed])

  if (list.error) return <Notice kind="error">{list.error}</Notice>
  if (list.data && all.length === 0) {
    return (
      <Notice kind="info">
        This client has no documents yet. <a className="underline" href={href('/documents')}>Upload one and place its fields</a>, then come back.
      </Notice>
    )
  }
  return (
    <div className="grid gap-2 pl-6">
      <label className="grid gap-1 text-sm font-medium">
        Which document
        <select className={INPUT} value={id} onChange={(e) => setId(e.target.value)} aria-label="Which document">
          <option value="">Choose a document…</option>
          {all.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.page_count} page{d.page_count === 1 ? '' : 's'})
            </option>
          ))}
        </select>
      </label>
      {doc && doc.fields_placed === 0 ? (
        <Notice kind="warn">
          {doc.name} has no fields yet. <a className="underline" href={href(`/documents/${doc.id}`)}>Place them first</a>.
        </Notice>
      ) : null}
      {doc && doc.fields_placed > 0 ? (
        <p className="text-xs text-muted-foreground">
          Fields are placed for {doc.signers.length === 1 ? 'one signer' : `${doc.signers.length} signers`}: name exactly {doc.signers.length === 1 ? 'one' : doc.signers.length} under Who signs, in the order the fields were numbered. <a className="underline" href={href(`/documents/${doc.id}`)}>Change the fields</a>
        </p>
      ) : null}
    </div>
  )
}
