# Studio Elements project tool

A phone-first app for running interior projects: site logs, drawings, schedule and money.
Built so far: sign-in, projects, and the site log with an offline queue.

## What is in here

| Path | What it is |
|---|---|
| `src/` | The app (React, TypeScript) |
| `src/queue.ts` | Saves logs on the phone and uploads them when there is signal |
| `supabase/001_init.sql` | Database tables, access rules and photo storage |
| `e2e/smoke.py` | End-to-end test in Chrome against a mocked server |
| `.env` | Supabase address and public key (public by design) |

## One-time setup

1. **Database.** Supabase dashboard, SQL editor: paste all of `supabase/001_init.sql` and run it.
2. **People.** Supabase dashboard, Authentication: add each team member with an email and a password.
   Then switch off new sign-ups, so only people you add can get in.
3. **Hosting.** Cloudflare Pages: connect this repository. Build command `npm run build`, output folder `dist`.
4. **Phone.** Open the site address, add it to the home screen, sign in.

## Working on it

```
npm install
npm run dev      # run locally
npm test         # upload-queue tests
npm run build    # production build
```

End-to-end test: `npm run build`, then `npx vite preview --port 4173 --strictPort` in one terminal
and `python3 e2e/smoke.py` in another (needs Python with Playwright and Pillow, and Chrome).

## Rules the code keeps

- A log is removed from the phone only after the server has accepted every file and the record.
- Every log has an id made on the phone, so a retried upload never creates a duplicate.
- Nobody can delete a site log from the app.
- Only signed-in team members can read or write anything.
