/**
 * Browser analytics on the landing page, or none.
 *
 * `shared/telemetry.ts` already counts every request at the edge, page views
 * included, and records nothing about who made them — no IP, no user agent —
 * by design. That answers "how many", and it cannot answer what a launch page
 * actually needs to know once traffic is real: where a reader came from,
 * whether they scrolled to the clone command, whether the same person came
 * back. Those are browser questions, and a browser tool answers them.
 *
 * Off unless the instance says otherwise. The project key is a public,
 * write-only token — it lands in the page source of every PostHog site — but
 * WHICH project is an instance's business, not the template's: this package
 * ships to other companies, and a hard-coded key would send their readers to
 * ours. So the key and host are two edge-only variables, read here the way
 * `shared/operator.ts` reads its two, and the page carries no script at all
 * when the key is unset. Edge-only for the same reason the operator is: the
 * container serves nothing a browser renders, and putting the key on
 * `CONTAINER_ENV` would restart the container to rotate it.
 *
 * What the snippet is told: no person profiles for anonymous readers. Session
 * replay is left to the PostHog project's own setting — the page has no forms
 * and nothing to type into, so a recording shows scrolling and clicks and
 * PostHog's default input masking covers the rest. Turned on 2026-09-18 after
 * shipping off for a day; an operator who wants it off again sets it off in
 * the project, not here.
 */

/** The variables analytics is read from, and only those. */
export type AnalyticsVar = 'WALGIT_POSTHOG_KEY' | 'WALGIT_POSTHOG_HOST' | 'WALGIT_POSTHOG_UI_HOST'

/** An environment named exactly by those variables — see `OperatorEnv`. */
export type AnalyticsEnv = Partial<Record<AnalyticsVar, string>>

export type Analytics = {
  /** The PostHog project API key, `phc_…`. */
  key: string
  /**
   * The ingestion origin. PostHog Cloud US unless the instance says EU,
   * self-hosted, or — the usual reason to set it — a reverse proxy on the
   * deployment's own name, so a browser sees one first-party origin.
   */
  host: string
  /**
   * The PostHog app the project lives in. Only matters when `host` is a
   * proxy: the SDK needs it to reach the toolbar and the app's own endpoints,
   * which the proxy does not carry. Harmless otherwise.
   */
  uiHost: string
}

export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'
export const DEFAULT_POSTHOG_UI_HOST = 'https://us.posthog.com'

/**
 * The `defaults` date the SDK is initialised with — PostHog's own mechanism
 * for shipping new default behaviour without breaking an existing snippet.
 * Bump deliberately, after reading what changed.
 */
export const POSTHOG_DEFAULTS = '2026-05-30'

/** Read an environment into an analytics config, or `null` for "off". */
export function analyticsFrom(
  env: AnalyticsEnv | Record<string, string | undefined>,
): Analytics | null {
  const key = trimmed(env.WALGIT_POSTHOG_KEY)
  if (key === null) return null
  return {
    key,
    host: trimmed(env.WALGIT_POSTHOG_HOST) ?? DEFAULT_POSTHOG_HOST,
    uiHost: trimmed(env.WALGIT_POSTHOG_UI_HOST) ?? DEFAULT_POSTHOG_UI_HOST,
  }
}

/**
 * The `<script>` the head carries, or the empty string.
 *
 * PostHog's own loader stub, verbatim from their docs, then `init`. The two
 * values are interpolated as JSON string literals, so a key or host containing
 * a quote cannot close the literal early — both come from an operator's own
 * config, but "cannot" is cheaper than "would not".
 */
export function analyticsScript(analytics: Analytics | null): string {
  if (analytics === null) return ''
  const key = JSON.stringify(analytics.key)
  const host = JSON.stringify(analytics.host)
  const uiHost = JSON.stringify(analytics.uiHost)
  return (
    '<script>\n' +
    '!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);\n' +
    `posthog.init(${key},{api_host:${host},ui_host:${uiHost},defaults:"${POSTHOG_DEFAULTS}",person_profiles:"identified_only"});\n` +
    '</script>\n'
  )
}

const trimmed = (raw: string | undefined): string | null => {
  if (raw === undefined) return null
  const value = raw.trim()
  return value === '' ? null : value
}
