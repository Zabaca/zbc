// The page of the guests' bundle for anyone who arrives without a link: one line
// saying how calls are joined, the way in to the channels a guest was invited
// to, and where the company's people work. There is nothing to start here; calls are
// started in the space.

import { SPACE_MEET_PATH, peopleOf, useSite } from './site'
import { Wordmark } from './ui'

/** The install's people as this page calls them, read where it is drawn (a component of its own, so `Home` itself holds no hook and can be drawn to markup as a function). */
function People() {
  return <>{peopleOf(useSite())}</>
}

export default function Home() {
  return (
    <main className="page page-center">
      <Wordmark />
      <h1 className="title">Calls are joined by link.</h1>
      <p className="lede">If someone sent you a link to a call, open it. There is nothing to sign in to.</p>
      <p className="fine">
        Invited to a channel? <a href="/w">Sign in with your email address</a>. <People /> work in <a href={SPACE_MEET_PATH}>the space</a>.
      </p>
    </main>
  )
}
