import { useState } from 'react'
import { type SealCheckReport, type StorageCheck, api } from './api'
import { useInstall } from '../install'
import { useOwner } from '../owner'
import { Button, Card, Notice, bytes, useLoad, when } from './kit'

function Fingerprint({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-all font-mono text-xs">{value}</dd>
    </div>
  )
}

function Status() {
  const { forms } = useInstall()
  const owner = useOwner()
  const { data, error } = useLoad(() => api.seal(), [])
  if (error) return <Notice kind="error">{error}</Notice>
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (!data.configured) return <Notice kind="warn">The seal is not configured here. {data.reason}</Notice>
  return (
    <div className="grid gap-3">
      {data.daysLeft < 90 ? <Notice kind="warn">The seal certificate ends in {data.daysLeft} days. Renew it: bun packages/forms/scripts/seal-certs.ts --renew, then apply the instance.</Notice> : null}
      <dl className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-0.5">
          <dt className="text-xs text-muted-foreground">Sealed by</dt>
          <dd className="text-sm">{data.subject}</dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-xs text-muted-foreground">Certificate valid until</dt>
          <dd className="text-sm">
            {when(data.notAfter)} ({data.daysLeft} days)
          </dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-xs text-muted-foreground">Seal level</dt>
          <dd className="text-sm">{data.level === 'B-B' ? 'Basic (PAdES B-B), no timestamp yet' : 'With a timestamp (PAdES B-T)'}</dd>
        </div>
        <Fingerprint label="Root fingerprint (SHA-256), printed on every certificate of completion" value={data.rootFingerprint} />
        <Fingerprint label="Seal certificate fingerprint (SHA-256)" value={data.certFingerprint} />
      </dl>
      <p className="text-xs text-muted-foreground">Adobe shows this seal's validity as unknown, because the root is {forms.runBy}'s own and on no trust list. It does show whether the document changed after sealing. A trusted certificate and a timestamp are a purchase, and {owner.name}'s call.</p>
    </div>
  )
}

function SealCheck() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<SealCheckReport | null>(null)
  async function run() {
    setBusy(true)
    setError(null)
    setReport(null)
    try {
      setReport(await api.sealCheck())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Seal check">
      <p className="mb-3 text-sm">Builds the largest scan the service accepts (about 19 MB), then inspects, flattens, stamps, appends a page, attaches a file and seals it, all in this Worker. After the first deploy, run it once and read the CPU time from Workers Logs: that is the figure the spike could only estimate. A failure here, not at a client's expense, is how a limit shows.</p>
      <Button onClick={run} disabled={busy}>
        {busy ? 'Running…' : 'Run the seal check'}
      </Button>
      {error ? (
        <div className="mt-3">
          <Notice kind="error">{error}</Notice>
        </div>
      ) : null}
      {report ? (
        <div className="mt-3 grid gap-2">
          <Notice kind="ok">
            Sealed a {bytes(report.input.bytes)} file of {report.inspection.pageCount} pages ({report.inspection.scannedPages.length} scanned) into {bytes(report.outputBytes)}, as {report.seal.subject} at level {report.seal.level}.
          </Notice>
          <p className="break-all font-mono text-xs text-muted-foreground">SHA-256 {report.outputSha256}</p>
        </div>
      ) : null}
    </Card>
  )
}

function StorageCheckCard() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<StorageCheck | null>(null)
  async function run() {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      setResult(await api.storageCheck())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const ok = result && result.roundTrip && result.refusedWithoutKey === true && result.refusedWithAnotherKey === true
  return (
    <Card title="Storage check">
      <p className="mb-3 text-sm">Stores a throwaway object under a fresh data key, reads it back with the key, and confirms the bucket refuses it without the key and with another. Every file the service keeps is stored this way, so a copy of the bucket reads nothing.</p>
      <Button onClick={run} disabled={busy}>
        {busy ? 'Running…' : 'Run the storage check'}
      </Button>
      {error ? (
        <div className="mt-3">
          <Notice kind="error">{error}</Notice>
        </div>
      ) : null}
      {result ? (
        <div className="mt-3">
          <Notice kind={ok ? 'ok' : 'error'}>
            {ok ? 'The bucket keeps files only under their key.' : 'The bucket did not behave as expected: '}
            {ok ? '' : `read back ${String(result.roundTrip)}, refused without the key ${String(result.refusedWithoutKey)}, refused with another key ${String(result.refusedWithAnotherKey)}. Do not send anything until this passes.`}
          </Notice>
        </div>
      ) : null}
    </Card>
  )
}

export function Seal() {
  return (
    <>
      <h1 className="text-xl font-semibold">Seal</h1>
      <Card title="The seal on every finished document">
        <Status />
      </Card>
      <SealCheck />
      <StorageCheckCard />
    </>
  )
}
