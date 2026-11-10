import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { registerServiceWorker } from './notify'
import './style.css'
import './settings.css'
import './nav.css'
import './today.css'
import './knowledge.css'
import './calendar.css'
import './calls.css'
import './channels.css'
import './people.css'
import './newmail.css'
import './chat.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// The installed app's service worker, which shows notifications and makes the space installable. Registered once the page has loaded.
registerServiceWorker()
