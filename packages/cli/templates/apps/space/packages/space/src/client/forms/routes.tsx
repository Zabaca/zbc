// The Forms tab's route table. One line per screen in ROUTES (and one line per top-level section in NAV, sections.ts). A change that
// adds screens adds its lines here and keeps its screens in files of its own.
//
// A route is a place in the tab (route.ts): `/envelopes/<id>` is the address /forms/envelopes/<id>. `match` tests the place, and a
// screen receives its captures and the query. The sections, which the rail draws without loading any screen, are sections.ts.
import type { ReactNode } from 'react'
import { Answers } from './Answers'
import { ClientPage } from './ClientPage'
import { Clients } from './Clients'
import { Documents } from './Documents'
import { DocumentPage } from './documents/DocumentPage'
import { EnvelopePage } from './EnvelopePage'
import { Envelopes } from './Envelopes'
import { Forms } from './Forms'
import { History } from './History'
import { Seal } from './Seal'
import { Send } from './Send'
import { NewClient } from './SetUpSigning'

const ID = '([0-9a-f-]{36})'

export interface Route {
  match: RegExp
  screen: (m: RegExpExecArray, query: URLSearchParams) => ReactNode
}

export const ROUTES: Route[] = [
  { match: /^\/(?:clients)?$/, screen: () => <Clients /> },
  { match: /^\/clients\/new$/, screen: (_m, q) => <NewClient number={q.get('client')} /> },
  { match: new RegExp(`^/clients/${ID}$`), screen: (m) => <ClientPage id={m[1]!} /> },
  { match: /^\/envelopes$/, screen: (_m, q) => <Envelopes client={q.get('client')} status={q.get('status')} /> },
  { match: new RegExp(`^/envelopes/${ID}$`), screen: (m) => <EnvelopePage id={m[1]!} /> },
  { match: /^\/send$/, screen: (_m, q) => <Send client={q.get('client')} from={q.get('from')} /> },
  { match: new RegExp(`^/forms(?:/${ID})?$`), screen: (m) => <Forms id={m[1]} /> },
  { match: new RegExp(`^/envelopes/${ID}/answers$`), screen: (m) => <Answers id={m[1]!} /> },
  { match: /^\/documents$/, screen: () => <Documents /> },
  { match: new RegExp(`^/documents/${ID}$`), screen: (m) => <DocumentPage id={m[1]!} /> },
  { match: /^\/seal$/, screen: () => <Seal /> },
  { match: /^\/history$/, screen: () => <History /> },
]
