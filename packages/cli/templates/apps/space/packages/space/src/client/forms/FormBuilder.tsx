// The form builder: a form's roles, its questions of every type with required answers, private questions, conditions on
// earlier answers, and a phone-width preview that is the very screen a customer gets. The rules it applies (what is wrong with a
// definition) are src/forms/definition.ts, the same code the Worker checks with, so a problem shown here is a problem the save would refuse.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  FILE_KINDS,
  type FileKind,
  type FormDefinition,
  LIMITS,
  OP_LABELS,
  type Question,
  QUESTION_TYPES,
  type QuestionType,
  RULE_OPS,
  type Rule,
  TYPE_LABELS,
  type UploadRef,
  answerable,
  addQuestion,
  readDefinition,
} from '@space/forms/src/forms/definition'
import { FormRunner } from '@space/forms/src/public/FormRunner'
import { useInstall } from '../install'
import { api } from './api'
import { formsApi } from './formsApi'
import { Badge, Button, Card, INPUT, Notice, cn, useLoad, when } from './kit'
import { href } from './route'

const SMALL = 'min-h-9 rounded-md border border-input bg-card px-2 text-sm'

/** A question of a type, with only what that type uses. */
function fresh(id: string, type: QuestionType): Question {
  const q: Question = { id, type, label: '', required: type !== 'statement', sensitive: type === 'tin' }
  if (type === 'choice' || type === 'multi' || type === 'dropdown') q.options = ['Option 1', 'Option 2']
  if (type === 'file') q.fileKinds = [...FILE_KINDS]
  if (type === 'statement' || type === 'agreement') q.text = ''
  if (type === 'agreement') q.label = 'Agreement'
  return q
}

/** Drops what a question's new type does not use. */
function retype(q: Question, type: QuestionType): Question {
  const next: Question = { id: q.id, type, label: q.label, required: type === 'statement' ? false : type === 'agreement' ? true : q.required, sensitive: type === 'tin' ? true : q.sensitive }
  if (q.help) next.help = q.help
  if (q.show) next.show = q.show
  if (type === 'choice' || type === 'multi' || type === 'dropdown') next.options = q.options ?? ['Option 1', 'Option 2']
  if (type === 'file') next.fileKinds = q.fileKinds ?? [...FILE_KINDS]
  if (type === 'statement' || type === 'agreement') next.text = q.text ?? ''
  if (type === 'short' || type === 'long' || type === 'email' || type === 'phone' || type === 'number' || type === 'tin') next.placeholder = q.placeholder
  return next
}

function ConditionEditor({ q, before, onChange }: { q: Question; before: Question[]; onChange: (show: Question['show']) => void }) {
  const targets = before.filter(answerable)
  const cond = q.show
  if (!cond)
    return (
      <div>
        <Button kind="quiet" type="button" disabled={targets.length === 0} onClick={() => onChange({ match: 'all', rules: [{ question: targets[0]!.id, op: 'answered' }] })}>
          Only show this question in some cases
        </Button>
        {targets.length === 0 ? <p className="mt-1 text-xs text-muted-foreground">A condition looks at an earlier question, and there is none before this one.</p> : null}
      </div>
    )
  const setRule = (i: number, patch: Partial<Rule>) => onChange({ ...cond, rules: cond.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  return (
    <div className="grid gap-2 rounded-md border border-border bg-muted p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        Show this question when
        <select className={SMALL} aria-label="All or any" value={cond.match} onChange={(e) => onChange({ ...cond, match: e.target.value as 'all' | 'any' })}>
          <option value="all">all of these hold</option>
          <option value="any">any of these holds</option>
        </select>
      </div>
      {cond.rules.map((r, i) => {
        const target = targets.find((t) => t.id === r.question)
        const ops = RULE_OPS.filter((op) => (op === 'gt' || op === 'lt' ? target?.type === 'number' || target?.type === 'date' : op === 'contains' ? target?.type === 'short' || target?.type === 'long' || target?.type === 'multi' : true))
        return (
          <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
            <select className={SMALL} aria-label={`Condition ${i + 1}: question`} value={r.question} onChange={(e) => setRule(i, { question: e.target.value, op: 'answered', value: undefined })}>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label || t.text?.slice(0, 40) || t.id}
                </option>
              ))}
            </select>
            <select className={SMALL} aria-label={`Condition ${i + 1}: test`} value={r.op} onChange={(e) => setRule(i, { op: e.target.value as Rule['op'], value: e.target.value === 'answered' ? undefined : (r.value ?? '') })}>
              {ops.map((op) => (
                <option key={op} value={op}>
                  {OP_LABELS[op]}
                </option>
              ))}
            </select>
            {r.op === 'answered' ? null : target?.type === 'yesno' ? (
              <select className={SMALL} aria-label={`Condition ${i + 1}: value`} value={r.value ?? 'yes'} onChange={(e) => setRule(i, { value: e.target.value })}>
                <option value="yes">yes</option>
                <option value="no">no</option>
              </select>
            ) : target?.options ? (
              <select className={SMALL} aria-label={`Condition ${i + 1}: value`} value={r.value ?? ''} onChange={(e) => setRule(i, { value: e.target.value })}>
                <option value="">Choose…</option>
                {target.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            ) : (
              <input className={cn(SMALL, 'w-40')} aria-label={`Condition ${i + 1}: value`} type={target?.type === 'date' ? 'date' : 'text'} value={r.value ?? ''} onChange={(e) => setRule(i, { value: e.target.value })} />
            )}
            <Button kind="quiet" type="button" aria-label={`Remove condition ${i + 1}`} onClick={() => onChange(cond.rules.length === 1 ? undefined : { ...cond, rules: cond.rules.filter((_, j) => j !== i) })}>
              Remove
            </Button>
          </div>
        )
      })}
      <div className="flex flex-wrap gap-2">
        <Button kind="quiet" type="button" onClick={() => onChange({ ...cond, rules: [...cond.rules, { question: targets[0]!.id, op: 'answered' }] })}>
          Add a condition
        </Button>
        <Button kind="quiet" type="button" onClick={() => onChange(undefined)}>
          Always show it
        </Button>
      </div>
    </div>
  )
}

function QuestionEditor({ q, index, all, onChange, onMove, onDelete }: { q: Question; index: number; all: Question[]; onChange: (q: Question) => void; onMove: (by: -1 | 1) => void; onDelete: () => void }) {
  const set = (patch: Partial<Question>) => onChange({ ...q, ...patch })
  const display = q.type === 'statement' || q.type === 'agreement'
  const n = `Question ${index + 1}`
  return (
    <li className="grid gap-3 rounded-lg border border-border bg-card p-3" aria-label={n}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{index + 1}.</span>
        <select className={SMALL} aria-label={`${n}: type`} value={q.type} onChange={(e) => onChange(retype(q, e.target.value as QuestionType))}>
          {QUESTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <span className="ml-auto flex gap-1">
          <Button kind="quiet" type="button" aria-label={`Move ${n} up`} disabled={index === 0} onClick={() => onMove(-1)}>
            Up
          </Button>
          <Button kind="quiet" type="button" aria-label={`Move ${n} down`} disabled={index === all.length - 1} onClick={() => onMove(1)}>
            Down
          </Button>
          <Button kind="quiet" type="button" aria-label={`Delete ${n}`} onClick={onDelete}>
            Delete
          </Button>
        </span>
      </div>
      <label className="grid gap-1 text-sm font-medium">
        {q.type === 'statement' ? 'Heading (optional)' : q.type === 'agreement' ? 'Heading' : 'The question'}
        <input className={INPUT} aria-label={`${n}: the question`} maxLength={LIMITS.maxLabel} value={q.label} onChange={(e) => set({ label: e.target.value })} />
      </label>
      {display ? (
        <label className="grid gap-1 text-sm font-medium">
          {q.type === 'agreement' ? 'The agreement, word for word' : 'The text'}
          <textarea className={`${INPUT} min-h-32 py-2`} aria-label={`${n}: text`} maxLength={LIMITS.maxText} value={q.text ?? ''} onChange={(e) => set({ text: e.target.value })} />
          {q.type === 'agreement' ? <span className="text-xs font-normal text-muted-foreground">It is printed in the document exactly as written, and the signer must check "I agree".</span> : null}
        </label>
      ) : null}
      {q.options ? (
        <label className="grid gap-1 text-sm font-medium">
          Options, one per line
          <textarea className={`${INPUT} min-h-24 py-2`} aria-label={`${n}: options`} value={q.options.join('\n')} onChange={(e) => set({ options: e.target.value.split('\n') })} />
        </label>
      ) : null}
      {!display ? (
        <label className="grid gap-1 text-sm font-medium">
          Help text (optional)
          <input className={INPUT} aria-label={`${n}: help`} maxLength={500} value={q.help ?? ''} onChange={(e) => set({ help: e.target.value || undefined })} />
        </label>
      ) : null}
      {q.type === 'short' || q.type === 'long' || q.type === 'number' ? (
        <div className="flex flex-wrap gap-3 text-sm">
          <label className="grid gap-1 font-medium">
            {q.type === 'number' ? 'Smallest' : 'Fewest characters'}
            <input className={cn(SMALL, 'w-28')} type="number" aria-label={`${n}: minimum`} value={q.min ?? ''} onChange={(e) => set({ min: e.target.value === '' ? undefined : Number(e.target.value) })} />
          </label>
          <label className="grid gap-1 font-medium">
            {q.type === 'number' ? 'Largest' : 'Most characters'}
            <input className={cn(SMALL, 'w-28')} type="number" aria-label={`${n}: maximum`} value={q.max ?? ''} onChange={(e) => set({ max: e.target.value === '' ? undefined : Number(e.target.value) })} />
          </label>
        </div>
      ) : null}
      {q.type === 'file' ? (
        <div className="flex flex-wrap items-end gap-4 text-sm">
          <fieldset className="flex flex-wrap gap-3">
            <legend className="mb-1 font-medium">Allowed files</legend>
            {FILE_KINDS.map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={(q.fileKinds ?? []).includes(k)}
                  onChange={(e) => set({ fileKinds: e.target.checked ? [...(q.fileKinds ?? []), k as FileKind] : (q.fileKinds ?? []).filter((x) => x !== k) })}
                />
                {k.toUpperCase()}
              </label>
            ))}
          </fieldset>
          <label className="grid gap-1 font-medium">
            Most files
            <input className={cn(SMALL, 'w-24')} type="number" min={1} max={LIMITS.filesPerEnvelope} aria-label={`${n}: most files`} value={q.max ?? ''} placeholder="10" onChange={(e) => set({ max: e.target.value === '' ? undefined : Number(e.target.value) })} />
          </label>
        </div>
      ) : null}
      {!display ? (
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={q.required} onChange={(e) => set({ required: e.target.checked })} /> Required
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={q.sensitive} disabled={q.type === 'tin'} onChange={(e) => set({ sensitive: e.target.checked })} />
            <span>
              Private information
              <span className="block text-xs text-muted-foreground">{q.type === 'tin' ? 'A tax ID number is always private.' : 'Hidden in the admin until revealed, and the finished document goes by private link, not attachment.'}</span>
            </span>
          </label>
        </div>
      ) : null}
      <ConditionEditor q={q} before={all.slice(0, index)} onChange={(show) => set({ show })} />
    </li>
  )
}

function RolesEditor({ def, onChange }: { def: FormDefinition; onChange: (d: FormDefinition) => void }) {
  const setRole = (i: number, patch: Partial<FormDefinition['roles'][number]>) => onChange({ ...def, roles: def.roles.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">Who signs, in order. The first is the person who answers the questions. Each gets a signature, a date and their printed name on the signature page, and any lines of their own you add (a preparer's PTIN, say).</p>
      <ol className="grid gap-3">
        {def.roles.map((r, i) => (
          <li key={i} className="grid gap-2 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{i + 1}.</span>
              <input className={cn(INPUT, 'max-w-xs')} aria-label={`Signer ${i + 1}'s role`} maxLength={40} value={r.name} onChange={(e) => setRole(i, { name: e.target.value })} />
              {i === 0 ? <span className="text-xs text-muted-foreground">answers the questions</span> : null}
              {def.roles.length > 1 ? (
                <Button kind="quiet" type="button" aria-label={`Remove role ${i + 1}`} onClick={() => onChange({ ...def, roles: def.roles.filter((_, j) => j !== i) })}>
                  Remove
                </Button>
              ) : null}
            </div>
            {r.fields.map((f, k) => (
              <div key={k} className="flex flex-wrap items-center gap-2 pl-6 text-sm">
                <input className={cn(INPUT, 'max-w-xs')} aria-label={`Role ${i + 1}, line ${k + 1}`} placeholder="Label, for example PTIN" maxLength={60} value={f.label} onChange={(e) => setRole(i, { fields: r.fields.map((x, j) => (j === k ? { ...x, label: e.target.value } : x)) })} />
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={f.required} onChange={(e) => setRole(i, { fields: r.fields.map((x, j) => (j === k ? { ...x, required: e.target.checked } : x)) })} /> Required
                </label>
                <Button kind="quiet" type="button" aria-label={`Remove role ${i + 1}, line ${k + 1}`} onClick={() => setRole(i, { fields: r.fields.filter((_, j) => j !== k) })}>
                  Remove
                </Button>
              </div>
            ))}
            {r.fields.length < LIMITS.maxRoleFields ? (
              <div className="pl-6">
                <Button kind="quiet" type="button" onClick={() => setRole(i, { fields: [...r.fields, { label: '', required: true }] })}>
                  Add a line for {r.name || 'this signer'} to fill
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {def.roles.length < LIMITS.maxRoles ? (
        <div>
          <Button kind="quiet" type="button" onClick={() => onChange({ ...def, roles: [...def.roles, { name: def.roles.length === 1 ? 'CPA' : `Signer ${def.roles.length + 1}`, fields: [] }] })}>
            Add a signer after them
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function FormBuilder({ id }: { id: string }) {
  const { forms } = useInstall()
  const detail = useLoad(() => formsApi.form(id), [id])
  const client = useLoad(async () => (detail.data ? api.client(detail.data.form.client_id) : null), [detail.data?.form.client_id])
  const [def, setDef] = useState<FormDefinition | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [adding, setAdding] = useState<QuestionType>('short')
  const [previewRun, setPreviewRun] = useState(0)
  const [confirming, setConfirming] = useState(false)
  // The preview keeps its "uploads" here, since nothing is sent anywhere.
  const previewFiles = useRef<Record<string, UploadRef[]>>({})
  const working = detail.data?.working

  // Take the saved definition in when a different one loads (first load, or after a save or publish).
  useEffect(() => {
    if (working) {
      setDef(working.definition)
      setDirty(false)
    }
  }, [working?.versionId, working?.published, working?.definition])

  const check = useMemo(() => (def ? readDefinition(def) : null), [def])
  const publishCheck = useMemo(() => (def ? readDefinition(def, { publish: true }) : null), [def])
  if (detail.error) return <Notice kind="error">{detail.error}</Notice>
  if (!detail.data || !working || !def || !check || !publishCheck) return <p className="text-sm text-muted-foreground">Loading…</p>

  const edit = (next: FormDefinition) => {
    setDef(next)
    setDirty(true)
    setOk(null)
  }
  const setQuestion = (i: number, q: Question) => edit({ ...def, questions: def.questions.map((x, j) => (j === i ? q : x)) })
  const move = (i: number, by: -1 | 1) => {
    const qs = [...def.questions]
    const [q] = qs.splice(i, 1)
    qs.splice(i + by, 0, q!)
    edit({ ...def, questions: qs })
  }
  const remove = (i: number) => {
    const gone = def.questions[i]!.id
    // A condition on a deleted question has nothing to look at: drop the rule, and the condition with its last rule.
    edit({
      ...def,
      questions: def.questions
        .filter((_, j) => j !== i)
        .map((q) => {
          if (!q.show) return q
          const rules = q.show.rules.filter((r) => r.question !== gone)
          return { ...q, show: rules.length > 0 ? { ...q.show, rules } : undefined }
        }),
    })
  }

  async function run(what: () => Promise<unknown>, done: string) {
    setBusy(true)
    setError(null)
    setOk(null)
    try {
      await what()
      await detail.reload()
      setOk(done)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }
  const save = () => run(() => formsApi.saveDraft(id, def), working.published ? `Saved as a draft of version ${working.version + 1}. Version ${working.version} is untouched.` : 'Draft saved.')
  const publishNow = () =>
    run(async () => {
      if (dirty || working.published) await formsApi.saveDraft(id, def)
      await formsApi.publish(id)
    }, 'Published. A send uses this version from now on; versions already sent keep theirs.')

  const frozen = working.published
  const title = detail.data.form.title
  return (
    <>
      <div>
        <a href={href('/forms')} className="text-sm text-muted-foreground underline">
          Forms
        </a>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{title}</h1>
          <Badge status={frozen ? 'completed' : 'draft'} />
          <span className="text-xs text-muted-foreground">
            version {working.version} {frozen ? 'published' : 'draft'}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{detail.data.form.client_name}</p>
      </div>
      {frozen ? <Notice kind="info">Version {working.version} is published and never changes. Edit below and save to start version {working.version + 1}; anything already sent stays on the version it was sent with.</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      {check.problems.length > 0 ? (
        <Notice kind="warn">
          <p className="font-medium">To fix before this can be saved:</p>
          <ul className="list-disc pl-5">
            {check.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="grid min-w-0 content-start gap-4">
          <Card title="The form">
            <label className="mb-4 grid max-w-xl gap-1 text-sm font-medium">
              Title
              <input className={INPUT} maxLength={120} value={def.title} onChange={(e) => edit({ ...def, title: e.target.value })} />
              <span className="text-xs font-normal text-muted-foreground">The heading of the document, and the default title of a send.</span>
            </label>
            <RolesEditor def={def} onChange={edit} />
          </Card>

          <Card title={`Questions (${def.questions.length})`}>
            {def.questions.length === 0 ? <p className="mb-3 text-sm text-muted-foreground">No questions yet. Add the first below.</p> : null}
            <ol className="grid gap-3">
              {def.questions.map((q, i) => (
                <QuestionEditor key={q.id} q={q} index={i} all={def.questions} onChange={(next) => setQuestion(i, next)} onMove={(by) => move(i, by)} onDelete={() => remove(i)} />
              ))}
            </ol>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select className={SMALL} aria-label="Type of the next question" value={adding} onChange={(e) => setAdding(e.target.value as QuestionType)}>
                {QUESTION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
              <Button type="button" disabled={def.questions.length >= LIMITS.maxQuestions} onClick={() => edit(addQuestion(def, (id) => fresh(id, adding)))}>
                Add a question
              </Button>
            </div>
          </Card>

          <Card title="Save and publish">
            <p className="mb-3 text-sm">
              Saving keeps a draft you can come back to. Publishing makes it a version that can be sent, and locks that version: a change after that is a new version.
            </p>
            {!frozen && publishCheck.problems.length > check.problems.length ? (
              <ul className="mb-3 list-disc pl-5 text-sm">
                {publishCheck.problems.filter((p) => !check.problems.includes(p)).map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" disabled={busy || check.problems.length > 0 || !dirty} onClick={() => void save()}>
                {busy ? 'Saving…' : frozen ? `Save as version ${working.version + 1} (draft)` : 'Save draft'}
              </Button>
              {confirming ? (
                <>
                  <Button type="button" disabled={busy} onClick={() => void publishNow()}>
                    Yes, publish it
                  </Button>
                  <Button kind="quiet" type="button" onClick={() => setConfirming(false)}>
                    Not yet
                  </Button>
                </>
              ) : (
                <Button kind="quiet" type="button" disabled={busy || publishCheck.problems.length > 0 || (frozen && !dirty)} onClick={() => setConfirming(true)}>
                  Publish
                </Button>
              )}
              {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
            </div>
          </Card>

          <Card title="Versions">
            <ul className="divide-y divide-border text-sm">
              {detail.data.versions.map((v) => (
                <li key={v.id} className="grid gap-0.5 py-2 sm:grid-cols-[8rem_1fr] sm:gap-3">
                  <span className="font-medium">Version {v.version}</span>
                  <span className="min-w-0 break-words text-muted-foreground">
                    {v.published_at ? `Published ${when(v.published_at)}. Fingerprint ${v.definition_hash.slice(0, 16)}…` : `Draft, started ${when(v.created_at)}`}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <aside className="min-w-0 content-start lg:sticky lg:top-4 lg:self-start" aria-label="Preview">
          <Card
            title="Preview"
            aside={
              <Button kind="quiet" type="button" onClick={() => (void (previewFiles.current = {}), setPreviewRun((n) => n + 1))}>
                Start over
              </Button>
            }
          >
            <p className="mb-2 text-xs text-muted-foreground">What a customer sees on a phone. Nothing here is saved or sent.</p>
            {check.problems.length > 0 ? (
              <p className="text-sm text-muted-foreground">Fix the problems above to preview.</p>
            ) : def.questions.length === 0 ? (
              <p className="text-sm text-muted-foreground">Add a question to preview.</p>
            ) : (
              <div className="mx-auto w-full max-w-[390px] overflow-hidden rounded-2xl border border-border bg-neutral-100 text-neutral-900" style={{ ['--accent' as string]: client.data?.accent_color ?? '#1f4e79' }}>
                <div className="px-3 py-2 text-sm font-semibold text-white" style={{ backgroundColor: 'var(--accent)' }}>
                  {client.data?.display_name ?? 'Client'}{forms.ownCompanyOnly ? null : (
                    <>
                      {' '}
                      <span className="text-xs font-normal opacity-90">via {forms.service}</span>
                    </>
                  )}
                </div>
                <div className="p-3">
                  <FormRunner
                    key={previewRun}
                    definition={check.def}
                    initial={{}}
                    onSave={async () => undefined}
                    onUpload={async (q, file) => (previewFiles.current[q.id] = [...(previewFiles.current[q.id] ?? []), { id: `${q.id}-${file.name}-${Date.now()}`, name: file.name, size: file.size }])}
                    onRemove={async (q, file) => (previewFiles.current[q.id] = (previewFiles.current[q.id] ?? []).filter((f) => f.id !== file.id))}
                    onDone={async () => {
                      throw new Error('That is the end of the preview. A customer would now see the document made from these answers.')
                    }}
                    doneLabel="See my document"
                  />
                </div>
              </div>
            )}
          </Card>
        </aside>
      </div>
    </>
  )
}
