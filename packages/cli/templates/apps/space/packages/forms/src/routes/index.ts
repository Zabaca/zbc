// THE API'S ROUTE TABLES. A feature that adds routes adds ONE line to the table for its door, and its routes live in a file of
// its own, so two features worked on in parallel change different files and meet at one line each (the second to merge
// resolves that line).
//
//   ADMIN_API   mounted under /admin/api: the operator's, behind Access and the Worker's own check of the assertion.
//   PUBLIC_API  mounted under /api: no sign-in; every request authenticates itself (the signer's token) and runs behind the
//               rate limit.
//
// The form path adds `formRoutes` to ADMIN_API (its builder and its filler's screens go to PUBLIC_API as `fillerRoutes`);
// the PDF path adds `documentRoutes` to ADMIN_API. The clients, the seal and the checks are routed in app.ts.
import type { Hono } from 'hono'
import type { App } from '../http'
import { documentRoutes } from './documents'
import { envelopeRoutes } from './envelopes'
import { fillerRoutes, formRoutes } from './forms'
import { signerRoutes } from './signer'

export type Mount = (app: Hono<App>) => void

export const ADMIN_API: Mount[] = [
  envelopeRoutes,
  formRoutes,
  documentRoutes,
]

export const PUBLIC_API: Mount[] = [
  signerRoutes,
  fillerRoutes,
]
