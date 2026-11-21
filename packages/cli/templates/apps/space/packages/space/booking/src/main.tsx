// The booking page's entry (src/App.tsx is the page).
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './style.css'

const root = document.getElementById('root')
if (root) createRoot(root).render(<App pathname={window.location.pathname} />)
