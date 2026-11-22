// Studio Elements: AI server function.
//
// Actions (POST JSON { action, ... }), all for signed-in team members only:
//   health                         -> is the Gemini key set, and which model will be used
//   transcribe { log_id, force? }  -> voice note to transcript + English summary, saved as unverified
//   weekly_report { project_id, week_start, language? } -> client and internal report drafts
//
// Rules: the Gemini key never leaves this function; only voice notes and the typed note
// are sent to Gemini (no photos, no client names); AI output is saved unverified and
// only two-person-verified summaries reach a client report. Nothing is sent to anyone.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { encodeBase64 } from 'jsr:@std/encoding@1/base64'

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta'
const MEDIA_BUCKET = 'site-media'
const SENIOR_ROLES = ['coordinator', 'owner']
const STAGES = ['Concept', 'Design development', 'Working drawings', 'BOQ and tendering', 'Procurement', 'Execution', 'Snagging', 'Handover']

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

function key(jsonEnv: string, legacyEnv: string): string {
  try {
    const parsed = JSON.parse(Deno.env.get(jsonEnv) ?? '{}')
    if (parsed.default) return parsed.default as string
  } catch {
    // fall through to the legacy key
  }
  return Deno.env.get(legacyEnv) ?? ''
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SECRET_KEY = key('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY')

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

// ---------------------------------------------------------------- Gemini

type Model = { name: string; version: number; lite: boolean }
let modelCache: { at: number; models: Model[] } | null = null

/** Flash models this key can use for generateContent, best first. Google retires model names often. */
async function candidateModels(apiKey: string): Promise<Model[]> {
  const override = Deno.env.get('GEMINI_MODEL')
  if (override) return [{ name: override.startsWith('models/') ? override : `models/${override}`, version: 0, lite: false }]
  if (modelCache && Date.now() - modelCache.at < 6 * 3600_000) return modelCache.models
  const res = await fetch(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new HttpError(502, `Gemini would not list models (${res.status}): ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  const models: Model[] = []
  for (const m of data.models ?? []) {
    const match = /^models\/gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/.exec(m.name ?? '')
    if (!match || !(m.supportedGenerationMethods ?? []).includes('generateContent')) continue
    models.push({ name: m.name, version: Number(match[1]), lite: Boolean(match[2]) })
  }
  models.sort((a, b) => b.version - a.version || Number(a.lite) - Number(b.lite))
  if (models.length === 0) throw new HttpError(502, 'No Gemini Flash model is available to this key.')
  modelCache = { at: Date.now(), models }
  return models
}

type Part = { text: string } | { inline_data: { mime_type: string; data: string } }

class GeminiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function generate(apiKey: string, model: string, parts: Part[], schema: unknown): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`${GEMINI}/${model}:generateContent`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.2 },
      }),
    })
  } catch (err) {
    // Google's free service sometimes stalls; treat a stall like "busy" and try the next model.
    throw new GeminiError(504, `No answer from ${model} within 30 seconds (${err instanceof Error ? err.name : 'error'})`)
  }
  const text = await res.text()
  if (!res.ok) throw new GeminiError(res.status, text.slice(0, 400))
  const data = JSON.parse(text)
  const out = data.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? ''
  if (!out) throw new GeminiError(502, `Empty answer (${data.candidates?.[0]?.finishReason ?? 'no reason given'})`)
  return JSON.parse(out)
}

/** Try each model, and for audio each label of the format, until one works. */
async function generateWithFallback(
  apiKey: string,
  build: (mime: string | null) => Part[],
  mimes: (string | null)[],
  schema: unknown,
): Promise<{ result: unknown; model: string; mime: string | null }> {
  const models = await candidateModels(apiKey)
  let last = 'no attempt made'
  // At most three models, so the whole call stays inside the 150-second function limit.
  for (const model of models.slice(0, 3)) {
    for (const mime of mimes) {
      try {
        const result = await generate(apiKey, model.name, build(mime), schema)
        return { result, model: model.name.replace('models/', ''), mime }
      } catch (err) {
        last = err instanceof Error ? err.message : String(err)
        const status = err instanceof GeminiError ? err.status : 0
        // A rejected audio label: try the next label. Busy, missing or quota: try the next model.
        if (status === 400 && /mime|format|audio|unsupported|invalid argument/i.test(last)) continue
        if ([404, 429, 500, 502, 503, 504].includes(status)) break
        throw err
      }
    }
  }
  throw new HttpError(502, `Gemini could not process this: ${last.slice(0, 300)}`)
}

function audioMimes(path: string, stored: string | null): string[] {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const base = (stored ?? '').split(';')[0].trim()
  if (ext === 'webm' || base === 'audio/webm') return ['audio/webm', 'audio/ogg']
  if (ext === 'm4a' || ext === 'mp4' || base === 'audio/mp4') return ['audio/mp4', 'audio/aac', 'audio/m4a']
  if (ext === 'ogg') return ['audio/ogg']
  if (ext === 'aac') return ['audio/aac']
  return [base || 'audio/webm']
}

// ---------------------------------------------------------------- helpers

type Review = { reviewer_id: string; decision: string; profiles: { role: string } | null }

function verified(status: string, reviews: Review[]): boolean {
  if (status !== 'done') return false
  if (reviews.some((r) => r.decision === 'reject')) return false
  const confirms = reviews.filter((r) => r.decision === 'confirm')
  const people = new Set(confirms.map((r) => r.reviewer_id))
  return people.size >= 2 && confirms.some((r) => SENIOR_ROLES.includes(r.profiles?.role ?? ''))
}

function istRange(weekStart: string): { from: string; to: string; toDate: string } {
  const start = new Date(`${weekStart}T00:00:00+05:30`)
  const end = new Date(start.getTime() + 7 * 86400_000)
  const toDate = new Date(end.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10)
  return { from: start.toISOString(), to: end.toISOString(), toDate }
}

function showDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })
}

// ---------------------------------------------------------------- actions

const TRANSCRIPT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    language: { type: 'STRING', description: 'Main language spoken: Hindi, Gujarati, English or Mixed' },
    transcript: { type: 'STRING', description: 'Word-for-word transcript in the script spoken (Devanagari, Gujarati or Latin)' },
    summary: { type: 'STRING', description: 'One to three plain English sentences stating only what was said' },
    room: { type: 'STRING', description: 'One room from the given list, or an empty string' },
    trade: { type: 'STRING', description: 'One trade from the given list, or an empty string' },
  },
  required: ['language', 'transcript', 'summary', 'room', 'trade'],
}

async function transcribe(admin: SupabaseClient, apiKey: string, logId: string, force: boolean) {
  const { data: log, error } = await admin
    .from('site_logs')
    .select('id, project_id, room, trade, note, audio_path, removed_at, projects(rooms, trades)')
    .eq('id', logId)
    .maybeSingle()
  if (error) throw new HttpError(500, error.message)
  if (!log) throw new HttpError(404, 'Site log not found.')
  if (!log.audio_path) throw new HttpError(400, 'This log has no voice note.')
  if (log.removed_at) throw new HttpError(400, 'This log has been removed.')

  const { data: existing } = await admin.from('site_log_ai').select('status').eq('log_id', logId).maybeSingle()
  if (existing?.status === 'done' && !force) return { status: 'done', skipped: true }

  await admin.from('site_log_ai').upsert({ log_id: logId, status: 'pending', error: null }, { onConflict: 'log_id' })

  try {
    const { data: blob, error: dlErr } = await admin.storage.from(MEDIA_BUCKET).download(log.audio_path)
    if (dlErr || !blob) throw new HttpError(500, `Could not read the voice note: ${dlErr?.message ?? 'missing'}`)
    const audio = encodeBase64(new Uint8Array(await blob.arrayBuffer()))
    const project = (log as unknown as { projects: { rooms: string[]; trades: string[] } | null }).projects
    const rooms = project?.rooms ?? []
    const trades = project?.trades ?? []

    const prompt = [
      'You transcribe voice notes recorded on interior fit-out sites in Ahmedabad by a design studio team.',
      'Speakers mix Hindi, Gujarati and English, and use site words such as POP, gypsum, ply, laminate, conduit, dado, skirting.',
      'Transcribe exactly what is said, in the script it is spoken in. Do not translate the transcript.',
      'Then write a short English summary of only what was said. Do not add progress percentages, dates, quantities or judgements that were not spoken.',
      `If the note clearly names one of these rooms, give it, else an empty string: ${rooms.join(', ') || '(none listed)'}.`,
      `If the note clearly concerns one of these trades, give it, else an empty string: ${trades.join(', ') || '(none listed)'}.`,
      log.note ? `The person also typed: "${log.note}".` : '',
      log.room || log.trade ? `They tagged it: ${[log.room, log.trade].filter(Boolean).join(', ')}.` : '',
    ].filter(Boolean).join('\n')

    const { result, model } = await generateWithFallback(
      apiKey,
      (mime) => [{ text: prompt }, { inline_data: { mime_type: mime ?? 'audio/webm', data: audio } }],
      audioMimes(log.audio_path, blob.type || null),
      TRANSCRIPT_SCHEMA,
    )
    const r = result as { language?: string; transcript?: string; summary?: string; room?: string; trade?: string }
    const summary = (r.summary ?? '').trim()
    const row = {
      log_id: logId,
      status: 'done',
      language: r.language ?? null,
      transcript: (r.transcript ?? '').trim(),
      summary,
      final_summary: summary,
      suggested_room: rooms.includes(r.room ?? '') ? r.room : null,
      suggested_trade: trades.includes(r.trade ?? '') ? r.trade : null,
      model,
      error: null,
    }
    const { error: saveErr } = await admin.from('site_log_ai').upsert(row, { onConflict: 'log_id' })
    if (saveErr) throw new HttpError(500, saveErr.message)
    return { status: 'done', model, language: row.language }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await admin.from('site_log_ai').upsert({ log_id: logId, status: 'failed', error: message.slice(0, 500) }, { onConflict: 'log_id' })
    throw err
  }
}

const REPORT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    client: { type: 'STRING', description: 'Client report text' },
    internal: { type: 'STRING', description: 'Internal report text' },
  },
  required: ['client', 'internal'],
}

async function weeklyReport(admin: SupabaseClient, apiKey: string, projectId: string, weekStart: string, language: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || new Date(`${weekStart}T12:00:00Z`).getUTCDay() !== 1) {
    throw new HttpError(400, 'week_start must be a Monday as YYYY-MM-DD.')
  }
  if (!['English', 'Hindi', 'Gujarati'].includes(language)) throw new HttpError(400, 'language must be English, Hindi or Gujarati.')

  const { data: project } = await admin.from('projects').select('id, name, stage').eq('id', projectId).maybeSingle()
  if (!project) throw new HttpError(404, 'Project not found.')
  const { from, to, toDate } = istRange(weekStart)

  const { data: logs, error: logErr } = await admin
    .from('site_logs')
    .select('id, note, room, trade, audio_path, logged_at, site_log_photos(id, removed_at), site_log_ai(status, final_summary, site_log_reviews(reviewer_id, decision, profiles(role)))')
    .eq('project_id', projectId)
    .is('removed_at', null)
    .gte('logged_at', from)
    .lt('logged_at', to)
    .order('logged_at')
  if (logErr) throw new HttpError(500, logErr.message)

  type LogRow = {
    note: string; room: string | null; trade: string | null; audio_path: string | null; logged_at: string
    site_log_photos: { id: string; removed_at: string | null }[]
    site_log_ai: { status: string; final_summary: string | null; site_log_reviews: Review[] } | null
  }
  const facts: { date: string; room: string | null; trade: string | null; typed: string | null; voice_summary: string | null; photos: number }[] = []
  let awaiting = 0
  for (const l of (logs ?? []) as unknown as LogRow[]) {
    const ai = l.site_log_ai
    const ok = ai ? verified(ai.status, ai.site_log_reviews ?? []) : false
    if (l.audio_path && !ok) awaiting += 1
    const photos = l.site_log_photos.filter((ph) => !ph.removed_at).length
    const typed = l.note?.trim() || null
    const voice = ok ? ai?.final_summary?.trim() || null : null
    if (!typed && !voice && photos === 0) continue
    facts.push({ date: showDate(l.logged_at), room: l.room, trade: l.trade, typed, voice_summary: voice, photos })
  }

  const { data: drawings } = await admin
    .from('drawings')
    .select('number, title, archived, drawing_revisions(code, rank, revised_on, note, drawing_issues(issued_to, issued_on, created_at))')
    .eq('project_id', projectId)
    .eq('archived', false)
  type Dr = { number: string; title: string; drawing_revisions: { code: string; rank: number; revised_on: string; note: string; drawing_issues: { issued_to: string; issued_on: string; created_at: string }[] }[] }
  const revisedThisWeek: string[] = []
  const issuedThisWeek: string[] = []
  const sitePrintProblems: string[] = []
  for (const d of (drawings ?? []) as unknown as Dr[]) {
    const revs = [...d.drawing_revisions].sort((a, b) => b.rank - a.rank)
    for (const r of revs) {
      if (r.revised_on >= weekStart && r.revised_on < toDate) revisedThisWeek.push(`${d.number} ${d.title}: ${r.code}${r.note ? ` (${r.note})` : ''}`)
      for (const i of r.drawing_issues) if (i.issued_on >= weekStart && i.issued_on < toDate) issuedThisWeek.push(`${d.number} ${r.code} to ${i.issued_to}`)
    }
    let latest: { code: string; rank: number; key: string } | null = null
    for (const r of revs) for (const i of r.drawing_issues) {
      if (i.issued_to.trim().toLowerCase() !== 'site') continue
      const k = `${i.issued_on}|${i.created_at}`
      if (!latest || k > latest.key) latest = { code: r.code, rank: r.rank, key: k }
    }
    if (latest && revs[0] && latest.rank < revs[0].rank) sitePrintProblems.push(`${d.number}: site holds ${latest.code}, current is ${revs[0].code}`)
    else if (latest && latest.code.startsWith('P')) sitePrintProblems.push(`${d.number}: site holds ${latest.code}, not for construction`)
  }

  const title = `${project.name}: week of ${showDate(weekStart)}`
  const stage = STAGES[(project.stage ?? 1) - 1]
  let client: string
  let internal: string
  let model: string | null = null

  if (facts.length === 0 && revisedThisWeek.length === 0 && issuedThisWeek.length === 0) {
    client = 'No site updates were recorded this week.'
    internal = `No site logs, revisions or issues were recorded this week.${awaiting ? ` ${awaiting} voice notes still need verifying.` : ''}`
  } else {
    const prompt = [
      'You draft weekly project updates for an interior design studio in Ahmedabad. A person will check and edit your draft before anyone sees it.',
      'Use only the facts in the JSON below. Do not invent progress, percentages, dates, quantities, names or next steps.',
      `CLIENT report: written in ${language}, warm and professional, 60 to 160 words. Start with one sentence on the overall week, then short points on what was done. Mention drawings shared with the client or site only if listed. Leave out internal matters (verification counts, site print problems). No greeting line and no sign-off; the studio adds those.`,
      'INTERNAL report: in English, 60 to 200 words, plain points grouped as Site, Drawings, and Attention. Include every site print problem and the count of voice notes still awaiting verification.',
      JSON.stringify({ stage, site_logs: facts, drawing_revisions_this_week: revisedThisWeek, drawing_issues_this_week: issuedThisWeek, site_print_problems: sitePrintProblems, voice_notes_awaiting_verification: awaiting }),
    ].join('\n\n')
    const out = await generateWithFallback(apiKey, () => [{ text: prompt }], [null], REPORT_SCHEMA)
    const r = out.result as { client?: string; internal?: string }
    client = (r.client ?? '').trim()
    internal = (r.internal ?? '').trim()
    model = out.model
  }

  const saved: string[] = []
  const skipped: string[] = []
  for (const [kind, body, lang] of [['client', client, language], ['internal', internal, 'English']] as const) {
    const { data: existing } = await admin.from('weekly_reports').select('id, status').eq('project_id', projectId).eq('week_start', weekStart).eq('kind', kind).maybeSingle()
    if (existing?.status === 'approved') {
      skipped.push(kind)
      continue
    }
    const row = { project_id: projectId, week_start: weekStart, kind, language: lang, body: `${title}\n\n${body}`, status: 'draft', model, generated_at: new Date().toISOString() }
    const { error: upErr } = existing
      ? await admin.from('weekly_reports').update(row).eq('id', existing.id)
      : await admin.from('weekly_reports').insert(row)
    if (upErr) throw new HttpError(500, upErr.message)
    saved.push(kind)
  }
  return { saved, skipped, model, logs_used: facts.length, awaiting_verification: awaiting }
}

// ---------------------------------------------------------------- entry

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405)
  try {
    const body = await req.json().catch(() => ({}))
    const admin = createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false } })
    const apiKey = Deno.env.get('GEMINI_API_KEY') ?? ''

    // Signed-in team members only.
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!token) throw new HttpError(401, 'Sign in first.')
    const { data: userData, error: userErr } = await admin.auth.getUser(token)
    if (userErr || !userData.user) throw new HttpError(401, 'Sign in first.')
    const { data: profile } = await admin.from('profiles').select('id, role').eq('id', userData.user.id).maybeSingle()
    if (!profile) throw new HttpError(403, 'This account is not on the studio team.')

    if (body.action === 'health') {
      if (!apiKey) return json({ ok: false, gemini_key: false })
      const models = await candidateModels(apiKey)
      return json({ ok: true, gemini_key: true, models: models.slice(0, 4).map((m) => m.name.replace('models/', '')) })
    }
    if (!apiKey) throw new HttpError(500, 'The GEMINI_API_KEY secret is not set in Supabase.')
    if (body.action === 'transcribe') {
      if (typeof body.log_id !== 'string') throw new HttpError(400, 'log_id is required.')
      return json(await transcribe(admin, apiKey, body.log_id, Boolean(body.force)))
    }
    if (body.action === 'weekly_report') {
      if (typeof body.project_id !== 'string' || typeof body.week_start !== 'string') throw new HttpError(400, 'project_id and week_start are required.')
      return json(await weeklyReport(admin, apiKey, body.project_id, body.week_start, body.language ?? 'English'))
    }
    throw new HttpError(400, 'Unknown action.')
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500
    const message = err instanceof Error ? err.message : String(err)
    console.error(status, message)
    return json({ error: message }, status)
  }
})
