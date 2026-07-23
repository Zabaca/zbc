/**
 * The Secret Request page: fetches channel meta, shows the pairing code
 * (derived from the URL fragment — the channel public key the server never
 * sees), and encrypts submitted values in-browser before POSTing.
 *
 * The inline script mirrors the ECDH P-256 + AES-GCM suite and pairing-code
 * derivation in crypto.ts; if you change one, change both.
 */
export function requestPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Secret Request</title>
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
  .code { font-size: 2rem; font-family: ui-monospace, monospace; letter-spacing: .1em; }
  label { display: block; margin-top: 1rem; font-weight: 600; }
  input { width: 100%; padding: .5rem; font-family: ui-monospace, monospace; }
  textarea { width: 100%; min-height: 20rem; padding: .5rem; font-family: ui-monospace, monospace; white-space: pre; }
  button { margin-top: 1.5rem; padding: .6rem 1.4rem; font-size: 1rem; cursor: pointer; }
  .muted { opacity: .7; }
  #status { margin-top: 1rem; font-weight: 600; }
</style>
</head>
<body>
<h1>Secret Request</h1>
<p>Pairing code — confirm it matches your terminal before pasting anything:</p>
<p class="code" id="pairing">…</p>
<p class="muted" id="context"></p>
<form id="form" hidden>
  <div id="fields"></div>
  <button type="submit">Submit securely</button>
</form>
<p id="status"></p>
<script>
const b64u = {
  to(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
  },
  from(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  },
}
const ECDH = { name: 'ECDH', namedCurve: 'P-256' }

async function pairingCode(pubB64) {
  const digest = await crypto.subtle.digest('SHA-256', b64u.from(pubB64))
  const bytes = new Uint8Array(digest)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const c = (i) => alphabet[bytes[i] % alphabet.length]
  return c(0) + c(1) + '-' + c(2) + c(3)
}

async function encryptForChannel(pubB64, plaintext) {
  const pair = await crypto.subtle.generateKey(ECDH, false, ['deriveKey'])
  const peer = await crypto.subtle.importKey('raw', b64u.from(pubB64), ECDH, false, [])
  const aes = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: peer }, pair.privateKey,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(plaintext))
  const epk = await crypto.subtle.exportKey('raw', pair.publicKey)
  return { epk: b64u.to(epk), iv: b64u.to(iv), ct: b64u.to(ct) }
}

async function importDocKey(keyB64) {
  return crypto.subtle.importKey('raw', b64u.from(keyB64), 'AES-GCM', false, ['encrypt', 'decrypt'])
}
async function decryptDocument(keyB64, doc) {
  const key = await importDocKey(keyB64)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.from(doc.iv) }, key, b64u.from(doc.ct))
  return new TextDecoder().decode(pt)
}
async function encryptDocument(keyB64, plaintext) {
  const key = await importDocKey(keyB64)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  return { iv: b64u.to(iv), ct: b64u.to(ct) }
}

async function editorMode(fragmentKey, status) {
  const doc = await (await fetch(location.pathname + '/document')).json()
  let plaintext
  try { plaintext = await decryptDocument(fragmentKey, doc) }
  catch { status.textContent = 'Could not decrypt — reopen the exact URL from your terminal.'; return }

  const fields = document.getElementById('fields')
  const textarea = document.createElement('textarea')
  textarea.value = plaintext
  textarea.spellcheck = false
  fields.appendChild(textarea)
  const form = document.getElementById('form')
  form.querySelector('button').textContent = 'Save securely'
  form.hidden = false
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const res = await fetch(location.pathname + '/submission', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document: await encryptDocument(fragmentKey, textarea.value) }),
    })
    if (res.ok) {
      form.hidden = true
      status.textContent = 'Saved. You can close this tab — sops re-encrypts from here.'
    } else {
      status.textContent = 'Save rejected (' + res.status + ') — the session may have expired.'
    }
  })
}

async function main() {
  const publicKey = location.hash.slice(1)
  const status = document.getElementById('status')
  if (!publicKey) { status.textContent = 'Missing key fragment — reopen the exact URL from your terminal.'; return }
  document.getElementById('pairing').textContent = await pairingCode(publicKey)

  const meta = await (await fetch(location.pathname + '/meta')).json()
  if (meta.error) { status.textContent = 'This request has expired or was already answered.'; return }
  document.getElementById('context').textContent =
    'Environment: ' + (meta.env || 'unknown') + (meta.reason ? ' — ' + meta.reason : '')

  if (meta.mode === 'editor') { await editorMode(publicKey, status); return }

  const fields = document.getElementById('fields')
  for (const key of meta.keys) {
    const label = document.createElement('label')
    label.textContent = key
    const input = document.createElement('input')
    input.type = 'password'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.dataset.key = key
    input.required = true
    label.appendChild(input)
    fields.appendChild(label)
  }
  const form = document.getElementById('form')
  form.hidden = false
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const values = {}
    for (const input of fields.querySelectorAll('input')) {
      if (!input.value.trim()) { status.textContent = input.dataset.key + ' is empty.'; return }
      values[input.dataset.key] = input.value
    }
    const payload = await encryptForChannel(publicKey, JSON.stringify(values))
    const res = await fetch(location.pathname + '/submission', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.ok) {
      form.hidden = true
      status.textContent = 'Delivered. You can close this tab — the terminal has it from here.'
    } else {
      status.textContent = 'Submission rejected (' + res.status + ') — the request may have expired or already been answered.'
    }
  })
}
main()
</script>
</body>
</html>`
}
