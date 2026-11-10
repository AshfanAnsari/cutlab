import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// FIX C: the boot splash (index.html) holds from first paint until the
// app has mounted, then fades — two rAFs so the first real frame is
// on screen before the fade starts, plus a plain timeout fallback
// for a background tab (where rAF never fires) so the splash can
// never outlive the boot.
{
  let gone = false
  const dismiss = () => {
    if (gone) return
    gone = true
    const s = document.getElementById('boot-splash')
    if (!s) return
    s.classList.add('done')
    setTimeout(() => s.remove(), 450)
  }
  requestAnimationFrame(() => requestAnimationFrame(dismiss))
  setTimeout(dismiss, 3000)
}
