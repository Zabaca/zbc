import { SEND_WARNING_ITEMS, sendWarningHeading } from '@space/forms/src/sendWarning'
import { useInstall } from '../install'
import { Notice } from './kit'

/** The list of what not to send, in full, for the operator to read before anything goes out (src/sendWarning.ts). */
export function SendWarning() {
  const { forms } = useInstall()
  return (
    <Notice kind="warn">
      <div data-testid="send-warning">
        <p className="font-medium">{sendWarningHeading({ name: forms.service })}</p>
        <ol className="mt-1 grid gap-0.5">
          {SEND_WARNING_ITEMS.map((item, i) => (
            <li key={i}>
              ({i + 1}) {item}
            </li>
          ))}
        </ol>
      </div>
    </Notice>
  )
}
