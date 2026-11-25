# Studio Elements project tool

A phone-first app for running interior projects: site logs, drawings, schedule and money.
Built so far: sign-in, projects (add, edit, remove, restore), the site log with an offline queue,
the drawing register (sheets, P/R revisions, issues to site, out-of-date print flags), and the AI layer
(voice-note transcripts and summaries, a two-person review queue, weekly client and internal report drafts),
the schedule (tasks, "After" links, stage templates, our own critical path, baseline and change log, phone list and
desktop timeline, phone timeline) and an owner-only backup download, plus a studio overview: status per project
(on track / at risk / delayed), progress against plan, days to handover, a handover chart, drafted messages to
share yourself, team workload and a latest-activity feed.
Part 6 adds per project an estimate/BOQ with a budget ledger, quotes and work orders, agency RA bills, variations and a
client budget report (XLSX, CSV, PDF); owner-only fees (proposal as DOCX/PDF, milestone invoices, studio costs and
margin); decisions (RFIs, approvals, site instructions, design revisions); procurement with order-by dates; a client
brief; a presentation deck (PPTX/PDF); and a review before export. Studio-wide: finances with an 8-week cash-flow
forecast (owners), a vendor directory, a calendar of everything dated (with an .ics download) and studio settings
(logo, contract clauses). Drafted reminders for bills, fee invoices, approvals and orders join the Drafts outbox.

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
| `src/portfolio.ts` | Project status, progress vs plan, days to handover, drafted messages, team workload (all derived, nothing stored or sent) |
| `src/usePortfolio.ts` | Loads every project's schedule and register for Today, Projects, Drafts and Team; remembers handled drafts on the device |
| `e2e/mobile_layout.py` | Every screen at 360 and 390 px: nothing wider than the screen, text boxes 16 px, timeline swipes |
| `e2e/standin.py` | Stand-in Supabase server shared by the schedule and phone tests |
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
| `supabase/006_money_decisions_procurement.sql` | Database part 6: money, fees, vendors, decisions, procurement, brief, deck, settings, and their rules |
| `supabase/tests/006_money_rules.sql` | Live rule checks for part 6 (always rolls back) |
| `src/money/`, `src/fees/`, `src/decisions/`, `src/deck/` | Logic for part 6 (screens are in `src/screens/` under the same names) |
| `e2e/money.py`, `fees.py`, `decisions.py`, `deck.py` | Browser tests for part 6 (set `APP_URL=http://localhost:4173/`) |
| `scripts/restore_check.py` | Checks a backup (every table, links, files) and writes a one-step restore SQL |
| `scripts/drill/run_drill.sh` | Restore drill: build a database from the setup files, fill it, back up, restore, compare |
| `.env` | Supabase address and public key (public by design) |

## Restoring a backup

1. Check it: `python3 scripts/restore_check.py backup.zip --sql restore.sql` (a bare `data.json` also works).
   It lists every table's rows, broken links and missing photos, and refuses to write the SQL if anything is wrong.
2. In a fresh Supabase project, run the setup files `supabase/001` to `006` in order.
3. Invite the same people. Their sign-in ids must match the backup, or the restore stops.
4. Load `restore.sql` in the SQL editor. It runs as one step: if anything fails, nothing changes.
5. Upload the ZIP's `media/` folder to the `site-media` bucket, keeping the paths.

`bash scripts/drill/run_drill.sh` rehearses steps 1, 2 and 4 on a scratch database (needs PostgreSQL 16), then tries
every table as a signed-out visitor, a stranger, the coordinator and an owner (`scripts/drill/access_check.py`).
It ends with a security fingerprint; run `scripts/drill/fingerprint.sql` in the live SQL editor and the two must match,
otherwise live has drifted from the setup files. (Matched on 23 Nov: 270 items, `7e11a20f…`.)

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
- Drafted messages are suggestions only: the app never sends anything. You edit, then share or copy.
- Fees, fee invoices, studio costs, margins and opening cash are visible to owners only; the database returns nothing
  to anyone else. Estimates, bills, vendors, decisions and procurement are shared with the team.
- Only an owner can move an RA bill back a step or change a certified amount; bill lines lock once certified.
- A decision with a cost impact creates one proposed variation. An estimate line more than 5% over budget is flagged
  until a variation is linked.
- Agency payments are tracked, never made, from the app. Exports are marked DRAFT; check invoices with your CA.
- Every screen must fit a 360 px phone without sideways scrolling, and text boxes stay at 16 px so iPhones do not zoom.
- Weekly reports use typed notes and verified voice summaries only. An approved report is never
  overwritten by a new draft, and nothing is sent from the app: you share it yourself.
