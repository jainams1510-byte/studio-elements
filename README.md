# Studio Elements project tool

A phone-first app for running interior projects: site logs, drawings, schedule and money.
Built so far: sign-in, projects (add, edit, remove, restore), the site log with an offline queue,
and the drawing register (sheets, P/R revisions, issues to site, out-of-date print flags).

## What is in here

| Path | What it is |
|---|---|
| `src/` | The app (React, TypeScript) |
| `src/queue.ts` | Saves logs on the phone and uploads them when there is signal |
| `src/drawings.ts` | Revision codes and the rules for what the site holds |
| `supabase/001_init.sql` | Database part 1: people, projects, site log, photo storage |
| `supabase/002_drawing_register.sql` | Database part 2: drawing register |
| `e2e/smoke.py` | Browser test of sign-in and the offline site log, mocked server |
| `e2e/register.py` | Browser test of project editing and the drawing register, mocked server |
| `.env` | Supabase address and public key (public by design) |

## One-time setup

1. **Database.** Supabase dashboard, SQL editor: run `supabase/001_init.sql`, then `supabase/002_drawing_register.sql`.
2. **People.** Supabase dashboard, Authentication: add each team member with an email and a password.
   Then switch off new sign-ups, so only people you add can get in.
3. **Hosting.** Cloudflare Pages: connect this repository. Build command `npm run build`, output folder `dist`.
4. **Phone.** Open the site address, add it to the home screen, sign in.

## Working on it

```
npm install
npm run dev      # run locally
npm test         # upload-queue and drawing-rule tests
npm run build    # production build
```

End-to-end test: `npm run build`, then `npx vite preview --port 4173 --strictPort` in one terminal
and `python3 e2e/smoke.py` in another (needs Python with Playwright and Pillow, and Chrome).

## Rules the code keeps

- A log is removed from the phone only after the server has accepted every file and the record.
- Every log has an id made on the phone, so a retried upload never creates a duplicate.
- Nothing can be deleted from the app. Removing a project hides it; it can be restored.
- Only signed-in team members can read or write anything.
