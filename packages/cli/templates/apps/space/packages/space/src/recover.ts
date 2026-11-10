// A first visit to /forms, with no space session yet, must recover instead of going blank.
//
// /forms is the Forms application's, a day long; the page's own files (/assets/...) are the space's, a month (ADR 0002). Someone who
// opens /forms with only the Forms session gets the page and then none of its files: Access sends each file's request to the
// space's sign-in, and a script cannot follow that. The page would stay blank.
//
// So the page carries this small script, inline and ahead of its files: when one of the page's own files fails on a /forms path, it
// remembers where the person was and sends the whole page through /today, which Access can sign in to, and the page comes back to
// where it was. One try per two minutes, so a file that is really missing cannot loop. The script is classic and ES5, because it runs
// before anything else and in the oldest phone; it is one source: vite.config.ts puts exactly this text in the page, and the Worker's
// content security policy allows exactly its hash (`recoverScriptHash`), so the two cannot drift.

export const RECOVER_AT = 'space:recover-at'
export const RECOVER_TO = 'space:recover-to'
/** One recovery per this long. */
export const RECOVER_ONCE_MS = 120_000
/** A remembered place is good for this long: a person who goes through a sign-in code needs a few minutes. */
export const RECOVER_KEEP_MS = 600_000

export const RECOVER_SCRIPT = `(function(){addEventListener('error',function(e){var t=e.target;if(!t||t===window||(t.tagName!=='SCRIPT'&&t.tagName!=='LINK'))return;var u=t.src||t.href||'';if(u.indexOf(location.origin+'/assets/')!==0)return;if(location.pathname!=='/forms'&&location.pathname.indexOf('/forms/')!==0)return;try{var at=Number(sessionStorage.getItem('${RECOVER_AT}')||0);if(Date.now()-at<${RECOVER_ONCE_MS})return;sessionStorage.setItem('${RECOVER_AT}',String(Date.now()));sessionStorage.setItem('${RECOVER_TO}',location.pathname+location.search+location.hash)}catch(x){return}location.replace('/today')},true)})()`

/** The Content-Security-Policy source for the script above: `'sha256-<base64>'`. */
export async function recoverScriptHash(): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RECOVER_SCRIPT))
  let binary = ''
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
  return `'sha256-${btoa(binary)}'`
}

/** The slice of `Storage` the recovery uses. */
export interface Remembers {
  getItem(key: string): string | null
  removeItem(key: string): void
}

/**
 * Where the person was before they were sent through /today, once, and only if it was a place in the Forms tab and a short while ago.
 * Taken (forgotten) on the way out, so it cannot send anyone twice. The page calls it as it opens; a null means stay.
 */
export function takeRecovery(storage: Remembers, now: number): string | null {
  try {
    const to = storage.getItem(RECOVER_TO)
    const at = Number(storage.getItem(RECOVER_AT) ?? 0)
    storage.removeItem(RECOVER_TO)
    if (!to || !(to === '/forms' || to.startsWith('/forms/') || to.startsWith('/forms?') || to.startsWith('/forms#'))) return null
    return now - at <= RECOVER_KEEP_MS ? to : null
  } catch {
    return null
  }
}
