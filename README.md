# Studio Elements project tool

A phone-first app for running interior projects: site logs, drawings, schedule and money.
Built so far: sign-in, projects (add, edit, remove, restore), the site log with an offline queue,
the drawing register (sheets, P/R revisions, issues to site, out-of-date print flags), and the AI layer
(voice-note transcripts and summaries, a two-person review queue, weekly client and internal report drafts),
the schedule (tasks, "After" links, stage templates, our own critical path, baseline and change log, phone list and
desktop timeline) and an owner-only backup download.

## What is in here

| Path | What it is |
|---|---|
| `src/` | The app (React, TypeScript) |
| `src/queue.ts` | Saves logs on the phone and uploads them when there is signal |
| `src/drawings.ts` | Revision codes and the rules for what the site holds |
| `src/review.ts` | When an AI summary counts as verified; report weeks |
| `supabase/003_ai_layer.sql` | Database part 3: AI results, reviews, weekly reports |
| `supabase/004_log_edit_remove.sql` | Database part 4: owners edit, remove and restore site logs |
| `supabase/functions/ai/` | Server function that calls Gemini (transcribe, weekly_report) |
| `src/schedule.ts` | Working calendar (Mon–Sat by default, holidays) and the critical path: forward and backward pass, float, slip |
| `src/templates.ts` | Stage templates: the tasks and placeholder durations a new schedule starts with |
| `src/useSchedule.ts` | Loads a project's schedule; sheet-gate and Today risk rules |
| `src/backup.ts` | Builds the backup ZIP: every table as data.json plus every photo and voice note |
| `supabase/005_schedule.sql` | Database part 5: calendar, tasks, change log, backup log, and their rules |
| `supabase/tests/005_schedule_rules.sql` | Live rule checks for part 5 (always rolls back) |
| `e2e/schedule.py` | Browser test of the schedule, timeline, flags and backup, mocked server |
| `supabase/001_init.sql` | Database part 1: people, projects, site log, photo storage |
| `supabase/002_drawing_register.sql` | Database part 2: drawing register |
| `e2e/smoke.py` | Browser test of sign-in and the offline site log, mocked server |
| `e2e/register.py` | Browser test of project editing and the drawing register, mocked server |
| `e2e/ai.py` | Browser test of the review queue and weekly reports, mocked server and AI |
| `e2e/logs.py` | Browser test of owners editing, removing and restoring logs, mocked server |
| `.env` | Supabase address and public key (public by design) |

## One-time setup

1. **Database.** Supabase dashboard, SQL editor: run `supabase/001_init.sql`, `002_drawing_register.sql`, `003_ai_layer.sql`, `004_log_edit_remove.sql`, then `005_schedule.sql`.
   Set the site coordinator's `role` in `profiles` to `coordinator` (owners also count as senior).
2. **AI.** Supabase dashboard, Edge Functions: deploy `supabase/functions/ai` with JWT checking off
   (the function checks the team itself), and add the secret `GEMINI_API_KEY`. Never put that key in the app.
3. **People.** Supabase dashboard, Authentication: add each team member with an email and a password.
   Then switch off new sign-ups, so only people you add can get in.
4. **Hosting.** Cloudflare Pages: connect this repository. Build command `npm run build`, output folder `dist`.
5. **Phone.** Open the site address, add it to the home screen, sign in.

## Working on it

```
npm install
npm run dev      # run locally
npm test         # upload-queue and drawing-rule tests
npm run build    # production build
```

End-to-end test: `npm run build`, then `npx vite preview --port 4173 --strictPort` in one terminal
and `python3 e2e/smoke.py` (or `register.py`, `ai.py`) in another (needs Python with Playwright and Pillow, and Chrome).

## Rules the code keeps

- A log is removed from the phone only after the server has accepted every file and the record.
- Every log has an id made on the phone, so a retried upload never creates a duplicate.
- Nothing can be deleted from the app. Removing a project, a site log or a photo hides it; it can be restored.
- Only an owner can edit or remove a site log; the database ignores anyone else's change.
  A retried upload never overwrites a stored log. Roles are set in the Supabase dashboard only.
- Only signed-in team members can read or write anything.
- An AI summary changes nothing official. It is verified only when two different people confirm it,
  one of them the coordinator or an owner; editing it clears every confirmation.
- Planned dates are never typed or stored; they are computed from durations, "After" links, progress and today.
  The database refuses links to other projects and links that loop.
- Only an owner can freeze or re-baseline, remove or restore a task, or record a backup. A frozen baseline cannot be
  unfrozen. After the freeze, any change to a duration, a link, a task's existence or the calendar needs a reason,
  and the database writes it to the change log.
- Weekly reports use typed notes and verified voice summaries only. An approved report is never
  overwritten by a new draft, and nothing is sent from the app: you share it yourself.
