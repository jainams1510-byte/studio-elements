# Studio Elements project tool

A phone-first app for running interior projects: site logs, drawings, schedule and money.
Built so far: sign-in, projects (add, edit, remove, restore), the site log with an offline queue,
the drawing register (sheets, P/R revisions, issues to site, out-of-date print flags), and the AI layer
(voice-note transcripts and summaries, a two-person review queue, weekly client and internal report drafts).

## What is in here

| Path | What it is |
|---|---|
| `src/` | The app (React, TypeScript) |
| `src/queue.ts` | Saves logs on the phone and uploads them when there is signal |
| `src/drawings.ts` | Revision codes and the rules for what the site holds |
| `src/review.ts` | When an AI summary counts as verified; report weeks |
| `supabase/003_ai_layer.sql` | Database part 3: AI results, reviews, weekly reports |
| `supabase/functions/ai/` | Server function that calls Gemini (transcribe, weekly_report) |
| `supabase/001_init.sql` | Database part 1: people, projects, site log, photo storage |
| `supabase/002_drawing_register.sql` | Database part 2: drawing register |
| `e2e/smoke.py` | Browser test of sign-in and the offline site log, mocked server |
| `e2e/register.py` | Browser test of project editing and the drawing register, mocked server |
| `e2e/ai.py` | Browser test of the review queue and weekly reports, mocked server and AI |
| `.env` | Supabase address and public key (public by design) |

## One-time setup

1. **Database.** Supabase dashboard, SQL editor: run `supabase/001_init.sql`, `002_drawing_register.sql`, then `003_ai_layer.sql`.
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
- Nothing can be deleted from the app. Removing a project hides it; it can be restored.
- Only signed-in team members can read or write anything.
- An AI summary changes nothing official. It is verified only when two different people confirm it,
  one of them the coordinator or an owner; editing it clears every confirmation.
- Weekly reports use typed notes and verified voice summaries only. An approved report is never
  overwritten by a new draft, and nothing is sent from the app: you share it yourself.
