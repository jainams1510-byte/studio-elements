import { useState } from 'react'
import {
  PROCUREMENT_SELECT, QUOTE_SELECT, RA_BILL_SELECT, VENDOR_KINDS, VENDOR_SELECT, WORK_ORDER_SELECT,
  type ProcurementItem, type Quote, type RaBill, type Vendor, type WorkOrder,
} from '../../domain'
import { inr } from '../../format'
import { rows, useLoad } from '../../fees/useLoad'
import { duplicateVendor, telHref, vendorStats, whatsappDigits } from '../../fees/vendors'
import { go, useProjects } from '../../hooks'
import { supabase } from '../../supabase'
import { isOwner, useTeam } from '../../team'
import { errorText } from './parts'

type VendorData = { vendors: Vendor[]; workOrders: WorkOrder[]; bills: RaBill[]; quotes: Quote[]; procurement: ProcurementItem[] }

async function loadVendors(): Promise<VendorData> {
  const [v, w, b, q, p] = await Promise.all([
    supabase.from('vendors').select(VENDOR_SELECT).order('name'),
    supabase.from('work_orders').select(WORK_ORDER_SELECT),
    supabase.from('ra_bills').select(RA_BILL_SELECT),
    supabase.from('quotes').select(QUOTE_SELECT),
    supabase.from('procurement_items').select(PROCUREMENT_SELECT),
  ])
  return {
    vendors: rows<Vendor>(v),
    workOrders: rows<WorkOrder>(w),
    bills: rows<RaBill>(b),
    quotes: rows<Quote>(q),
    procurement: rows<ProcurementItem>(p),
  }
}

const KIND_LABEL: Record<Vendor['kind'], string> = { agency: 'Agency', supplier: 'Supplier', consultant: 'Consultant' }
type Form = { name: string; kind: Vendor['kind']; trade: string; contact_name: string; phone: string; email: string; gstin: string; notes: string }
const blank: Form = { name: '', kind: 'agency', trade: '', contact_name: '', phone: '', email: '', gstin: '', notes: '' }
const toForm = (v: Vendor): Form => ({
  name: v.name, kind: v.kind, trade: v.trade ?? '', contact_name: v.contact_name ?? '', phone: v.phone ?? '', email: v.email ?? '', gstin: v.gstin ?? '', notes: v.notes ?? '',
})

/** Vendor directory (team): agencies, suppliers and consultants with their bills and delivery record. */
export default function Vendors() {
  const { me } = useTeam()
  const owner = isOwner(me)
  const { projects } = useProjects()
  const load = useLoad<VendorData>('vendors', loadVendors)
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<Vendor['kind'] | 'all' | 'archived'>('all')
  const [open, setOpen] = useState<string | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const data = load.data
  const readOnly = load.state !== 'ready'

  const all = data?.vendors ?? []
  const needle = q.trim().toLowerCase()
  const shown = all.filter(
    (v) =>
      (kind === 'archived' ? v.archived : !v.archived && (kind === 'all' || v.kind === kind)) &&
      (!needle || [v.name, v.trade, v.contact_name, v.phone].some((x) => (x ?? '').toLowerCase().includes(needle))),
  )
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'Removed project'

  async function save() {
    if (!form) return
    setError(null)
    const name = form.name.trim()
    if (!name) return setError('Enter the vendor’s name.')
    if (duplicateVendor(name, all, editing ?? undefined)) return setError(`A vendor called “${name}” already exists. Search for it instead.`)
    const row = {
      name, kind: form.kind, trade: form.trade.trim() || null, contact_name: form.contact_name.trim() || null, phone: form.phone.trim() || null,
      email: form.email.trim() || null, gstin: form.gstin.trim().toUpperCase() || null, notes: form.notes.trim(),
    }
    setBusy(true)
    const { error: e } = editing ? await supabase.from('vendors').update(row).eq('id', editing) : await supabase.from('vendors').insert(row)
    setBusy(false)
    if (e) return setError((e as { code?: string }).code === '23505' ? `A vendor called “${name}” already exists.` : errorText(e))
    setForm(null)
    setEditing(null)
    await load.reload()
  }

  async function archive(v: Vendor, archived: boolean) {
    setError(null)
    const { error: e } = await supabase.from('vendors').update({ archived }).eq('id', v.id)
    if (e) return setError(errorText(e))
    await load.reload()
  }

  const formView = form && (
    <div className="card stack-tight fees-form" aria-label={editing ? 'Edit vendor' : 'Add vendor'}>
      <label className="field">
        <span>Name</span>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </label>
      <div className="chips" role="group" aria-label="Vendor kind">
        {VENDOR_KINDS.map((k) => (
          <button key={k} type="button" className={form.kind === k ? 'chip on' : 'chip'} aria-pressed={form.kind === k} onClick={() => setForm({ ...form, kind: k })}>
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <div className="two">
        <label className="field">
          <span>Trade</span>
          <input value={form.trade} onChange={(e) => setForm({ ...form, trade: e.target.value })} />
        </label>
        <label className="field">
          <span>Contact name</span>
          <input value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} />
        </label>
      </div>
      <div className="two">
        <label className="field">
          <span>Phone</span>
          <input type="tel" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </label>
        <label className="field">
          <span>Email</span>
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </label>
      </div>
      <label className="field">
        <span>GSTIN</span>
        <input value={form.gstin} autoCapitalize="characters" onChange={(e) => setForm({ ...form, gstin: e.target.value })} />
      </label>
      <label className="field">
        <span>Notes</span>
        <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button type="button" className="primary" disabled={busy} onClick={save}>
          {editing ? 'Save' : 'Add vendor'}
        </button>
        <button type="button" className="secondary" onClick={() => { setForm(null); setEditing(null); setError(null) }}>
          Cancel
        </button>
      </div>
    </div>
  )

  return (
    <main className="screen fees">
      <header className="topbar">
        <div>
          <button type="button" className="link back" onClick={() => go('/studio')}>
            Studio
          </button>
          <h1>Vendors</h1>
        </div>
        {!readOnly && !form && (
          <button type="button" className="pill" onClick={() => { setEditing(null); setError(null); setForm({ ...blank }) }}>
            Add
          </button>
        )}
      </header>
      {readOnly && <p className="notice">No signal. Showing vendors as last seen on this phone (read-only).</p>}
      {load.error && <p className="error">{load.error}</p>}
      {!editing && formView}

      <label className="field">
        <span>Search</span>
        <input type="search" value={q} placeholder="Name, trade, contact or phone" onChange={(e) => setQ(e.target.value)} />
      </label>
      <div className="chips" role="group" aria-label="Vendor kind filter">
        {(['all', ...VENDOR_KINDS, 'archived'] as const).map((k) => (
          <button key={k} type="button" className={kind === k ? 'chip on' : 'chip'} aria-pressed={kind === k} onClick={() => setKind(k)}>
            {k === 'all' ? 'All' : k === 'archived' ? 'Archived' : KIND_LABEL[k]}
          </button>
        ))}
      </div>

      {!data && load.state === 'loading' && <p className="muted">Loading</p>}
      {!data && load.state === 'offline' && <p className="notice">No signal. Vendors have not been opened on this phone yet.</p>}
      {data && shown.length === 0 && <p className="muted">{all.length ? 'No vendors match.' : 'No vendors yet. Add the agencies and suppliers you work with.'}</p>}
      {error && !form && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <ul className="rows">
        {data &&
          shown.map((v) => {
            const s = vendorStats(v.id, data)
            const wa = whatsappDigits(v.phone)
            const isOpen = open === v.id
            if (editing === v.id) return <li key={v.id}>{formView}</li>
            return (
              <li key={v.id} className="fees-vendor">
                <button type="button" className="row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : v.id)}>
                  <span className="row-line">
                    <span className="row-title">{v.name}</span>
                    <span className="tag muted">{KIND_LABEL[v.kind]}</span>
                  </span>
                  <span className="muted small">
                    {[v.trade, v.contact_name].filter(Boolean).join(' · ') || 'No trade or contact yet'}
                    {s.unpaidBills ? ` · ${s.unpaidBills} bill${s.unpaidBills === 1 ? '' : 's'} awaiting client payment` : ''}
                  </span>
                </button>
                {isOpen && (
                  <div className="stack-tight fees-vendor-detail">
                    <dl className="fees-stats">
                      <div><dt>Projects</dt><dd data-testid="v-projects">{s.projectIds.length}</dd></div>
                      <div><dt>Work orders</dt><dd data-testid="v-wo">{inr(s.workOrderTotal)}</dd></div>
                      <div><dt>Certified</dt><dd data-testid="v-cert">{inr(s.certified)}</dd></div>
                      <div><dt>Paid</dt><dd data-testid="v-paid">{inr(s.paid)}</dd></div>
                      <div><dt>Client-approved, unpaid</dt><dd data-testid="v-unpaid">{s.unpaidBills ? `${inr(s.unpaidAmount)} (${s.unpaidBills})` : '—'}</dd></div>
                      <div><dt>Quotes</dt><dd data-testid="v-quotes">{s.quotes}</dd></div>
                      <div><dt>On time</dt><dd data-testid="v-ontime">{s.onTimePct === null ? 'no record' : `${s.onTimePct}% of ${s.delivered}`}</dd></div>
                    </dl>
                    {s.projectIds.length > 0 && <p className="muted small">{s.projectIds.map(projectName).join(', ')}</p>}
                    {(v.phone || v.email || v.gstin) && (
                      <p className="small">
                        {[v.phone, v.email, v.gstin ? `GSTIN ${v.gstin}` : null].filter(Boolean).join(' · ')}
                      </p>
                    )}
                    {v.notes && <p className="small muted">{v.notes}</p>}
                    <div className="fees-actions">
                      {v.phone && (
                        <a className="pill fees-link" href={telHref(v.phone)}>
                          Call
                        </a>
                      )}
                      {wa && (
                        <a className="pill fees-link" href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer">
                          WhatsApp
                        </a>
                      )}
                      {!readOnly && (
                        <button type="button" className="pill" onClick={() => { setError(null); setEditing(v.id); setForm(toForm(v)) }}>
                          Edit
                        </button>
                      )}
                      {!readOnly && owner && (
                        <button type="button" className="pill" onClick={() => archive(v, !v.archived)}>
                          {v.archived ? 'Restore' : 'Archive'}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            )
          })}
      </ul>
    </main>
  )
}
