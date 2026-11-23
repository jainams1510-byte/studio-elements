# Studio Elements project tool: handover

Everything needed to continue building this project in a new chat. Written 23 Nov 2026; updated the same day after Schedule part 1 and the backup download went live.

---

## 0. Read this first (instructions for the next chat)

You are continuing a build that is already live and in use. Before changing anything:

1. **Get the code.** It is in the GitHub repository `jainams1510-byte/studio-elements`, branch `main`. Attach it to the session and clone it. Every push to `main` deploys automatically to Cloudflare Pages.
2. **Connect the services.** The Supabase project is `obwkpheueqecifmeaqyc` (Mumbai). Use the Supabase connector for SQL, migrations, edge functions and security advisors.
3. **Read sections 2, 6 and 9 before writing code.** Section 2 covers the rules Jainam set. Section 6 covers how the database is protected. Section 9 lists traps already hit.
4. **Next job:** see section 11, "What to build next". **Schedule part 2** (calendar view, procurement order-by dates, drafted notes), then **Money**. Several smaller items are also pending; see 11.1.
5. **Work the way Jainam asked:**
   - Plan briefly, then build.
   - Test for real before saying anything works.
   - Separate what was checked, what was assumed and what is unknown.
   - Ask only when a wrong guess is expensive.
   - Never paste or ask for secret keys in chat.

The companion file `Studio PM tool build routes.md` is the sourced research report from 14 Nov (costs, offline limits, speech-to-text benchmarks, WhatsApp, DPDP).

---

## 1. Who and what

- **Jainam Shah** is an architect and interior designer in Ahmedabad and co-founder of Studio Elements. His partners are Bhavin Shah (project management and execution) and Malav Shah (architect). Jainam's partner is the tool's second owner.
- **Contract model:** Design + PMC. Clients pay agencies directly. The studio fee is ₹1.5–2 lakh per project, for projects that run 10–12 months.
- **Load:** 3–5 live projects, a team of 3 plus 1 site coordinator.
- **Today's workflow:** one WhatsApp group per project (client, PMC, everyone); finances in Excel; files on a shared drive.
  - Agencies give item-rate BOQs with measured RA bills. The client certifies bills after consulting the designer and PMC.
  - Drawings go out on WhatsApp and are printed and stuck up on site. There was no revision numbering until this tool.
- **Costliest failures the tool must fix:** site built from an old drawing; material ordered late; client payment delayed (both his fee and clients' payments to agencies); decisions lost in WhatsApp.
- **Daily entry budget:** about 15 minutes a day. He prefers logging on his phone; a laptop is used for setup.
- **Pilot projects:**
  - Sparsh Ekaya / Shah Residence: client Mr Sunil Shah, 4BHK, working-drawings stage.
  - Aggrawal Atelier: execution stage, **not yet added to the app**.

---

## 2. Principles and standing decisions (do not change without asking)

### Principles
- AI observations never change official progress until a human verifies them.
- Nothing is sent externally (clients, vendors) without Jainam's approval. WhatsApp messages are only drafted; he sends them himself via the share sheet or copy. Never automate WhatsApp.
- Look: warm off-white `#F7F5F0`, charcoal type `#2B2B29`, grey dividers `#D9D6CF`, muted text `#5F5C56`, forest green accent `#2F5D46`. Inter font. It should feel premium and uncluttered, not like an ERP.
- **₹0 running cost.** Free tiers only: no paid services, licences or developers.
- Nothing is hard-deleted from the app. "Remove" hides a record and it can be restored.

### Decisions from the planning phases
| Area | Decision |
|---|---|
| Build route | Custom React PWA + Supabase free tier (Mumbai) + Cloudflare Pages + Gemini free tier. Standalone code he owns. |
| Clients | Get reports, not logins (until access rules are independently reviewed). |
| Client budget view | Read-only. Trade-level totals **and** every BOQ item. |
| Finance scope | Full scope kept (he refused the cut). |
| Decisions | RFIs, approvals and site instructions are one **Decision** record. |
| Drawing revisions | P1, P2… before approval; R0, R1… for construction. Preliminary (P) prints on site stay flagged (confirmed 22 Nov). |
| Sheet numbering | Project-discipline-number, e.g. SE-FL-01. |
| Schedule | **Full critical path**, computed in our own code (no paid Gantt licence). Calendar week starts **Monday**. Baseline freezes when work orders are issued; re-baselining needs Jainam's approval. A date change asks for a reason linked to a decision. |
| Thresholds | 7 days slippage; 5% overrun per BOQ item; 7 days payment reminder; issue unacknowledged after 48 h triggers a reminder; fee overdue reminders at 3 and 10 days. All editable per project. |
| Weekly report | Drafted Friday 5 pm, client and internal, approved by Jainam before anything is shared. |
| AI verification | Originally the coordinator plus a working team member. They share one login (the studio account), so in practice it is **Jainam + the studio account** (23 Nov). An alternative was offered: the studio account confirms alone with a "checked with team member on site" tick. **Jainam has not answered.** |
| Languages | Site voice notes in Hindi and Gujarati; client messages in English, Hindi and Gujarati. |
| AI scope | Voice and text only go to Gemini (no client names, no photos of homes). No bill or quote reading unless necessary. AI never sets progress %, certifies bills, changes dates, budgets or drawing status, sends anything, or picks quotes. |
| Scope | **Full versions** of every module; he rejected thin versions. |
| Build order | Site log + drawings → AI + weekly report → schedule → money → hardening. |
| Log edits | Only owners can edit or remove site logs (23 Nov). |

---

## 3. Status at a glance

| Module | Status |
|---|---|
| Sign-in, projects, offline site log | **Done.** Phone check passed 22 Nov (Android; uploaded 27.5 s after reconnecting). |
| Project edit, remove, restore | **Done.** Phone check passed 22 Nov. |
| Drawing register (sheets, P/R revisions, issues, site print photo, out-of-date flags) | **Done.** Phone check passed 22 Nov. |
| AI: transcripts, two-person review queue, weekly report drafts | **Live 22 Nov** (`cf36bb9`). Database rules tested live. Browser-tested with a stand-in. **A real transcription and real report draft have not been run yet.** |
| Owner edit / remove / restore of site logs and photos | **Live 23 Nov** (`b0cb21e`). 15 rule checks passed on the live database. Browser-tested with a stand-in. **Not yet tried on a phone.** |
| Decisions and variations | Not started |
| Procurement (order-by dates) | Not started |
| Schedule part 1: tasks, After links, templates, critical path, baseline + change log, phone tab, desktop timeline, Today risks | **Live 23 Nov.** 23 live rule checks passed; 50 unit tests; browser test 33/33 with a stand-in. **Not yet tried on a phone or with real tasks.** Template durations are placeholders. |
| Schedule part 2: calendar view, procurement, automations' drafted messages | Not started (**next**) |
| Money (budget, RA bills, fee invoices) | Not started |
| Hardening | **Backup download live 23 Nov** (owner-only ZIP: all tables + media; backup log; "Backup due" on Today after 7 days). Restore drill and access test suite not started. **Make the first backup now.** |

The original "one week" sprint (14–20 Nov) slipped. Rule: each module ends with a phone check. If it fails, dates shift and nothing is skipped. "Complete" means two weeks of real logs with no lost entry.

---

## 4. What is live, screen by screen

Hash routes: `#/` Today, `#/log`, `#/projects`, `#/project/:id` (tabs: Site logs, Drawings, Schedule, Reports), `#/project/:id/drawings`, `#/project/:id/schedule`, `#/project/:id/reports`, `#/project/:id/timeline` (desktop, full width), `#/project/:id/edit`, `#/drawing/:id`, `#/review`. Tab bar: **Today · Review · + · Projects**.

- **Sign in:** email and password. Accounts are created by hand in Supabase (Authentication > Users > auto-confirm). New sign-ups should be switched off.
- **Today:**
  - "Needs you": schedule at risk (per project), backup due (owners, after 7 days), drawing flags (site holds an outdated or P print), voice notes to review, and a weekly report due (from Friday 5 pm until this week's client report is approved).
  - Projects with an 8-stage bar.
  - Latest 10 logs, with photo count and voice note marker.
  - Unsent-upload count and a stuck-upload message.
- **New log (`+`):**
  - Project, photos (compressed on the phone), hold-to-record voice note, room and trade chips, one optional line.
  - Saved to the phone first (IndexedDB), read back to confirm, then uploaded when there is signal.
  - Capture-only mode when signed out and offline (for someone who signed in on that phone before).
- **Projects:** add (duplicate names refused); removed projects listed with Restore; **Backup** card for owners (download ZIP, last backup shown).
- **Project page:**
  - Edit (name, code, stage, rooms, trades; Remove with inline confirm).
  - **Site logs tab:**
    - Photos, voice, AI summary with a Verified / Unverified tag, "Logged by", "edited by".
    - Owners get **Edit or remove**: edit note, room or trade; remove single photos; remove the log; a removed list with Restore.
  - **Drawings tab:** register sorted by discipline, current revision, site status, offline cache.
  - **Schedule tab:** setup (start date, working days, template from a stage); forecast finish vs baseline with slip; critical-path strip; flags (sheet gate, overdue, blocked, milestone > 7 working days late); tasks by stage with Start/Done/Reached buttons; task editor (After links, loops not offered, trade, room, owner, sheet gate, status and actual dates; reason box once frozen; owner Remove); baseline card (owner Freeze / Re-baseline); calendar settings; change log; removed tasks with Restore. Read-only offline from the phone's copy.
- **Timeline (desktop):** bars (critical green, other grey, done light), spare days as an outline, baseline line, milestone diamonds, Sunday/holiday shading, Today line, zoom Months/Weeks/Days, select a task for arrows and details, edit beside the chart on screens 900 px and wider.
  - **Reports tab:**
    - This week or last week; client language (English, Hindi, Gujarati).
    - Draft reports, edit, Approve, Share (phone share sheet or copy).
    - Editing an approved report puts it back to draft. Approved reports are never overwritten by a new draft.
- **Drawing detail:**
  - New revision: code suggestions P1→P2… and R0→R1…; a P after R is refused.
  - Record an issue: to whom, method, date, optional site print photo.
  - Full history.
- **Review:**
  - AI summaries of voice notes, with the audio, transcript and suggested room or trade.
  - Confirm, Edit or Reject. Editing clears all confirmations. Shows who confirmed and who is still needed.
  - Try again for failed ones; finished items in a collapsible list.
  - Opening Review catches up on up to 3 never-transcribed voice notes.

---

## 5. Stack, accounts and where things are

| Thing | Detail |
|---|---|
| Code | GitHub `jainams1510-byte/studio-elements`, `main`. Recommended private. |
| Hosting | Cloudflare Pages, connected to the repo. Build `npm run build`, output `dist`. Auto-deploys on push. The Cloudflare connector available to Claude is the deprecated Workers one and **cannot manage Pages**. |
| Database / auth / files | Supabase project `obwkpheueqecifmeaqyc`, Mumbai, Postgres 17, **free tier**: 1 GB files, no backups, pauses after a week of no use. |
| Public client config | `.env` (committed on purpose): Supabase URL and publishable key `sb_publishable_N-lYfOCyISXXHGdJi8_yfA_2dX8VrQT`. These ship to every browser anyway. |
| AI | Edge function `ai` (version 5), JWT check off; it checks the team itself. Secret `GEMINI_API_KEY` was set by Jainam in the Supabase dashboard. **Never in chat or the app.** |
| Storage | Private bucket `site-media`. Logs are stored at `<project>/<log>/<photo>.jpg` and `/voice.webm` (or `.m4a`). Print photos are stored at `drawings/<drawing>/…`. |
| Drawing PDFs | Stay on the shared drive (Drive link or office server) and are linked from the register, to save the 1 GB. |
| Users | Jainam `jainams1510@gmail.com` (role **owner**). Studio account `studioelements15@gmail.com` (role **coordinator**; shared by the site coordinator and the working team member). Display names are still email prefixes. Partners are not added. |
| Data | Project "Sparsh Ekaya": stage 3, 8 rooms, 2 logs, one with a voice note not yet transcribed (`5e10eb24-9205-4fed-b3bd-175e0e6d41f1`). A duplicate Sparsh Ekaya is archived. Drawing SE-FL-01 has P1–P3 with issues. |
| Wireframes | Design canvas "Studio tool wireframes": https://claude.ai/artifact/Rdu2KLrM3WZsZp1oqfhr8M. Dashboard, project page, site log, review queue, desktop timeline, desktop month calendar (Monday start), phone agenda. |
| Project notes | claude.ai Project "Studio Elements", doc `claude/studio-tool-build-notes.md`. |

---

## 6. Database design and access rules

Migrations applied, in order:
1. `init_signin_projects_site_log` (17 Nov)
2. `tighten_table_privileges` (17 Nov)
3. `move_team_check_out_of_api` (19 Nov)
4. `drawing_register` (22 Nov)
5. `ai_layer` (22 Nov)
6. `log_edit_remove` (23 Nov)
7. `schedule_backup_log` (23 Nov)

Repository files `supabase/001` to `005` match the live database. `supabase/tests/005_schedule_rules.sql` is the live rule check for part 5 (always rolls back).

### Tables
| Table | Key columns |
|---|---|
| profiles | id (= auth user), full_name, role `owner`/`coordinator`/`team` |
| projects | id, name, code, stage 1–8, rooms text[], trades text[] (default Carpentry, Electrical, Plumbing, Civil, False ceiling, Tiling, Glass, Modular), archived |
| site_logs | id (**made on the phone**), project_id, room, trade, note, audio_path, logged_at, created_by, edited_at/by, removed_at/by |
| site_log_photos | id (made on the phone), log_id, path, removed_at/by |
| drawings | project_id, number (unique per project), title, discipline, archived |
| drawing_revisions | drawing_id, code (`P1…`/`R0…`, checked), rank (generated: P = n, R = 1000 + n), revised_on, note, file_link |
| drawing_issues | revision_id, issued_to, method (WhatsApp / Print on site / Drive link / Email / By hand), issued_on, print_photo_path |
| site_log_ai | log_id PK, status pending/done/failed, language, transcript, summary, final_summary, suggested_room/trade, model, error |
| site_log_reviews | log_id, reviewer_id, decision confirm/reject, unique (log_id, reviewer_id) |
| weekly_reports | project_id, week_start (Monday), kind client/internal, language, body, status draft/approved, approved_by/at, model; unique (project, week, kind) |
| project_schedules | project_id PK, start_date, work_days smallint[] (ISO 1=Mon…7=Sun, default Mon–Sat), holidays date[], baseline_at/by, baseline_plan jsonb, change_reason (write-only) |
| tasks | id (made by the app), project_id, stage, name, trade, room, owner_name, duration (working days), milestone, after_ids uuid[] (finish-to-start), status planned/in_progress/done/blocked, actual_start/end, gate_drawing_id, baseline_start/end, sort_order, template_key, change_reason (write-only), removed_at/by |
| schedule_changes | project_id, task_id (not an FK), kind added/changed/removed/restored/baseline/rebaseline/calendar, before, after, reason, decision_id (for later), changed_by/at. Read-only to the app |
| backup_log | made_at, made_by, summary, files, missing. Insert by owners only (summary, files, missing columns) |

Stages: 1 Concept, 2 Design development, 3 Working drawings, 4 BOQ and tendering, 5 Procurement, 6 Execution, 7 Snagging, 8 Handover.

Drawing disciplines: Furniture layout, Electrical, Ceiling (RCP), HVAC, Plumbing, Joinery, Tiling and flooring, Elevations, Civil, Other.

### How access is enforced
- Every table: `revoke all … from anon, authenticated`, then explicit grants. Supabase grants everything by default, so **every new table needs this**. **No delete is granted anywhere.**
- Row-level security on every table, through `private.is_team()` and `private.is_owner()`. These are security-definer functions in the `private` schema, so they are not exposed through the API.
- Column-level grants plus triggers enforce the finer rules:
  - `site_log_guard` / `site_log_photo_guard`: for a non-owner, any update is a silent no-op (returns the old row). This keeps old app versions' upload retries harmless. For an owner, only note, room, trade and removed_at can change; edited_by, removed_by and server timestamps are stamped automatically.
  - `ai_summary_edited`: editing final_summary deletes all reviews.
  - `report_edited`: an edit to an approved report sets it back to draft; approving stamps approved_by and approved_at.
  - site_log_ai: the app may update only final_summary, and only while status = done.
  - Reviews: insert (log_id, decision), update (decision) on your own row only.
- Schedule (part 5): `task_guard` keeps baselines owner-only, makes removal/restore owner-only (error, not silent), fills actual dates from status on the Ahmedabad calendar, and once the baseline is frozen refuses any duration, link, add or remove without `change_reason`, logging it. `task_links_check` (after trigger, so multi-row inserts work) refuses links to missing or other-project tasks, gate sheets from other projects, and loops. `schedule_guard`: only owners freeze or re-baseline; cannot unfreeze; re-baseline and calendar changes after the freeze need a reason. `schedule_copy_baseline` copies `baseline_plan` into tasks in the same statement.
- profiles: people can update only their own `full_name`. **Roles change only in the Supabase dashboard** (fixed 23 Nov; before that, anyone could make themselves owner).
- `edited_by` / `removed_by` are deliberately **not** foreign keys to profiles. A second link from site_logs to profiles makes the existing `profiles(full_name)` embeds ambiguous (PostgREST error), which would break the live app.

### Verification rule
A summary is verified when two different people confirm it and at least one is `coordinator` or `owner`. Any reject marks it rejected. The rule is in `src/review.ts` and is duplicated in the edge function.

---

## 7. Code map (`/src`)

| File | Purpose |
|---|---|
| `queue.ts` | Offline outbox: save, read back, `syncOutbox` (files first, then log, then photos; removed from the phone only on success; one sync at a time). After an upload with audio, it calls `requestTranscript` (best effort). |
| `supabase.ts` | Client; `remote` (uploads use **insert-ignore-duplicates**, so retries never overwrite); `callAi()` returns the server's own error message. |
| `hooks.ts` | Hash routing, online status, outbox count and tick, auto-sync, `useProjects` (cached). |
| `team.ts` | `useTeam()`: me (role) and everyone's names, cached; `isOwner`. |
| `drawings.ts` | Revision rules: rank, current revision, next codes, site status (none/current/outdated/preliminary), flags. |
| `review.ts` | Verification state, `stillNeeded`, `weekStart` (Monday), `addDays`, `reportDue` (Friday from 17:00, plus Saturday and Sunday). |
| `schedule.ts` | `WorkCalendar` (working-day numbers both ways, holidays) and `computeSchedule` (forward/backward pass with progress and today, float, slip, critical path, loop detection), `baselinePlan`, `makesLoop`, `statusLabel`. |
| `templates.ts` | Stage templates (8 stages, exit-gate milestones, placeholder durations) and `templateRows(project, fromStage)`. |
| `useSchedule.ts` | Loads and caches a schedule; `gateFlag` (sheet not at R within 7 days or started); `projectRisk` for Today (milestone > 7 working days late, overdue, gates, blocked, loops). |
| `backup.ts` | Backup ZIP (`data.json` of all 14 tables + `media/`), backup log, file save (share sheet on iPhone home-screen app). |
| `ai.ts` | Loads voice logs with AI rows; review insert-then-update; edit summary. |
| `media.ts` | Photo compression, audio recording. |
| `db.ts` | IndexedDB (idb): outbox and cache. |
| `screens/*` | Today, NewLog, Projects, BackupCard, ProjectPage, LogList, DrawingList, DrawingDetail, EditProject, ScheduleTab, TaskEditor, Timeline, Review, Reports, SignIn. |
| `supabase/functions/ai/index.ts` | `health`, `transcribe {log_id, force?}`, `weekly_report {project_id, week_start, language}` (details below). |

Edge function notes:
- Lists Gemini models and picks the newest `gemini-X.Y-flash(-lite)`.
- 30 s timeout per call; falls back across at most 3 models on 404/429/5xx; on a 400 it retries the audio with another file label (mime).
- Audio formats accepted: webm (Android) and m4a/mp4 (iPhone).
- Reports use typed notes and **verified** voice summaries only, from non-removed logs. Weeks with no activity get fixed text with no AI call.
- Optional secret `GEMINI_MODEL` pins a model.

Stack versions: React 19, Vite 8, TypeScript 7, vite-plugin-pwa 2, supabase-js 2, idb 8, vitest 5, Node 22 or newer.

---

## 8. How to test and deploy

- `npm test`: 50 unit tests (queue, transcript requests, drawing rules, review rules, calendar and critical path, templates, risks, backup).
- Browser tests: run `npm run build`, then `npx vite preview --port 4173 --strictPort`, then `python3 e2e/<name>.py`. They need Playwright, Pillow and Chrome at `/usr/bin/google-chrome`. Each uses a stand-in Supabase in memory and never touches real data.

  | Test | Checks | Covers |
  |---|---|---|
  | `smoke.py` | 18 | Offline log, upload, no-overwrite retries |
  | `register.py` | 13 | Projects and drawing register |
  | `ai.py` | 13–14 | Review and reports; the report-due check runs only on weekends and Friday evening |
  | `logs.py` | 10 | Owner edit, remove, restore |
  | `schedule.py` | 33 | Schedule setup, critical path vs an independent count, edits, loops, freeze, reasons, flags, timeline, coordinator limits, backup ZIP |
- **Live database rule tests:** run as a `DO` block that impersonates a user and ends in `raise exception 'RESULTS: …'`, so everything rolls back.
  - Set `request.jwt.claims` with `set_config(..., true)` and `execute 'set local role authenticated'`.
  - Results so far: 11 core, 12 register, 15 AI layer, 15 log-edit and 23 schedule checks, all passed.
  - Creating test users in `auth.users` from Claude is **blocked by the permission system**; use Jainam's real two user ids inside rolled-back transactions.
- Edge function check: `npx -y deno check --no-lock index.ts`.
- **Deploy order matters:** database migration first, then the edge function, then push the app. New app code that reads new columns breaks if pushed before the migration.
- Some Supabase migrations ask Jainam for confirmation in the Claude app. If unanswered within 2 minutes they time out and **nothing is applied**. Tell him, then retry when he says go.
- After DDL changes, run the Supabase security advisor. The only known warning is "leaked password protection disabled", an auth setting that may need a paid plan.

---

## 9. Traps already hit (do not repeat)

- Supabase "organisation members" are not app users. App users go in Authentication > Users.
- Supabase's default grants include delete. Always revoke all, then grant explicitly.
- Upsert needs update privilege on every column it sends. Reviews therefore use insert, then update on error 23505.
- A second FK from a table to profiles breaks `profiles(...)` embeds.
- Binary uploads in Playwright stand-ins: parse JSON bodies only for REST and sign URLs.
- Gemini free tier: intermittent 503 (busy) and 429 (per-minute quota, especially from parallel bursts). Calls run one after another, with model fallback.
- iPhone PWAs upload only while the app is open (no Background Sync). Keep the unsent count visible and sync on open.
- `rm` of paths outside the workspace (e.g. `/deno.lock`) is blocked. Use `deno check --no-lock`.
- WebFetch to some sites needs approval that may go unanswered; use WebSearch instead.

---

## 10. Security rules to keep honouring

- Never ask for or accept in chat: the database password, the Supabase secret/service key, or the Google (Gemini) key. Only the publishable key is safe in chat or code.
- Nothing goes to clients or vendors from the app; Jainam shares it himself.
- No client logins until access rules pass a proper review (planned for months 4–6 originally; Jainam has not approved any client access).
- The free tier has no backups: download one weekly (Projects page) and keep it on the shared drive. The restore drill is still to do.
- India's DPDP Act duties are enforceable from mid-May 2027. Plan for consent at onboarding, access logs and deletion at project close (planning guidance, not legal advice).

---

## 11. What to build next

### 11.1 Small pending items (do before or alongside Schedule)
1. **Phone checks Jainam still owes:**
   - Transcribe the real voice note in Review.
   - Confirm it as himself, then as the studio account.
   - Draft a Gujarati or Hindi report.
   - Edit, remove and restore a log.
   - Check the studio account sees no Edit option.
2. **Backup:** download is built (Projects page, owners). Still to do: a **restore drill** (load a backup ZIP into a fresh database and compare counts) and a script to check a ZIP.
3. **Verification decision:** keep Jainam + the studio account, or the studio account alone with a "checked with team member" tick.
4. **Display names** for the two accounts (`profiles.full_name`).
5. **Add Aggrawal Atelier** with its rooms, trades and sheets.
6. Drawing-issue **acknowledgement** (sent → acknowledged → print posted) and the 48-hour reminder. Not built.
7. "Revision marked GFC → supersede older, list holders, draft 'R1 replaces R0' message, create a replace-print task". Partly covered by flags; the message draft and task are not built.

### 11.2 Decisions and variations (part of the planned "site log and decisions" module; not built)
- **Decision:**
  - type (RFI / approval / site instruction), question, answer, decided by, date, cost impact, linked sheet or BOQ item.
  - Status: open → answered → confirmed in writing → closed.
- **Variation:**
  - proposed → costed → client approved → executed → billed.
  - A decision with cost impact creates a proposed variation.
- **AI:** draft decisions from voice notes. They stay unverified until confirmed, like summaries.
- **WhatsApp:** each confirmed decision gets a drafted confirmation message for the project group (Jainam sends it).

### 11.3 Schedule (part 1 live 23 Nov; part 2 next)

**Live:** task fields, After links, stage templates, critical path, baseline and reasons, change log, sheet gate (R0), phone tab with critical strip, desktop timeline, Today risks. **Part 2 still to build:** procurement items and order-by dates (and the "needs material on site" gate), the calendar views, drafted messages for automations (late milestone client note, order-by reminder), decision link on a change reason, and auto-prompting the freeze when work orders exist (Money module). Working days default Mon–Sat with a per-project holiday list.

- **Task fields:**
  - stage, task, trade, room, owner, duration, "After" (finish-to-start predecessors), planned start and end (**calculated, never typed**), baseline end, status, milestone flag.
  - Status: planned → in progress → done; blocked; slipped (derived).
- **Gates:** "needs sheet at R0/GFC" and "needs material on site".
- **Stage templates** (generated on new project, with default durations and predecessors):

  | Stage | Template tasks | Exit gate |
  |---|---|---|
  | Concept | Brief, site measure, layouts, mood | Client approves layout |
  | Design development | Elevations, 3D, materials, estimate | Design freeze signed |
  | Working drawings | Electrical, RCP, HVAC, plumbing, joinery, tiling | All sheets at R0 |
  | BOQ and tendering | BOQ per trade, quotes, comparison | Work orders issued |
  | Procurement | Long-lead list, samples, orders | Long-lead items ordered |
  | Execution | Civil, rough-ins, ceiling, carpentry, tiling, paint, fixtures | Trades done, bills certified |
  | Snagging | Snag list by room, rectification | Zero open snags |
  | Handover | Final bills, as-built set, warranties, final fee invoice | Client sign-off |
- **Critical path in our own code:** forward and backward pass, float, critical = zero float. Recalculated on every change.
- **Baseline:** frozen when work orders are issued. Re-baseline needs owner approval. A date change requires a reason linked to a decision. Summary row: forecast finish vs baseline, days of slip.
- **Procurement:**
  - Fields: item, trade, room, spec approved, supplier, lead time, need-on-site date, ordered date, expected date.
  - Order-by date = need date − lead time.
  - Status: specified → approved → ordered → on site; at risk (derived).
- **Automations** (flag and draft only, never send):

  | Trigger | Condition | Action |
  |---|---|---|
  | Task end passes | Not done | Mark slipped, re-forecast dependents, flag owner |
  | Milestone forecast | More than 7 days past baseline | Dashboard risk, draft client note |
  | Task starts in 7 days | Linked sheet not GFC | Flag blocked |
  | Daily check | Order-by within 7 days, not ordered | Flag, draft message |
  | Expected delivery passes | Not on site | Re-forecast linked task |
- **Views:**
  - **Timeline (desktop):** bars, critical in forest green, float as an outline, baseline thin line, order-by ring, milestone diamonds, "After" column with arrows only for the selected task, editing on desktop only.
  - **Phone:** read-only critical-path strip on the project page.
  - **Calendar:** 8 entry types (milestones, orders, sheets due, visits, fees, bills, decisions, reports), all derived except site visits. Agenda on the phone; month and week on desktop. Filter by project and type. Only milestones carry colour. Tapping opens the source record. Week starts Monday. Later: a feed into the phone's own calendar.
  - Wireframes for all of these are on the design canvas.

### 11.4 Money (full version)
- **BOQ item:** trade, room, quantity, rate, and four amounts: budget, committed, certified, paid.
- **Budget view:** trade totals; tap a trade for its BOQ items. Clients see it read-only, as a shared report or PDF, not a login.
- **RA bill:**
  - agency, claimed, certified, GST, status.
  - Status: submitted → measured → certified → client approved → paid.
- **Fee invoice:**
  - milestone, amount, GST, due date.
  - Status: scheduled → raised → due → paid or overdue. A milestone can trigger it.
- **Quote:** received → compared → accepted or rejected. A work order is tracked, not issued.
- **Automations:**

  | Trigger | Condition | Action |
  |---|---|---|
  | RA bill certified | Item over budget by more than 5% | Flag overrun, require a linked variation |
  | RA bill client-approved | Unpaid after 7 days | Draft reminder to client |
  | Fee milestone reached | Invoice not raised | Prompt GST invoice |
  | Fee invoice overdue | — | Draft reminders at 3 and 10 days |

### 11.5 Later
- AI risk explanations (rules detect, AI only explains) and AI revision diffs (as a checklist).
- Client login only after an access review; months 4–6 in the original plan.
- Things deliberately left out: vendor payment ledger and POs; reading or automating WhatsApp; AI progress percentages; Gantt editing on the phone; a native app; SMS sign-in.

---

## 12. Original plan context (8 phases, 14 Nov)

1. **Discovery.** Problems ranked by cost: old drawing built, material late, decisions lost (the root cause), payment delayed.
2. **Domain model.** One project, four ledgers, one named owner per record:

   | Ledger | Records |
   |---|---|
   | Time | stage, task, milestone, procurement item |
   | Drawings | drawing, revision, issue |
   | Money | BOQ item, quote, work order, RA bill, payment, fee invoice |
   | Decisions | site log, observation, decision, variation |

   Cross-links: decision → revision; decision → variation → BOQ item; GFC revision → task; procurement item → task; RA bill → progress; verified observation → progress.
3. **Modules:** Schedule, Drawings, Procurement, Money, Site log & decisions, Reports, Portfolio (derived). Automations are in 11.3 and 11.4.
4. **AI layer:** rules detect, AI drafts, a person makes it official. Every AI item shows its source and an "unverified" label. Unverified items never reach client reports. Items unverified after 7 days are flagged stale, never auto-accepted. The audit keeps who verified and the original AI text.
5. **Build route:** research picked custom PWA + Supabase. Jainam then chose ₹0 only, so: free tiers; our own critical path instead of a Gantt licence (about ₹71,000 for SVAR PRO); no paid developer review (risk accepted, mitigated by tests and team-only use). Gemini free tier rather than Sarvam (Sarvam is better on Gujarati at about ₹0.49/min; the trade-off is that the free tier may use prompts to improve Google products, hence voice and text only).
6. **UX:** wireframes on the canvas. The site log is one screen in under a minute. The dashboard leads with "Needs you". The unsent count is always visible.
7. **Roadmap:** full versions, in this order: log + drawings → AI + report → schedule → money → hardening. Jainam raised his hours to aim for one week; in practice it is module by module, each proven on a phone.
8. **Ten risks:**

   | # | Risk | Mitigation |
   |---|---|---|
   | 1 | Scope outruns hours | One module at a time |
   | 2 | Logging fades | Under a minute per log; Jainam reads logs daily |
   | 3 | WhatsApp stays the real system | Decisions confirmed in the group by a drafted message |
   | 4 | Register drifts from drive and site | Issue only through the register; audit 5 sheets a week |
   | 5 | iPhone loses an offline log | Read-back, unsent count, test both phones |
   | 6 | Unreviewed access rules | Team only, tests, review before client access |
   | 7 | Free tier pauses, fills or changes | Weekly export, restore drill, swappable providers |
   | 8 | Wrong transcript becomes record | Two-person verification with source audio |
   | 9 | Agencies and clients ignore it | Ask nothing new of them |
   | 10 | Only one person understands it | Second owner, plain exports, monthly maintenance hour |

---

## 13. How Jainam likes to work

- Show pictures over text: diagrams and tables, not long bullet lists. Short replies; he reads on a phone.
- Anything with more than a couple of steps: give a short plan with assumptions, then carry on. Quick questions get quick answers.
- Stop and ask only when a wrong guess is expensive (irreversible, long to redo, ambiguous). Ask 1–2 specific questions and state your default.
- Check work with tests that could catch an error. Never call something verified or tested unless the check was done. A failed, unfixed check goes at the top.
- Hand back: the result first, then short "Checked" and "Unsure" notes only when there is something to say.
- Tell him when his approach looks wrong or a problem he didn't ask about exists.
- Defaults: metric, rupees, Indian codes and market conditions.
- Full playbook: https://claude.ai/artifact/ATHq2qBB7QKMXD87ddRqYU

---

## 14. Commit history

```
daa8ebf Handover: schedule part 1 and backup are live
98254c2 Schedule part 1 and owner backup download
e27dfe8 Add handover document and build-route research report
4b6486c README: log editing and removal
b0cb21e Owners can edit, remove and restore site logs and remove single photos
cf36bb9 AI layer: voice-note transcripts, two-person review queue, weekly report drafts
633655c Add project editing and removal, and the drawing register
c0fb987 Say '1 photo' and show voice notes in the latest logs
5c63bef Move the team check into a private schema
978ac89 Tighten database privileges after testing on the live project
331e190 Build without the .env file present
6daf69f Add sign-in, projects and offline site log
```
