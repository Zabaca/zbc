// WHAT SEND CAN SEND. One entry per line; a change that adds a way to send adds ONE entry here and touches nothing in Send.tsx
// (not its submit, not its radio block):
//
//   the form path:  { type: 'form', label: 'A form', hint: '...', Picker: FormPicker }
//   the PDF path:   { type: 'document', label: "A client's PDF", hint: '...', Picker: DocumentPicker } (below)
//
// `type` names the builder in src/sources.ts. An entry's optional `Picker` is drawn under its radio when chosen, and says what
// else the source needs (which form version, which uploaded PDF and where its fields are) through `onChange`: whatever it returns
// as `source` is merged into the request's `source` next to `type`, and `sensitive` turns on delivery by private link. A picker
// that has what it needs reports `ready: true`; until it does Send keeps its button off.
import type { ComponentType } from 'react'
import { FormPicker } from './FormPicker'
import { DocumentPicker } from './documents/DocumentPicker'

export interface PickerValue {
  /** Merged into the request's `source`, next to `type`. */
  source?: Record<string, unknown>
  /** The source is known to hold private information. */
  sensitive?: boolean
  /** True once the picker has what it needs; a source with a picker cannot be sent before. */
  ready?: boolean
}

export interface SendSource {
  type: string
  label: string
  hint: string
  Picker?: ComponentType<{ clientId: string; onChange: (v: PickerValue) => void }>
}

export const SEND_SOURCES: SendSource[] = [
  { type: 'sample', label: 'The built-in sample', hint: 'A branded page with a signature, initials, date, text and checkbox for each signer. It carries no agreement.' },
  { type: 'form', label: 'A form', hint: 'Questions the first signer answers, then everyone signs the document made from the answers and the agreement text.', Picker: FormPicker },
  { type: 'document', label: "A client's PDF", hint: "One of the client's uploaded documents, with a signature, initials, date, text and checkbox placed on its pages for each signer.", Picker: DocumentPicker },
]
