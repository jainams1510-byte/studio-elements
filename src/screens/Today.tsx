import { useEffect, useState } from 'react'
import { BACKUP_EVERY_DAYS, lastBackup } from '../backup'
import { loadVoiceLogs, stateOf } from '../ai'
import { needsAttention, siteStatus, siteStatusText, todayLocal } from '../drawings'
import { go, useOutboxTick } from '../hooks'
import { HEALTH_LABEL, type Health } from '../portfolio'
import { listOutbox, syncOutbox } from '../queue'
import { reportDue, weekStart } from '../review'
import { remote, supabase } from '../supabase'
import { isOwner, useTeam } from '../team'
import { useOpenDrafts, usePortfolio } from '../usePortfolio'
import { HandoverChart, ProjectCard } from './PortfolioParts'

type RecentLog = {
  id: string
  note: string
  room: string | null
  trade: string | null
  audio_path: string | null
  logged_at: string
  project_id: string
  profiles: { full_name: string } | null
  site_log_photos: { id: string; removed_at?: string | null }[]
}

type Change = { id: string; project_id: string; kind: string; after: Record<string, unknown> | null; reason: string | null; changed_at: string }
type Activity = { at: string; project: string; text: string; go: string }

const dateFormat = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
const timeFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const dayFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' })

const CHANGE_TEXT: Record<string, string> = {
  added: 'Task added',
  changed: 'Task changed',
  removed: 'Task removed',
  restored: 'Task restored',
  baseline: 'Baseline frozen',
  rebaseline: 'Re-baselined',
  calendar: 'Calendar changed',
}

export default function Today({ outbox, online }: { outbox: number; online: boolean }) {
  const { projects, states, drafts, drawings, error } = usePortfolio()
  const openDrafts = useOpenDrafts(drafts)
  const tick = useOutboxTick()
  const [recent, setRecent] = useState<RecentLog[]>([])
  const [changes, setChanges] = useState<Change[]>([])
  const [syncing, setSyncing] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [toReview, setToReview] = useState(0)
  const [approvedThisWeek, setApprovedThisWeek] = useState<Set<string> | null>(null)
  const [backupAge, setBackupAge] = useState<number | null | undefined>(undefined)
  const { me } = useTeam()
  const owner = isOwner(me)

  useEffect(() => {
    let live = true
    loadVoiceLogs()
      .then((list) => {
        if (live) setToReview(list.filter((l) => !['verified', 'rejected'].includes(stateOf(l))).length)
      })
      .catch(() => undefined)
    if (reportDue()) {
      supabase
        .from('weekly_reports')
        .select('project_id')
        .eq('week_start', weekStart())
        .eq('kind', 'client')
        .eq('status', 'approved')
        .then(({ data }) => {
          if (live && data) setApprovedThisWeek(new Set(data.map((r) => r.project_id as string)))
        })
    }
    return () => {
      live = false
    }
  }, [tick])

  useEffect(() => {
    let live = true
    supabase
      .from('site_logs')
      .select('id, note, room, trade, audio_path, logged_at, project_id, profiles(full_name), site_log_photos(id, removed_at)')
      .is('removed_at', null)
      .order('logged_at', { ascending: false })
      .limit(10)
      .then(({ data }) => {
        if (!live || !data) return
        const list = data as unknown as RecentLog[]
        setRecent(list.map((l) => ({ ...l, site_log_photos: (l.site_log_photos ?? []).filter((ph) => !ph.removed_at) })))
      })
    supabase
      .from('schedule_changes')
      .select('id, project_id, kind, after, reason, changed_at')
      .order('changed_at', { ascending: false })
      .limit(10)
      .then(({ data }) => {
        if (live && data) setChanges(data as Change[])
      })
    return () => {
      live = false
    }
  }, [tick])

  useEffect(() => {
    if (!owner) return
    let live = true
    lastBackup().then(
      (last) => {
        if (live) setBackupAge(last ? Math.floor((Date.now() - Date.parse(last.made_at)) / 86_400_000) : null)
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [owner])

  useEffect(() => {
    // Show why a log is stuck, but only when there is signal to blame.
    listOutbox().then((entries) => {
      const stuck = entries.find((e) => e.lastError)
      setUploadError(online && stuck ? stuck.lastError : null)
    })
  }, [tick, online])

  async function uploadNow() {
    setSyncing(true)
    await syncOutbox(remote)
    setSyncing(false)
  }

  const today = todayLocal()
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'Project'
  const activeIds = new Set(projects.map((p) => p.id))
  const prints = drawings
    .filter((d) => activeIds.has(d.project_id))
    .map((d) => ({ d, status: siteStatus(d) }))
    .filter(({ status }) => needsAttention(status))
  const reportsDue = approvedThisWeek ? projects.filter((p) => !approvedThisWeek.has(p.id)) : []
  const backupDue = owner && online && backupAge !== undefined && (backupAge === null || backupAge >= BACKUP_EVERY_DAYS)
  const risky = states.filter((s) => s.health === 'late' || s.health === 'risk')
  const count = (h: Health) => states.filter((s) => s.health === h).length
  const overdue = states.reduce((a, s) => a + s.overdue.length, 0)
  const worst = [...risky].sort((a, b) => (a.health === b.health ? b.reasons.length - a.reasons.length : a.health === 'late' ? -1 : 1))[0]

  // Latest activity across the studio: logs, revisions, issues and schedule changes.
  const activity: Activity[] = [
    ...recent.map((l) => ({
      at: l.logged_at,
      project: projectName(l.project_id),
      text:
        `Site log${l.room ? `, ${l.room}` : ''}${l.trade ? `, ${l.trade}` : ''}` +
        (l.note ? `: ${l.note}` : '') +
        (l.site_log_photos.length ? ` · ${l.site_log_photos.length} ${l.site_log_photos.length === 1 ? 'photo' : 'photos'}` : '') +
        (l.audio_path ? ' · voice note' : '') +
        (l.profiles?.full_name ? ` · ${l.profiles.full_name}` : ''),
      go: `/project/${l.project_id}`,
    })),
    ...drawings
      .filter((d) => activeIds.has(d.project_id))
      .flatMap((d) =>
        d.drawing_revisions.flatMap((r) => [
          { at: r.created_at, project: projectName(d.project_id), text: `${d.number} revised to ${r.code}${r.note ? `: ${r.note}` : ''}`, go: `/drawing/${d.id}` },
          ...r.drawing_issues.map((i) => ({
            at: i.created_at,
            project: projectName(d.project_id),
            text: `${d.number} ${r.code} issued to ${i.issued_to} by ${i.method}`,
            go: `/drawing/${d.id}`,
          })),
        ]),
      ),
    ...changes
      .filter((c) => activeIds.has(c.project_id))
      .map((c) => ({
        at: c.changed_at,
        project: projectName(c.project_id),
        text: `${CHANGE_TEXT[c.kind] ?? c.kind}${c.after?.name ? `: ${String(c.after.name)}` : ''}${c.reason ? ` (${c.reason})` : ''}`,
        go: `/project/${c.project_id}/schedule`,
      })),
  ]
    .filter((a) => a.at)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 12)

  const anyFlags = prints.length > 0 || toReview > 0 || reportsDue.length > 0 || risky.length > 0 || backupDue || openDrafts.length > 0

  return (
    <main className="screen">
      <header className="topbar">
        <div>
          <span className="muted small">{dateFormat.format(new Date())}</span>
          <h1>Today</h1>
        </div>
        <button type="button" className="pill" onClick={uploadNow} disabled={outbox === 0 || syncing || !online}>
          {outbox === 0 ? 'All uploaded' : syncing ? 'Uploading' : `${outbox} to upload`}
        </button>
      </header>

      {!online && <p className="notice">No signal. Logs are saved on this phone and upload when you reopen the app online.</p>}
      {uploadError && <p className="error" role="alert">A log could not upload: {uploadError}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {projects.length > 0 && (
        <section className="brief">
          <p>
            {projects.length} active project{projects.length === 1 ? '' : 's'}
            {states.some((s) => s.health !== 'none')
              ? `: ${count('ok')} on track, ${count('risk')} at risk, ${count('late')} delayed.`
              : '. No schedules yet.'}
            {worst ? ` Biggest concern: ${worst.project.name}, ${worst.reasons[0] ?? HEALTH_LABEL[worst.health].toLowerCase()}.` : ''}
          </p>
          <div className="tiles">
            <button type="button" className="tile-k" onClick={() => go('/drafts')}>
              <b>{openDrafts.length}</b>
              <span>Drafts to send</span>
            </button>
            <button type="button" className="tile-k" onClick={() => go('/projects')}>
              <b>{overdue}</b>
              <span>Overdue tasks</span>
            </button>
            <button type="button" className="tile-k" onClick={() => go('/review')}>
              <b>{toReview}</b>
              <span>Voice notes to review</span>
            </button>
          </div>
        </section>
      )}

      {anyFlags && (
        <section>
          <h2>Needs you</h2>
          <ul className="rows">
            {openDrafts.length > 0 && (
              <li>
                <button type="button" className="row flagrow" onClick={() => go('/drafts')}>
                  <span className="dot" aria-hidden="true" />
                  <span className="stack-tight">
                    <span className="row-title">{openDrafts.length === 1 ? '1 draft ready to send' : `${openDrafts.length} drafts ready to send`}</span>
                    <span className="muted small">Check, edit and share them yourself</span>
                  </span>
                </button>
              </li>
            )}
            {risky.map((s) => (
              <li key={`risk-${s.project.id}`}>
                <button type="button" className="row flagrow" onClick={() => go(`/project/${s.project.id}/schedule`)}>
                  <span className="dot" aria-hidden="true" />
                  <span className="stack-tight">
                    <span className="row-title">{s.health === 'late' ? 'Schedule delayed' : 'Schedule at risk'}</span>
                    <span className="muted small">
                      {s.project.name} · {s.reasons.join(' · ')}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {backupDue && (
              <li>
                <button type="button" className="row flagrow" onClick={() => go('/projects')}>
                  <span className="dot" aria-hidden="true" />
                  <span className="stack-tight">
                    <span className="row-title">Backup due</span>
                    <span className="muted small">{backupAge === null ? 'No backup made yet' : `Last one ${backupAge} days ago`} · download it on the Projects page</span>
                  </span>
                </button>
              </li>
            )}
            {toReview > 0 && (
              <li>
                <button type="button" className="row flagrow" onClick={() => go('/review')}>
                  <span className="dot" aria-hidden="true" />
                  <span className="stack-tight">
                    <span className="row-title">{toReview === 1 ? '1 voice note to review' : `${toReview} voice notes to review`}</span>
                    <span className="muted small">AI summaries need two people to confirm</span>
                  </span>
                </button>
              </li>
            )}
            {reportsDue.map((p) => (
              <li key={`report-${p.id}`}>
                <button type="button" className="row flagrow" onClick={() => go(`/project/${p.id}/reports`)}>
                  <span className="dot" aria-hidden="true" />
                  <span className="stack-tight">
                    <span className="row-title">Weekly report due</span>
                    <span className="muted small">{p.name} · draft, check and approve</span>
                  </span>
                </button>
              </li>
            ))}
            {prints.map(({ d, status }) => (
              <li key={d.id}>
                <button type="button" className="row flagrow" onClick={() => go(`/drawing/${d.id}`)}>
                  <span className="dot" aria-hidden="true" />
                  <span className="stack-tight">
                    <span className="row-title">{status.kind === 'outdated' ? 'Site print is out of date' : 'Preliminary print on site'}</span>
                    <span className="muted small">
                      {projectName(d.project_id)} · {d.number} · {siteStatusText(status)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {states.some((s) => s.finish) && (
        <section>
          <h2>Forecast handovers</h2>
          <HandoverChart states={states} today={today} />
        </section>
      )}

      <section>
        <h2>Projects</h2>
        {projects.length === 0 && (
          <p className="muted">
            No projects yet.{' '}
            <button type="button" className="link" onClick={() => go('/projects')}>
              Add the first one
            </button>
          </p>
        )}
        <ul className="rows">
          {states.map((s) => (
            <ProjectCard key={s.project.id} s={s} />
          ))}
        </ul>
      </section>

      <section>
        <h2>Latest activity</h2>
        {activity.length === 0 && <p className="muted">Nothing logged yet.</p>}
        <ul className="rows">
          {activity.map((a, i) => (
            <li key={`${a.at}-${i}`}>
              <button type="button" className="row" onClick={() => go(a.go)}>
                <span className="row-line">
                  <span className="row-title small-title">{a.project}</span>
                  <span className="muted small nowrap">{a.at.length > 10 ? timeFormat.format(new Date(a.at)) : dayFormat.format(new Date(a.at))}</span>
                </span>
                <span className="small">{a.text}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
