// The names the service says about itself, as the tests that pin its words hold them: Northfield's install (the words every existing suite pins) and an invented company's, whose pages and mail must carry nothing of Northfield's.
import { createInstall } from '@space/workspace'
import { serviceWordsOf } from '../src/workspace'
import type { ServiceWords } from '../src/service'
import { readFileSync } from 'node:fs'

const northfieldFile = new URL('../../workspace/northfield/workspace.json', import.meta.url)

/** Northfield's install's words: "Northfield Forms", run by Northfield Works LLC, forms@northfield.example, info@northfield.example. */
export const NORTHFIELD_WORDS: ServiceWords = serviceWordsOf(createInstall(JSON.parse(readFileSync(northfieldFile, 'utf8'))))

/** An invented company's install: Brightwater Builders, its Forms run by Brightwater itself, nothing of Northfield's anywhere in its declaration. */
export const BRIGHTWATER_DECLARATION = {
  company: { id: 'brightwater', name: 'Brightwater Builders', legalName: 'Brightwater Builders Inc.', domain: 'brightwater.example', timeZone: 'America/Chicago' },
  access: { teamDomain: 'brightwater.cloudflareaccess.com' },
  space: { host: 'space.brightwater.example', sessionDuration: '730h' },
  senders: { forms: 'forms@brightwater.example', meet: 'meet@brightwater.example' },
  formsService: { name: 'Brightwater Forms', contact: 'office@brightwater.example', runBy: { name: 'Brightwater', legalName: 'Brightwater Builders Inc.', mailingLine: 'Duluth, Minnesota' } },
  people: [{ address: 'ada@brightwater.example', name: 'Ada', mailName: 'Ada Brightwater', role: 'owner' }],
} as const

export const BRIGHTWATER_WORDS: ServiceWords = serviceWordsOf(createInstall(BRIGHTWATER_DECLARATION))

/** The same invented company where its Forms sends only for itself (`formsService.ownCompanyOnly`): what Pinecrest Roofing's space declares. No second party is named anywhere. */
export const BRIGHTWATER_OWN_DECLARATION = { ...BRIGHTWATER_DECLARATION, formsService: { ...BRIGHTWATER_DECLARATION.formsService, runBy: { ...BRIGHTWATER_DECLARATION.formsService.runBy, name: 'Brightwater Builders' }, ownCompanyOnly: true } } as const

export const BRIGHTWATER_OWN_WORDS: ServiceWords = serviceWordsOf(createInstall(BRIGHTWATER_OWN_DECLARATION))
