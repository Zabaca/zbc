// Settings, Calls and Phone: the month's call usage against the free allowance, and the phone's line settings and each person's 911 address. They are the
// owner's, and meet decides that: the space carries each question with the assertion, and meet admits the owner for the usage and the line's owner for the settings (a person with
// the phone sees where calls go and keeps their own 911 address).
import { PhoneLineSettings, PhoneSetup } from '@space/meet/src/web/phone/Phone'
import type { MeetUsage } from '@space/workspace'
import { usePhoneHandle } from './phone/PhoneHost'
import { notSetUp } from './PhonePane'
import { useInstall } from './install'
import { Block, Viewed } from './settings-parts'
import { useView } from './views'

/** "312 of 1,000 GB": the month's estimate against the allowance. */
export function usageWords(u: MeetUsage): string {
  return `${u.usedGb.toLocaleString('en-US', { maximumFractionDigits: 1 })} of ${u.freeGb.toLocaleString('en-US')} GB`
}

export function UsageView({ usage }: { usage: MeetUsage }) {
  const pct = Math.min(100, (usage.usedGb / usage.freeGb) * 100)
  const trip = (usage.tripGb / usage.freeGb) * 100
  return (
    <div className="s-card" data-testid="call-usage" data-paused={usage.paused}>
      <p className="s-lead" data-testid="call-usage-words">
        {usageWords(usage)} used this month
      </p>
      <div className="usage-bar" role="img" aria-label={`${usageWords(usage)} used; new calls stop at ${usage.tripGb} GB`}>
        <span className="usage-fill" style={{ width: `${pct}%` }} />
        <span className="usage-trip" style={{ left: `${trip}%` }} />
      </div>
      {usage.paused ? (
        <p data-testid="call-usage-paused">
          <b>Calls are paused until {usage.pausedUntil}.</b> The month is past {usage.tripGb} GB, so no one new can join a call and no new call or huddle can be made. People already in a call carry on.
        </p>
      ) : (
        <p className="sub">
          New joins and new calls stop at {usage.tripGb} GB of the account’s free {usage.freeGb.toLocaleString('en-US')} GB, until the first of next month. This is an estimate counted at the send caps of every
          track each person receives, so it runs a little high.
        </p>
      )}
    </div>
  )
}

export function CallsSection() {
  const { state, reload, problem } = useView<MeetUsage>('meet/usage')
  return (
    <>
      <Block title="The month’s calls" testid="calls-usage">
        <Viewed view={state} problem={problem} reload={reload} loading="Reading the month’s usage">
          {(usage) => <UsageView usage={usage} />}
        </Viewed>
      </Block>
    </>
  )
}

export function PhoneSection() {
  const { company } = useInstall()
  const phone = usePhoneHandle()
  const status = phone?.status ?? null
  return (
    <Block title="Phone" testid="phone-settings-block">
      {phone && status ? (
        <div className="meet-screen" data-testid="phone-settings-screen">
          <PhoneLineSettings phone={phone} />
          <PhoneSetup phone={phone} />
        </div>
      ) : (
        <p className="cnotice warn" role="status" data-testid="phone-not-set-up">
          <span>{notSetUp(company)}</span>
        </p>
      )}
    </Block>
  )
}
