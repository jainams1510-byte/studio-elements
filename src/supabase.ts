import { createClient } from '@supabase/supabase-js'
import type { Remote } from './types'

// Both values are public by design; access is controlled by the database rules.
// The defaults mean the app still builds if the .env file is left out of an upload.
const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? 'https://obwkpheueqecifmeaqyc.supabase.co'
const key = (import.meta.env.VITE_SUPABASE_KEY as string | undefined) ?? 'sb_publishable_N-lYfOCyISXXHGdJi8_yfA_2dX8VrQT'

export const supabase = createClient(url, key)

export const MEDIA_BUCKET = 'site-media'

/** The upload queue's view of the server. */
export const remote: Remote = {
  async uploadFile(path, blob, mime) {
    const { error } = await supabase.storage
      .from(MEDIA_BUCKET)
      .upload(path, blob, { contentType: mime, upsert: true })
    if (error) throw new Error(error.message)
  },
  async upsertLog(row) {
    const { error } = await supabase.from('site_logs').upsert(row, { onConflict: 'id' })
    if (error) throw new Error(error.message)
  },
  async upsertPhotos(rows) {
    const { error } = await supabase.from('site_log_photos').upsert(rows, { onConflict: 'id' })
    if (error) throw new Error(error.message)
  },
}
