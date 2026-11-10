# The inbox's installable app and notifications: the key, deploy order and the hand test

Placeholders: `<env>` (the deploy environment), `<space-host>` (for example `space.northfield.example`), `<owner>` (the install's owner, for example `tessa@northfield.example`).

Why each piece is as it is (the key failing closed, what replacing it does, which mail notifies) is ADR 0001 decision 16 (`../adr/0001-the-inbox-is-its-own-worker-over-gmail.md`; code comments cite it as ADR-007); this is only what to do. The installable app is a manifest, a service worker at `/sw.js` that keeps only the app and never mail, no-store on every answer, the `/?c=` landing, and a sign-in that lasts a month. Notifications are Web Push on top of it.

## The key

Notifications are signed with one key pair, `INBOX_VAPID_KEY`: a P-256 JSON Web Key holding both halves, a Worker secret pushed by zbc from the environment's secrets file (sops), under the same name in both.

**Making it**, on the machine that decrypts the secrets file, once, before the apply that turns notifications on:

    SPACE_DECLARATION=<the install's workspace.json> bun scripts/vapid-key.ts production

(run from the inbox package; the secrets file is `SPACE_SECRETS`, else the `secrets.yaml` beside the declaration). It writes the key into the secrets file through `sops set --value-stdin` (never printed, never on a command line, never in a file in the clear) and prints only the public half. `bun scripts/vapid-key.ts public` prints that public half again later. Commit the changed secrets file (encrypted) with a message that says the key was added.

**The key must be in the file before the apply**: zbc refuses an apply that names a secret the file does not hold. Without a usable key, Settings says notifications are not set up and nothing is sent (ADR 0001, decision 16).

**Replacing it** (`production --replace`; the script refuses otherwise) turns notifications off on every device (ADR 0001, decision 16). Afterwards, open Settings on each device and press Turn notifications on again.

**The dev key** is separate: `bun scripts/vapid-key.ts dev` writes one to `.dev.vars` in the inbox package (gitignored). In a dev build the push service is a stand-in that answers 201 and calls nothing, so dev never reaches Google's push service; a browser can turn notifications on against it.

## Deploy order

The apply is the owner's, from the owner's machine.

1. The key in the secrets file (above).
2. `bunx @zabaca/zbc apply <env> space`. The Worker gains the secret, the store gains migration 7 (the `device` table and a message's notification marks) by itself when the object wakes; every message already held reads as never owed, so the deploy notifies about nothing old. Migrations are append-only: go forward, never back.
3. The hand test below.

Web Push adds no hostname, route, DNS record or Access application.

## Hand test

Only the deployed install on the owner's own devices can show these. A build proves the encryption against RFC 8291's worked example, the whole path with a fake push service, the Settings section in a real Chromium, and the service worker's push handler through Chromium's DevTools; it cannot run Access, Chrome's install, Google's push service, or a phone's or a Mac's notifications.

**Installing (check it again if it was not checked):**

- On an Android phone, Chrome offers "Install" and the app appears in the app drawer and in Android's list of apps (that is the Android app being built; a plain home screen shortcut means it was not).
- It opens full screen on the Inbox. With the sign-in lapsed it goes through the sign-in code and back.
- A day after signing in, opening it asks for no code.

**Notifications, on the phone:**

- Settings, Notifications: "This device does not get notifications." Press Turn on notifications; Android asks; allow. It reads "This device gets notifications." and lists "Chrome on Android (this device)".
- Send a test notification: it arrives with the app's name and icon. If it shows as Chrome's rather than the app's, Android did not build the app (see Installing).
- From another account of yours, written as a person, send mail to `<owner>`. After the phone has sat idle and locked for ten minutes, it shows the sender and the subject on the lock screen within about a minute. If it shows "Contents hidden", that is Android's setting for sensitive notifications on the lock screen, not the inbox.
- No sound for: a newsletter (anything Gmail files under Promotions or Updates), a no-reply sender, a reply you send from Gmail, one Claude sends on your instruction.
- Mail from a Client's person that Gmail files under Updates does notify.
- A tap opens that conversation in the app. Let the sign-in lapse (or sign out at `https://<space-host>/cdn-cgi/access/logout`), then tap one: the sign-in comes first, then that conversation, not the Inbox.
- With that conversation open on screen, a reply in it makes no sound, and the list beside it shows the reply at once. The open conversation itself is not reloaded behind you: pressing Close or Send then shows the new message first. A reply in another conversation still notifies.
- Opening a conversation clears its notification from the shade.
- Four or more emails from people arriving together (send them from another account within a few seconds of each other, before the inbox's next sync) arrive as one notification, "N new messages" over "From ..., ... and N others"; tapping it opens the Inbox. Three or fewer arrive one by one.
- Claude closing or sending on a conversation where a reply has just arrived: the reply notifies (you are not looking); your own Close or Send there does not.
- Turn off on this device: the test button goes, and new mail makes no sound on the phone.

**Notifications, on a Mac:**

- Install from Chrome's address bar. In Settings, Turn on notifications; allow Chrome in macOS System Settings, Notifications, if it asks.
- The test notification and a real one appear with the sender and the subject; a click opens the conversation in the app's window.
- Quit Chrome, send yourself mail as a person, start Chrome within the hour: it shows. Wait more than an hour before starting Chrome: it does not (the push service dropped it).
- From the Mac, Remove the phone. Its notifications stop.

If Gmail's own notifications on the phone stay on, each email from a person buzzes twice: the inbox's opens the inbox, Gmail's opens Gmail.

## Numbers to compare, over the first week

Settings, Notifications shows them:

- **"In the last 7 days: N notifications sent, M dropped."** Compare N with the mail from people that reached the Inbox unread in the same week (the Inbox view, and Gmail's notifications on the phone, which buzz for the same mail). They should be equal, less mail found more than an hour late (dropped) and mail you had already read in Gmail before the inbox had it. A gap beyond that is worth a look.
- **For each device, "N delivered, M failed."** Failures should be zero or close to it; a device whose last one failed says why under its name.

## When something is wrong

- **Nothing arrives anywhere.** Settings says whether the key is set up. If it is and the Gmail line is amber, Gmail's push to the inbox has stopped, and notifications stop with it (they ride on it); Gmail's own notifications are the cover. The Worker's log names each failed delivery by message and device id (never sender or subject).
- **One device stopped.** Its row says why. "Turn notifications on again" (a refusal) means the device no longer matches the key: on that device, press Turn notifications on again. A device the browser dropped (uninstalled, site data cleared, permission taken back) leaves the list by itself.
- **Turn on notifications stops partway.** Settings names the step it stopped at and quotes the browser. "Starting the app's service worker" means the app's worker is not running on that device; an amber line above the button says why when the browser would not register it. A redirect there is Access answering the worker's script instead of the app: the worker must be registered as a classic worker, which Chrome fetches with the sign-in cookie (`src/client/newVersion.ts` says why: a module worker registers nowhere behind Access). "Getting a push address from the browser" is Chrome and Google's push service: try again on another network, or check that Chrome itself may show notifications (Android's settings for the app, or macOS's).
- **The service worker misbehaves** (a bad build that will not load, a notification loop). Deploy a build whose `sw.js` unregisters itself: in its `activate` handler, `self.registration.unregister()` and then `clients.matchAll()` each `navigate(client.url)`. Every device drops it on its next check (a launch, or the app coming back into view). Then deploy a fixed build; the next launch registers it again. Turning notifications back on may be needed on each device, since unregistering ends each device.
