// Send's picker for "A form": the client's published forms. Choosing one pins the send to that exact version, tells Send
// whether it asks for private information (so the finished document goes by link), and says who the form needs to be sent to.
import { useEffect, useState } from 'react'
import { formsApi } from './formsApi'
import { INPUT, Notice, useLoad } from './kit'
import { href } from './route'
import type { PickerValue } from './sendSources'

export function FormPicker({ clientId, onChange }: { clientId: string; onChange: (v: PickerValue) => void }) {
  const forms = useLoad(() => (clientId ? formsApi.forms(clientId) : Promise.resolve([])), [clientId])
  const [chosen, setChosen] = useState('')
  const sendable = (forms.data ?? []).filter((f) => f.published)
  const form = sendable.find((f) => f.id === chosen)

  useEffect(() => {
    setChosen('')
  }, [clientId])
  useEffect(() => {
    onChange(form?.published ? { source: { form_version_id: form.published.id }, sensitive: form.published.sensitive, ready: true } : { ready: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form?.published?.id])

  if (forms.error) return <Notice kind="error">{forms.error}</Notice>
  if (forms.data && sendable.length === 0)
    return (
      <Notice kind="info">
        This client has no published form. <a className="underline" href={href('/forms')}>Build one under Forms</a>, publish it, then come back.
      </Notice>
    )
  return (
    <div className="ml-6 grid gap-2">
      <label className="grid gap-1 text-sm font-medium" htmlFor="form-pick">
        Which form
        <select id="form-pick" className={INPUT} value={chosen} onChange={(e) => setChosen(e.target.value)}>
          <option value="">Choose a form…</option>
          {sendable.map((f) => (
            <option key={f.id} value={f.id}>
              {f.title} (version {f.published!.version})
            </option>
          ))}
        </select>
      </label>
      {form?.published ? (
        <p className="text-xs text-muted-foreground">
          {form.published.questions} questions. Signers, in order: {form.published.roles.join(', then ')}. Name {form.published.roles.length === 1 ? 'one signer' : `${form.published.roles.length} signers`} below and set their Role to {form.published.roles.map((r) => `"${r}"`).join(', then ')}; the first answers the questions, and the rest sign the document made from their answers.
          {form.published.sensitive ? ' It asks for private information, so the finished document will go to everyone by a private link.' : ''}
          {form.draft ? ` A newer draft (version ${form.draft.version}) is not sent until it is published.` : ''}
        </p>
      ) : null}
    </div>
  )
}
