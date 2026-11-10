// A screen that is loaded when it is first needed (the Forms tab: App.tsx) can fail to load. The usual way: the page was opened, the space was
// deployed, and a move to the screen asks for a chunk whose old address now answers with the page's HTML, so `import()` rejects. Without this the
// whole page goes blank until a reload; with it the rest of the page stays and a line says what to do.
import { Component, type ErrorInfo, type ReactNode } from 'react'

export class Boundary extends Component<{ what: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${this.props.what} could not be opened`, error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="boot" role="alert" data-testid="screen-failed">
        <p>{this.props.what} could not be opened. The space may have been updated since this page was loaded.</p>
        <button type="button" className="btn primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
