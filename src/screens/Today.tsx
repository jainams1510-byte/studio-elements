import { useEffect, useState } from 'react'
import { BACKUP_EVERY_DAYS, lastBackup } from '../backup'
import { DRAWING_SELECT, needsAttention, siteStatus, siteStatusText, todayLocal, type Drawing } from '../drawings'
import { loadVoiceLogs, stateOf } from '../ai'
import { go, useOutboxTick, useProjects } from '../hooks'
import { reportDue, weekStart } from '../review'
import { listOutbox, syncOutbox } from '../queue'
import { remote, supabase } from '../supabase'
import { SCHEDULE_SELECT, TASK_SELECT, type ScheduleSettings, type Task } from '../schedule'
import { isOwner, useTeam } from '../team'
import { STAGES } from '../types'
import { projectRisk, riskText } from '../useSchedule'

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

const dateFormat = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
const timeFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

export default function Today({ outbox, online }: { outbox: number; online: boolean }) {
  const { projects, error } = useProjects()
  const tick = useOutboxTick()
  const [recent, setRecent] = useState<RecentLog[]>([])
  const [syncing, setSyncing] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [drawings, setDrawings] = useState<Drawing[]>([])
  const [toReview, setToReview] = useState(0)
  const [approvedThisWeek, setApprovedThisWeek] = useState<Set<string> | null>(null)
  const [schedules, setSchedules] = useState<{ settings: ScheduleSettings[]; tasks: Task[] } | null>(null)
  const [backupAge, setBackupAge] = useState<number | null | undefined>(undefined)
  const { me } = useTeam()
  const owner = isOwner(me)

  useEffect(() => {
    let live = true
    Promise.all([supabase.from('project_schedules').select(SCHEDULE_SELECT), supabase.from('tasks').select(TASK_SELECT).is('removed_at', null)]).then(
      ([s, t]) => {
        if (live && !s.error && !t.error) setSchedules({ settings: (s.data ?? []) as ScheduleSettings[], tasks: (t.data ?? []) as unknown as Task[] })
      },
    )
    return () => {
      live = false
    }
  }, [])

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
      .from('drawings')
      .select(DRAWING_SELECT)
      .eq('archived', false)
      .then(({ data }) => {
        if (live && data) setDrawings(data as unknown as Drawing[])
      })
    return () => {
      live = false
    }
  }, [])

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
        setRecent(list.map((l) => ({ ...l, site_log_photos: l.site_log_photos.filter((ph) => !ph.removed_at) })))
      })
    return () => {
      live = false
    }
  }, [tick])

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

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'Project'

  // Prints on site that are out of date or not for construction, on active projects only.
  const activeIds = new Set(projects.map((p) => p.id))
  const flags = drawings
    .filter((d) => activeIds.has(d.project_id))
    .map((d) => ({ d, status: siteStatus(d) }))
    .filter(({ status }) => needsAttention(status))
  const reportsDue = approvedThisWeek ? projects.filter((p) => !approvedThisWeek.has(p.id)) : []
  const today = todayLocal()
  const risks = schedules
    ? projects
        .map((p) => {
          const settings = schedules.settings.find((x) => x.project_id === p.id)
          if (!settings) return null
          const risk = projectRisk(settings, schedules.tasks.filter((t) => t.project_id === p.id), drawings.filter((d) => d.project_id === p.id), today)
          return risk ? { project: p, risk } : null
        })
        .filter((x) => x !== null)
    : []
  const backupDue = owner && online && backupAge !== undefined && (backupAge === null || backupAge >= BACKUP_EVERY_DAYS)
  const anyFlags = flags.length > 0 || toReview > 0 || reportsDue.length > 0 || risks.length > 0 || backupDue

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

      {anyFlags && (
        <section>
          <h2>Needs you</h2>
          <ul className="rows">
            {risks.map(({ project, risk }) => (
              <li key={`risk-${project.id}`}>
                <button type="button" className="row flagrow" onClick={() => go(`/project/${project.id}/schedule`)}>
                  <span className="dot" aria-hidden="true" />
                  <span className="stack-tight">
                    <span className="row-title">Schedule at risk</span>
                    <span className="muted small">
                      {project.name} · {riskText(risk)}
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
            {flags.map(({ d, status }) => (
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
          {projects.map((p) => (
            <li key={p.id}>
              <button type="button" className="row" onClick={() => go(`/project/${p.id}`)}>
                <span className="row-title">{p.name}</span>
                <span className="stagebar" aria-hidden="true">
                  {STAGES.map((_, i) => (
                    <span key={i} className={i + 1 < p.stage ? 'done' : i + 1 === p.stage ? 'now' : ''} />
                  ))}
                </span>
                <span className="muted small">
                  Stage {p.stage} of 8 · {STAGES[p.stage - 1]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Latest site logs</h2>
        {recent.length === 0 && <p className="muted">Nothing logged yet.</p>}
        <ul className="rows">
          {recent.map((log) => (
            <li key={log.id}>
              <button type="button" className="row" onClick={() => go(`/project/${log.project_id}`)}>
                <span className="row-title">
                  {projectName(log.project_id)}
                  {log.room ? ` · ${log.room}` : ''}
                  {log.trade ? ` · ${log.trade}` : ''}
                </span>
                {log.note && <span>{log.note}</span>}
                <span className="muted small">
                  {timeFormat.format(new Date(log.logged_at))}
                  {log.profiles?.full_name ? ` · ${log.profiles.full_name}` : ''}
                  {log.site_log_photos.length
                    ? ` · ${log.site_log_photos.length} ${log.site_log_photos.length === 1 ? 'photo' : 'photos'}`
                    : ''}
                  {log.audio_path ? ' · voice note' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
