// A document sent from a conversation, drawn as a card in its history: its title and its state, and a button that opens it in Forms. When
// everyone has signed the same card says the signed copy is back and the button opens that copy's page. Nothing of what the document holds is here: the
// card is given a title, a state, counts and a time (documents.ts), and a document holding a private answer is drawn exactly as any other.
import { type ShownDocument, documentLine } from '../documents'
import { documentPath } from './day'
import { Glyph, TabIcon } from './icons'
import { stamp } from './convo'

export function DocumentCard({ doc, now, zone }: { doc: ShownDocument; now: number; zone: string | undefined }) {
  const back = doc.state === 'completed'
  return (
    <div className={`card doc${back ? ' returned' : ''}`} data-testid="document-card" data-state={doc.state} data-doc={doc.id}>
      <span className="card-ico">
        {back ? <Glyph name="check" size={15} /> : <TabIcon tab="forms" size={15} />}
      </span>
      <div className="card-main">
        <div className="card-title" data-testid="document-title">
          {doc.title}
        </div>
        <div className="sub" data-testid="document-state">
          {documentLine(doc)} ·{' '}
          <time dateTime={new Date(doc.at).toISOString()}>{stamp(now, doc.at, zone)}</time>
        </div>
        {back && (
          <div className="sub" data-testid="document-back">
            The signed copy is back. Forms sends it to everyone who signed.
          </div>
        )}
      </div>
      <div className="card-act">
        <a className="btn" href={documentPath(doc.id)} data-testid="document-open">
          {back ? 'Open the signed copy' : 'Open in Forms'}
        </a>
      </div>
    </div>
  )
}
