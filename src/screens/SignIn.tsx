import { useState, type FormEvent } from 'react'
import { supabase } from '../supabase'

export default function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    setBusy(false)
    if (err) {
      setError(navigator.onLine ? 'Email or password is not right.' : 'No signal. Sign in needs a connection.')
    }
  }

  return (
    <main className="signin">
      <div>
        <h1>Studio Elements</h1>
        <p className="muted">Sign in with the account set up for you.</p>
      </div>
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Signing in' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
