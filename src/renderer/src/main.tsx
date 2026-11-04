import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/theme.css'
import './fonts/fonts.css'
import { App } from './App'
import { loadAndRegisterFonts } from './fonts/fonts'
import { installSystemFontLoader } from './fonts/systemFonts'
import { installCMapLoader } from './pdf/cmaps'

// Register the bundled Unicode fonts with the engine before anything is edited or exported.
loadAndRegisterFonts().catch((err) => console.error('Could not load bundled fonts', err))
// Load system fonts (CJK, Thai, Devanagari) when a document's text needs them.
installSystemFontLoader()
// Let the engine read CJK character maps when editing text in such fonts.
installCMapLoader()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
