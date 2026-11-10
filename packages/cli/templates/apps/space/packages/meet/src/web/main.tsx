// The SPA root: render whatever the URL's Route says (route.ts). No router
// library; there are three screens, and each is a full page load away from the
// others (the guests' workspace at /w and a call link are different doors).

import { createRoot } from 'react-dom/client'
import Home from './Home'
import Room from './Room'
import Workspace from './workspace/Workspace'
import { parseRoute } from './route'
import { SiteContext, useGuestSite } from './site'
import './style.css'

function Screen() {
  const route = parseRoute(window.location.pathname, window.location.search)
  switch (route.view) {
    case 'home':
      return <Home />
    case 'guest':
      return <Workspace />
    case 'call':
      return <Room route={route} />
  }
}

/** Every screen reads whose workspace it is in from one place: the install's answer to `GET /w/api/site`, asked once. */
function App() {
  const site = useGuestSite()
  return (
    <SiteContext.Provider value={site}>
      <Screen />
    </SiteContext.Provider>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
