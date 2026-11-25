import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { saveFile } from '../../backup'
import { friendly, useCalendarData, type CalendarRaw } from '../../decisions/data'
import {
  buildCalendarEntries,
  buildIcs,
  dayLabel,
  ENTRY_LABEL,
  ENTRY_TAG,
  ENTRY_TYPES,
  filterEntries,
  groupByDay,
  icsWindow,
  monthGrid,
  mergeReports,
  monthLabel,
  weekStartOf,
  type CalendarEntry,
  type EntryType,
  type ProjectCalendarData,
} from '../../decisions/logic'
import type { SiteVisit } from '../../domain'
import { todayLocal } from '../../drawings'
import { go, useProjects } from '../../hooks'
import { formatDay, shiftDays, WEEKDAYS } from '../../schedule'
import { supabase } from '../../supabase'
import { isOwner, useTeam } from '../../team'
import type { Project } from '../../types'

const AHEAD_DAYS = 90

function useWide(): boolean {
  const query = '(min-width: 900px)'
  const [wide, setWide] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setWide(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return wide
}

function perProject(projects: Project[], raw: CalendarRaw | null): ProjectCalendarData[] {
  if (!raw) return []
  return projects.map((p) => {
    const mine = <T extends { project_id: string }>(rows: T[]) => rows.filter((r) => r.project_id === p.id)
    return {
      project: { id: p.id, name: p.name },
      settings: raw.settings.find((s) => s.project_id === p.id) ?? null,
      tasks: mine(raw.tasks),
      drawings: mine(raw.drawings),
      procurement: mine(raw.procurement),
      visits: mine(raw.visits),
      invoices: mine(raw.invoices),
      bills: mine(raw.bills),
      decisions: mine(raw.decisions),
    }
  })
}

export default function Calendar() {
  const { projects } = useProjects()
  const { raw, offline, fresh, reload } = useCalendarData()
  const { me } = useTeam()
  const owner = isOwner(me)
  const wide = useWide()
  const today = todayLocal()
  const [types, setTypes] = useState<Set<EntryType>>(() => new Set(ENTRY_TYPES))
  const [projectId, setProjectId] = useState<string>('all')
  const [past, setPast] = useState(false)
  const [month, setMonth] = useState(() => ({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) }))
  const [selected, setSelected] = useState(today)
  const [visit, setVisit] = useState<SiteVisit | 'new' | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const data = useMemo(() => perProject(projects, raw), [projects, raw])
  const vendorNames = useMemo(() => Object.fromEntries((raw?.vendors ?? []).map((v) => [v.id, v.name])), [raw])
  const grid = useMemo(() => monthGrid(month.y, month.m), [month])
  // One range covers the agenda (past week + 90 days ahead) and the month on show.
  const from = [shiftDays(today, -7), grid[0][0]].sort()[0]
  const to = [shiftDays(today, AHEAD_DAYS), grid[grid.length - 1][6]].sort()[1]
  const all = useMemo(() => buildCalendarEntries(data, vendorNames, from, to, today), [data, vendorNames, from, to, today])
  const entries = mergeReports(filterEntries(all, { types, projectId }))
  const visits = (raw?.visits ?? []).filter((v) => projects.some((p) => p.id === v.project_id))
  const removedVisits = visits.filter((v) => v.removed_at)

  function toggle(t: EntryType) {
    const next = new Set(types)
    if (next.has(t)) next.delete(t)
    else next.add(t)
    setTypes(next)
  }

  function open(e: CalendarEntry) {
    if (e.parts) {
      setSelected(e.date) // merged weekly reports: the day list below the grid links each project
      return
    }
    if (e.type === 'visit') {
      const v = visits.find((x) => x.id === e.visitId)
      if (v) setVisit(v)
      return
    }
    if (e.href) go(e.href)
  }

  async function downloadIcs() {
    setNote(null)
    const list = icsWindow(entries, today, AHEAD_DAYS)
    const text = buildIcs(list, new Date())
    try {
      await saveFile(new Blob([text], { type: 'text/calendar;charset=utf-8' }), `studio-elements-calendar-${today}.ics`)
      setNote(`${list.length} entries saved. Open the file to add them to your phone’s calendar.`)
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) setNote('Could not save the file here.')
    }
  }

  async function restoreVisit(v: SiteVisit) {
    const { error } = await supabase.from('site_visits').update({ removed_at: null }).eq('id', v.id)
    if (error) setNote(friendly(error.message, 'Restoring'))
    await reload()
  }

  const shift = (n: number) => setMonth(({ y, m }) => ({ y: y + Math.floor((m - 1 + n) / 12), m: ((((m - 1 + n) % 12) + 12) % 12) + 1 }))

  return (
    <main className="screen cal-screen" data-state={offline ? 'offline' : fresh ? 'ready' : 'stale'}>
      <header className="topbar">
        <div>
          <button type="button" className="link back" onClick={() => go('/studio')}>
            Studio
          </button>
          <h1>Calendar</h1>
        </div>
        {!offline && (
          <button type="button" className="pill" onClick={() => setVisit('new')}>
            Add site visit
          </button>
        )}
      </header>
      {offline && <p className="notice">No signal. Showing the calendar as last seen on this phone. Site visits need a connection to change.</p>}

      <div className="cal-controls">
        <label className="select">
          <span className="sr">Project</span>
          <select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="all">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="chips cal-chips" role="group" aria-label="Entry types">
          {ENTRY_TYPES.map((t) => (
            <button key={t} type="button" className={types.has(t) ? 'chip on' : 'chip'} aria-pressed={types.has(t)} onClick={() => toggle(t)}>
              {t === 'milestone' && <span className="cal-ms" aria-hidden="true" />}
              {ENTRY_LABEL[t]}
            </button>
          ))}
        </div>
      </div>

      {visit && (
        <VisitForm
          visit={visit === 'new' ? null : visit}
          projects={projects}
          defaultProject={projectId === 'all' ? (projects[0]?.id ?? '') : projectId}
          defaultDate={wide ? selected : today}
          owner={owner}
          offline={offline}
          onDone={async () => {
            await reload()
            setVisit(null)
          }}
          onCancel={() => setVisit(null)}
        />
      )}

      {!raw && <p className="muted">Loading</p>}
      {raw && (wide ? (
        <MonthView
          grid={grid}
          month={month}
          today={today}
          entries={entries}
          selected={selected}
          onSelect={setSelected}
          onOpen={open}
          onShift={shift}
          onToday={() => {
            setMonth({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) })
            setSelected(today)
          }}
        />
      ) : (
        <Agenda entries={entries} today={today} past={past} onPast={() => setPast(!past)} onOpen={open} />
      ))}

      <div className="stack-tight">
        <button type="button" className="secondary" onClick={downloadIcs}>
          Add to phone calendar
        </button>
        <p className="muted small">Saves the next {AHEAD_DAYS} days shown by the filters above as a calendar file (.ics) to open on your phone.</p>
        {note && <p className="small">{note}</p>}
      </div>

      {owner && removedVisits.length > 0 && (
        <details>
          <summary className="muted small">Removed site visits ({removedVisits.length})</summary>
          <ul className="rows">
            {removedVisits.map((v) => (
              <li key={v.id} className="row-line padded">
                <span className="small grow">
                  {formatDay(v.visit_on)} {v.purpose}
                </span>
                {!offline && (
                  <button type="button" className="pill" onClick={() => restoreVisit(v)}>
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </main>
  )
}

function EntryButton({ e, onOpen, compact = false }: { e: CalendarEntry; onOpen: (e: CalendarEntry) => void; compact?: boolean }) {
  const ms = e.type === 'milestone'
  if (e.parts && !compact) {
    return (
      <div className="cal-entry" data-type={e.type}>
        <span className="cal-tag">{ENTRY_TAG[e.type]}</span>
        <span className="cal-title">{e.title}</span>
        <span className="muted small">Draft from 5 pm, approve before sharing</span>
        <div className="cal-parts">
          {e.parts.map((x) => (
            <button key={x.projectId} type="button" className="pill" onClick={() => go(x.href)}>
              {x.projectName}
            </button>
          ))}
        </div>
      </div>
    )
  }
  if (compact) {
    return (
      <button type="button" className={ms ? 'cal-pill ms' : 'cal-pill'} title={`${ENTRY_TAG[e.type]}: ${e.title} · ${e.projectName}`} onClick={() => onOpen(e)} data-type={e.type}>
        {ms && <span className="cal-ms" aria-hidden="true" />}
        {e.title}
      </button>
    )
  }
  return (
    <button type="button" className={ms ? 'cal-entry ms' : 'cal-entry'} onClick={() => onOpen(e)} data-type={e.type}>
      <span className="cal-tag">
        {ms && <span className="cal-ms" aria-hidden="true" />}
        {ENTRY_TAG[e.type]}
        {e.time ? ` · ${e.time}` : ''}
      </span>
      <span className="cal-title">{e.title}</span>
      <span className="muted small">
        {e.projectName}
        {e.detail && e.type !== 'visit' ? ` · ${e.detail}` : ''}
      </span>
    </button>
  )
}

function DayBlock({ date, entries, today, onOpen }: { date: string; entries: CalendarEntry[]; today: string; onOpen: (e: CalendarEntry) => void }) {
  const name = date === today ? 'Today' : date === shiftDays(today, 1) ? 'Tomorrow' : date === shiftDays(today, -1) ? 'Yesterday' : null
  return (
    <li className={date === today ? 'cal-day today' : 'cal-day'} data-day={date}>
      <h3 className="cal-dayhead">
        {name && <b>{name}</b>}
        <span>{dayLabel(date)}</span>
      </h3>
      {entries.length === 0 ? (
        <p className="muted small cal-empty">Nothing due.</p>
      ) : (
        <ul className="cal-entries">
          {entries.map((e) => (
            <li key={e.key}>
              <EntryButton e={e} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function weekTitle(monday: string, today: string): string {
  const thisWeek = weekStartOf(today)
  if (monday === thisWeek) return 'This week'
  if (monday === shiftDays(thisWeek, 7)) return 'Next week'
  return `Week of ${formatDay(monday)}`
}

function Agenda({ entries, today, past, onPast, onOpen }: { entries: CalendarEntry[]; today: string; past: boolean; onPast: () => void; onOpen: (e: CalendarEntry) => void }) {
  const groups = groupByDay(entries)
  const before = groups.filter((g) => g.date < today && g.date >= shiftDays(today, -7))
  const todays = groups.find((g) => g.date === today)?.entries ?? []
  const after = groups.filter((g) => g.date > today && g.date <= shiftDays(today, AHEAD_DAYS))
  const weeks: { monday: string; days: typeof after }[] = []
  for (const g of after) {
    const monday = weekStartOf(g.date)
    if (!weeks.length || weeks[weeks.length - 1].monday !== monday) weeks.push({ monday, days: [] })
    weeks[weeks.length - 1].days.push(g)
  }

  return (
    <section className="stack cal-agenda" aria-label="Agenda">
      <button type="button" className="pill cal-past" aria-pressed={past} onClick={onPast}>
        {past ? 'Hide past 7 days' : 'Past 7 days'}
      </button>
      {past && (
        <div className="stack-tight cal-pastlist">
          <h2>Past 7 days</h2>
          {before.length === 0 ? (
            <p className="muted small">Nothing in the past week.</p>
          ) : (
            <ul className="cal-days">
              {before.map((g) => (
                <DayBlock key={g.date} date={g.date} entries={g.entries} today={today} onOpen={onOpen} />
              ))}
            </ul>
          )}
        </div>
      )}
      <ul className="cal-days">
        <DayBlock date={today} entries={todays} today={today} onOpen={onOpen} />
      </ul>
      {weeks.map((w) => (
        <div key={w.monday} className="stack-tight">
          <h2 className="cal-week">{weekTitle(w.monday, today)}</h2>
          <ul className="cal-days">
            {w.days.map((g) => (
              <DayBlock key={g.date} date={g.date} entries={g.entries} today={today} onOpen={onOpen} />
            ))}
          </ul>
        </div>
      ))}
      {weeks.length === 0 && <p className="muted">Nothing in the next {AHEAD_DAYS} days.</p>}
    </section>
  )
}

function MonthView(p: {
  grid: string[][]
  month: { y: number; m: number }
  today: string
  entries: CalendarEntry[]
  selected: string
  onSelect: (d: string) => void
  onOpen: (e: CalendarEntry) => void
  onShift: (n: number) => void
  onToday: () => void
}) {
  const byDay = new Map(groupByDay(p.entries).map((g) => [g.date, g.entries]))
  const prefix = `${p.month.y}-${String(p.month.m).padStart(2, '0')}`
  const chosen = byDay.get(p.selected) ?? []
  return (
    <section className="stack cal-month" aria-label="Month">
      <div className="cal-monthbar">
        <h2 className="cal-monthname">{monthLabel(p.month.y, p.month.m)}</h2>
        <div className="cal-nav">
          <button type="button" className="pill" aria-label="Previous month" onClick={() => p.onShift(-1)}>
            ‹ Prev
          </button>
          <button type="button" className="pill" onClick={p.onToday}>
            Today
          </button>
          <button type="button" className="pill" aria-label="Next month" onClick={() => p.onShift(1)}>
            Next ›
          </button>
        </div>
      </div>
      <div className="cal-grid" role="grid" aria-label={monthLabel(p.month.y, p.month.m)}>
        <div className="cal-row cal-head" role="row">
          {WEEKDAYS.map((d) => (
            <div key={d} role="columnheader" className="cal-wd">
              {d}
            </div>
          ))}
        </div>
        {p.grid.map((week) => (
          <div key={week[0]} className="cal-row" role="row">
            {week.map((d) => {
              const list = byDay.get(d) ?? []
              const cls = ['cal-cell', d.startsWith(prefix) ? '' : 'out', d === p.today ? 'today' : '', d === p.selected ? 'sel' : ''].filter(Boolean).join(' ')
              return (
                <div key={d} role="gridcell" className={cls} data-day={d} aria-current={d === p.today ? 'date' : undefined}>
                  <button type="button" className="cal-num" onClick={() => p.onSelect(d)} aria-label={`${dayLabel(d)}, ${list.length} entries`}>
                    {Number(d.slice(8))}
                  </button>
                  {list.slice(0, 3).map((e) => (
                    <EntryButton key={e.key} e={e} onOpen={p.onOpen} compact />
                  ))}
                  {list.length > 3 && (
                    <button type="button" className="cal-more" onClick={() => p.onSelect(d)}>
                      +{list.length - 3} more
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <div className="stack-tight">
        <h2>{p.selected === p.today ? `Today · ${dayLabel(p.selected)}` : dayLabel(p.selected)}</h2>
        {chosen.length === 0 ? (
          <p className="muted small">Nothing due.</p>
        ) : (
          <ul className="cal-entries">
            {chosen.map((e) => (
              <li key={e.key}>
                <EntryButton e={e} onOpen={p.onOpen} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function VisitForm(p: {
  visit: SiteVisit | null
  projects: Project[]
  defaultProject: string
  defaultDate: string
  owner: boolean
  offline: boolean
  onDone: () => Promise<void> | void
  onCancel: () => void
}) {
  const v = p.visit
  const [date, setDate] = useState(v?.visit_on ?? p.defaultDate)
  const [time, setTime] = useState(v?.visit_time ?? '')
  const [project, setProject] = useState(v?.project_id ?? p.defaultProject)
  const [purpose, setPurpose] = useState(v?.purpose ?? '')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [v?.id])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!date) return setError('Pick the date of the visit.')
    if (!project) return setError('Pick the project.')
    setBusy(true)
    setError(null)
    const fields = { visit_on: date, visit_time: time || null, purpose: purpose.trim() }
    const { error: err } = v
      ? await supabase.from('site_visits').update(fields).eq('id', v.id)
      : await supabase.from('site_visits').insert({ ...fields, id: crypto.randomUUID(), project_id: project })
    if (err) {
      setBusy(false)
      return setError(friendly(err.message, 'Saving a visit'))
    }
    await p.onDone()
  }

  async function remove() {
    if (!v) return
    setBusy(true)
    const { error: err } = await supabase.from('site_visits').update({ removed_at: new Date().toISOString() }).eq('id', v.id)
    if (err) {
      setBusy(false)
      return setError(friendly(err.message, 'Removing'))
    }
    await p.onDone()
  }

  return (
    <form ref={ref} onSubmit={save} className="stack card editor cal-visit">
      <h2>{v ? 'Site visit' : 'Add a site visit'}</h2>
      <div className="two">
        <label className="field">
          <span>Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span>Time</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>Visit project</span>
        <select value={project} disabled={Boolean(v)} onChange={(e) => setProject(e.target.value)}>
          {p.projects.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Purpose</span>
        <input type="text" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Electrical point marking with the agency" />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!p.offline && (
        <div className="button-row">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving' : v ? 'Save visit' : 'Add visit'}
          </button>
          <button type="button" className="secondary" onClick={p.onCancel}>
            Cancel
          </button>
        </div>
      )}
      {p.offline && (
        <button type="button" className="secondary" onClick={p.onCancel}>
          Close
        </button>
      )}
      {v && p.owner && !p.offline && !confirmRemove && (
        <button type="button" className="link left" onClick={() => setConfirmRemove(true)}>
          Remove this visit
        </button>
      )}
      {v && p.owner && confirmRemove && (
        <div className="confirm stack">
          <p className="small">Remove this visit? It can be restored.</p>
          <div className="button-row">
            <button type="button" className="danger" disabled={busy} onClick={remove}>
              Remove
            </button>
            <button type="button" className="secondary" onClick={() => setConfirmRemove(false)}>
              Keep
            </button>
          </div>
        </div>
      )}
    </form>
  )
}
