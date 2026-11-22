import { reviewState, type AiState, type AiStatus, type ReviewLite } from './review'
import { supabase } from './supabase'

export type AiReview = {
  reviewer_id: string
  decision: 'confirm' | 'reject'
  profiles: { full_name: string; role: string } | null
}

export type AiRow = {
  status: AiStatus
  language: string | null
  transcript: string | null
  summary: string | null
  final_summary: string | null
  suggested_room: string | null
  suggested_trade: string | null
  error: string | null
  updated_at: string
  site_log_reviews: AiReview[]
}

export type VoiceLog = {
  id: string
  project_id: string
  note: string
  room: string | null
  trade: string | null
  audio_path: string | null
  logged_at: string
  profiles: { full_name: string } | null
  site_log_ai: AiRow | null
}

export const AI_SELECT =
  'status, language, transcript, summary, final_summary, suggested_room, suggested_trade, error, updated_at, ' +
  'site_log_reviews(reviewer_id, decision, profiles(full_name, role))'

export function toLite(reviews: AiReview[]): ReviewLite[] {
  return reviews.map((r) => ({ reviewer_id: r.reviewer_id, decision: r.decision, role: r.profiles?.role ?? 'team' }))
}

/** 'missing' means the voice note has never been sent for transcription. */
export function stateOf(log: VoiceLog): AiState | 'missing' {
  if (!log.site_log_ai) return 'missing'
  return reviewState(log.site_log_ai.status, toLite(log.site_log_ai.site_log_reviews))
}

export async function loadVoiceLogs(limit = 60): Promise<VoiceLog[]> {
  const { data, error } = await supabase
    .from('site_logs')
    .select(`id, project_id, note, room, trade, audio_path, logged_at, profiles(full_name), site_log_ai(${AI_SELECT})`)
    .not('audio_path', 'is', null)
    .order('logged_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as VoiceLog[]
}

/** Record this person's confirmation or rejection. Changing your mind updates your own review. */
export async function review(logId: string, userId: string, decision: 'confirm' | 'reject'): Promise<void> {
  const { error } = await supabase.from('site_log_reviews').insert({ log_id: logId, decision })
  if (!error) return
  if (error.code !== '23505') throw new Error(error.message)
  const { error: upErr } = await supabase
    .from('site_log_reviews')
    .update({ decision })
    .eq('log_id', logId)
    .eq('reviewer_id', userId)
  if (upErr) throw new Error(upErr.message)
}

/** Editing the summary clears every confirmation, so both people confirm the same words. */
export async function editSummary(logId: string, text: string): Promise<void> {
  const { error } = await supabase.from('site_log_ai').update({ final_summary: text.trim() }).eq('log_id', logId)
  if (error) throw new Error(error.message)
}

export const STATE_LABEL: Record<AiState | 'missing', string> = {
  missing: 'Not transcribed yet',
  pending: 'Transcribing',
  failed: 'Transcription failed',
  unverified: 'Unverified',
  verified: 'Verified',
  rejected: 'Rejected',
}
