import { useEffect, useState } from 'react'
import { applyUpdate, updateWaiting } from '../update'

/** Shown when a new version arrived while the app was in use; switching never happens mid-entry by itself. */
export default function UpdateBanner() {
  const [show, setShow] = useState(updateWaiting())
  useEffect(() => {
    const on = () => setShow(true)
    window.addEventListener('app-update', on)
    return () => window.removeEventListener('app-update', on)
  }, [])
  if (!show) return null
  return (
    <div className="update-banner" role="status">
      <span>A new version of the app is ready.</span>
      <button type="button" className="pill" onClick={applyUpdate}>
        Update
      </button>
    </div>
  )
}
