// The guests' sign-in: an address, then the 6-digit code meet emails to it. No password, no link to click (the
// email carries a code only, because mail scanners follow links and would spend them), and the page says the same
// thing whether or not the address was invited, so it tells a stranger nothing about who is.

import { type FormEvent, useState } from 'react'
import { ApiError } from '../api'
import { SPACE_MEET_PATH, peopleOf, useSite } from '../site'
import { Wordmark } from '../ui'
import { guestAuth } from './api'

export default function GuestSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const site = useSite()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'address' | 'code'>('address')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function ask(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await guestAuth.request(email.trim())
      setStep('code')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send a code.')
    } finally {
      setBusy(false)
    }
  }

  async function enter(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await guestAuth.verify(email.trim(), code)
      onSignedIn()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That code did not work.')
      setBusy(false)
    }
  }

  return (
    <main className="page page-center" data-testid="guest-signin">
      <Wordmark />
      <h1 className="title title-sm">Sign in to your channels</h1>
      {step === 'address' ? (
        <form className="card ws-signin" onSubmit={(e) => void ask(e)}>
          <p className="card-label">Enter the email address you were invited at. meet sends you a 6-digit code.</p>
          <label className="field">
            Email address
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              autoFocus
              placeholder="you@example.com"
              data-testid="signin-email"
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || email.trim() === ''} data-testid="signin-ask">
            {busy ? 'Sending' : 'Email me a code'}
          </button>
          {error && (
            <p className="notice notice-error" role="alert">
              {error}
            </p>
          )}
          <p className="fine">
            {peopleOf(site)} work in <a href={SPACE_MEET_PATH}>the space</a> instead. Calls need no sign-in: open the link you were sent.
          </p>
        </form>
      ) : (
        <form className="card ws-signin" onSubmit={(e) => void enter(e)}>
          <p className="card-label" data-testid="signin-sent">
            If {email.trim()} was invited, a code is on its way. It works once and stops working after 10 minutes.
          </p>
          <label className="field">
            6-digit code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              autoFocus
              placeholder="123456"
              data-testid="signin-code"
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || code.replace(/\s/g, '').length < 6} data-testid="signin-enter">
            {busy ? 'Checking' : 'Sign in'}
          </button>
          {error && (
            <p className="notice notice-error" role="alert" data-testid="signin-error">
              {error}
            </p>
          )}
          <button type="button" className="ws-link-btn" onClick={() => (setStep('address'), setCode(''), setError(null))}>
            Use a different address or ask again
          </button>
        </form>
      )}
    </main>
  )
}
