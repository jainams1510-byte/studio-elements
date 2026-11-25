import { useEffect, useState } from 'react'
import { cacheGet, cacheSet } from '../../db'
import { cleanSlides } from '../../deck/deck'
import { reviewChecks, type Fix, type ReviewInput } from '../../deck/review'
import { BOQ_SELECT, BRIEF_SELECT, PROPOSAL_SELECT, type BoqItem, type FeeProposal, type ProjectBrief } from '../../domain'
import { go } from '../../hooks'
import { supabase } from '../../supabase'
import { isOwner, useTeam } from '../../team'

type Loaded = Omit<ReviewInput, 'owner'>

const FIX_LABEL: Record<Fix, string> = { edit: 'Edit', money: 'Money', fees: 'Fees', deck: 'Deck', settings: 'Settings' }

/** Project → Review: "Review before export". */
export default function ReviewTab({ projectId }: { projectId: string }) {
  const { me } = useTeam()
  const owner = isOwner(me)
  const [data, setData] = useState<Loaded | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'offline'>('loading')
  const cacheKey = `review:${projectId}:${owner ? 'o' : 't'}`

  useEffect(() => {
    let live = true
    cacheGet<Loaded>(cacheKey).then((c) => {
      if (live && c) {
        setData((d) => d ?? c)
        setState((x) => (x === 'loading' ? 'ready' : x))
      }
    })
    ;(async () => {
      const [p, b, boq, st, deck, prop] = await Promise.all([
        supabase.from('projects').select('name, rooms').eq('id', projectId).maybeSingle(),
        supabase.from('project_briefs').select(BRIEF_SELECT).eq('project_id', projectId).maybeSingle(),
        supabase.from('boq_items').select(BOQ_SELECT).eq('project_id', projectId),
        supabase.from('studio_settings').select('clauses').eq('id', 1).maybeSingle(),
        supabase.from('project_decks').select('slides, key_plan_path').eq('project_id', projectId).maybeSingle(),
        owner
          ? supabase.from('fee_proposals').select(PROPOSAL_SELECT).eq('project_id', projectId).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ])
      if (!live) return
      if (p.error || b.error || boq.error || st.error || deck.error || prop.error) {
        setState('offline')
        return
      }
      const d = deck.data as { slides: unknown; key_plan_path: string | null } | null
      const slides = d ? cleanSlides(d.slides) : []
      const next: Loaded = {
        project: (p.data as { name: string; rooms: string[] } | null) ?? null,
        brief: (b.data as unknown as ProjectBrief | null) ?? null,
        boq: ((boq.data as unknown as BoqItem[] | null) ?? []).filter((l) => !l.removed_at),
        proposal: (prop.data as unknown as FeeProposal | null) ?? null,
        clauses: ((st.data as { clauses: Record<string, string> } | null)?.clauses as Record<string, string>) ?? {},
        deck: d && slides.length ? { slides, key_plan_path: d.key_plan_path } : null,
      }
      setData(next)
      setState('ready')
      void cacheSet(cacheKey, next)
    })()
    return () => {
      live = false
    }
  }, [projectId, owner, cacheKey])

  if (!data) return state === 'offline' ? <p className="notice">No signal. The review has not been opened on this phone yet.</p> : <p className="muted">Loading</p>

  const checks = reviewChecks({ ...data, owner })
  const problems = checks.filter((c) => c.level !== 'ok')
  const notes = checks.filter((c) => c.level === 'ok')
  const bad = problems.filter((c) => c.level === 'bad').length
  const where = (f: Fix) => (f === 'settings' ? '/settings' : f === 'edit' ? `/project/${projectId}/edit` : `/project/${projectId}/${f}`)

  return (
    <section className="stack dk-review">
      <div className="dk-head">
        <h2 className="dk-title">Review before export</h2>
        <p className="muted small">
          {problems.length
            ? `${bad} to fix, ${problems.length - bad} to check. Exports carry placeholders where information is missing.`
            : 'Everything the exports need is filled in.'}
        </p>
      </div>
      {state === 'offline' && <p className="notice">No signal. Showing the review as last seen on this phone.</p>}
      <ul className="dk-checks" aria-label="Review results">
        {problems.map((c, i) => (
          <li key={i} className={`dk-check ${c.level}`}>
            <span className="dk-check-text">
              <span className="sr">{c.level === 'bad' ? 'Must fix: ' : 'Check: '}</span>
              {c.text}
            </span>
            {c.fix && (
              <button type="button" className="link dk-fix" onClick={() => go(where(c.fix!))}>
                {FIX_LABEL[c.fix]}
              </button>
            )}
          </li>
        ))}
        {!problems.length && <li className="dk-check ok">No warnings.</li>}
        {notes.map((c, i) => (
          <li key={`n${i}`} className="dk-check note">{c.text}</li>
        ))}
      </ul>
      <p className="muted small">
        Reference note: the proposal’s reference text called Studio Elements Mumbai-based and left “[City]” for jurisdiction. Review every
        export before sending; nothing is sent from the app.
      </p>
    </section>
  )
}
