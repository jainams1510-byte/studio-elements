/**
 * Keeps the installed app current. A phone keeps showing its saved copy until the new version is switched in,
 * so: check for a new version on opening, on coming back to the app and every hour; switch straight away in the
 * first seconds after opening (nothing typed yet), otherwise offer an Update button.
 */
import { registerSW } from 'virtual:pwa-register'

export const APP_VERSION = __APP_VERSION__
export const BUILD_TIME = __BUILD_TIME__

const STARTUP_MS = 15_000
let apply: ((reload?: boolean) => Promise<void>) | null = null
let waiting = false

export function updateWaiting(): boolean {
  return waiting
}

export function applyUpdate(): void {
  if (!apply || !navigator.serviceWorker?.controller) {
    window.location.reload()
    return
  }
  // Reload as soon as the new version takes over (the plugin's own reload does not always fire), or after 3 s.
  let done = false
  const reload = () => {
    if (done) return
    done = true
    window.location.reload()
  }
  navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true })
  setTimeout(reload, 3000)
  void apply(false)
}

export function startUpdates(): void {
  if (!('serviceWorker' in navigator)) return
  apply = registerSW({
    immediate: true,
    onNeedRefresh() {
      if (performance.now() < STARTUP_MS) {
        applyUpdate()
        return
      }
      waiting = true
      window.dispatchEvent(new Event('app-update'))
    },
    onRegisteredSW(_url, reg) {
      if (!reg) return
      const check = () => {
        if (navigator.onLine) void reg.update().catch(() => undefined)
      }
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
      setInterval(check, 60 * 60 * 1000)
    },
  })
}

// A screen that loads on first open can fail if a newer version replaced its file on the server: reload once.
window.addEventListener('vite:preloadError', () => {
  const key = 'studio.reloadedForUpdate'
  if (sessionStorage.getItem(key)) return
  sessionStorage.setItem(key, '1')
  window.location.reload()
})
