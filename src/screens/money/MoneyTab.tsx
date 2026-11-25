import { useState } from 'react'
import { useMoney } from '../../money/useMoney'
import { isOwner, useTeam } from '../../team'
import BillsSection from './BillsSection'
import ClientReport from './ClientReport'
import EstimateSection from './EstimateSection'
import QuotesSection from './QuotesSection'
import VariationsSection from './VariationsSection'

const SECTIONS = [
  ['estimate', 'Estimate'],
  ['quotes', 'Quotes & orders'],
  ['bills', 'Bills'],
  ['variations', 'Variations'],
  ['report', 'Client report'],
] as const
type Section = (typeof SECTIONS)[number][0]

/** Project money: estimate/BOQ and its ledger, quotes and work orders, RA bills, variations and the client's budget view. */
export default function MoneyTab({ projectId }: { projectId: string }) {
  const m = useMoney(projectId)
  const { me } = useTeam()
  const owner = isOwner(me)
  const [section, setSection] = useState<Section>(() => (sessionStorage.getItem('money-section') as Section | null) ?? 'estimate')
  const writable = m.state === 'ready'

  function pick(s: Section) {
    setSection(s)
    sessionStorage.setItem('money-section', s)
  }

  const props = { projectId, m, owner, writable }
  return (
    <section className="stack m-money">
      <div className="chips m-sections" role="group" aria-label="Money sections">
        {SECTIONS.map(([id, label]) => (
          <button key={id} type="button" className={section === id ? 'chip on' : 'chip'} aria-pressed={section === id} onClick={() => pick(id)}>
            {label}
          </button>
        ))}
      </div>

      {m.state === 'loading' && <p className="muted">{m.data.project ? 'Updating…' : 'Loading'}</p>}
      {m.state === 'offline' && !m.error && (
        <p className="notice">
          No signal. {m.data.project ? 'Showing the money records as last seen on this phone. Changes need a connection.' : 'The money records have not been opened on this phone yet.'}
        </p>
      )}
      {m.error && (
        <p className="error" role="alert">
          {m.error} {m.data.project ? 'Showing the copy last seen on this phone, read-only.' : ''}
        </p>
      )}

      {(m.state !== 'loading' || m.data.project) && (
        <>
          {section === 'estimate' && <EstimateSection {...props} />}
          {section === 'quotes' && <QuotesSection {...props} />}
          {section === 'bills' && <BillsSection {...props} />}
          {section === 'variations' && <VariationsSection {...props} />}
          {section === 'report' && <ClientReport {...props} />}
        </>
      )}
    </section>
  )
}
