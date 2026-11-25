import '@fontsource-variable/inter'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { startUpdates } from './update'
import './styles.css'
import './styles/money.css'
import './styles/fees.css'
import './styles/decisions.css'
import './styles/deck.css'

// Ask the phone not to clear our stored logs when it runs low on space.
if (navigator.storage?.persist) void navigator.storage.persist()

startUpdates()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
