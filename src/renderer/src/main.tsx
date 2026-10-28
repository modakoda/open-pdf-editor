import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/theme.css'
import './fonts/fonts.css'
import { App } from './App'
import { loadAndRegisterFonts } from './fonts/fonts'

// Register the bundled Unicode fonts with the engine before anything is edited or exported.
loadAndRegisterFonts().catch((err) => console.error('Could not load bundled fonts', err))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
