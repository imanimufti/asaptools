# Going live on Netlify

About 15 minutes. You need to do these yourself because each one needs your login. Never paste
keys into the repo or a chat — they go straight into Netlify's environment variables.

## 1. Supabase (the database) — required

1. Go to [supabase.com](https://supabase.com), sign in, click **New project**. Name it `asap`,
   pick a strong database password (save it in your password manager), and choose the region
   closest to your users.
2. When it's ready, click **Connect** (top of the project page) and copy the
   **Transaction pooler** connection string (port `6543`). Replace `[YOUR-PASSWORD]` in it with
   your database password. This is your `DATABASE_URL`.
3. Create the tables. Either:
   - **Easiest:** open **SQL Editor** in Supabase, paste the whole contents of
     `supabase/migrations/20261011000000_init.sql`, and click **Run**. Or:
   - **From a terminal** (needs Node 22): `DATABASE_URL='<your string>' npm run db:migrate`

## 2. Netlify (hosting) — required

1. In [Netlify](https://app.netlify.com), open the site that serves **asap.tools**.
2. **Site configuration → Build & deploy → Continuous deployment → Link repository** →
   GitHub → `imanimufti/asaptools`, branch `main`. Leave the build settings empty; they come from
   `netlify.toml`.
3. **Site configuration → Environment variables → Add a variable**, and add:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the Supabase string from step 1.2 |
   | `TOKEN_SIGNING_SECRET` | a long random string (on a Mac: `openssl rand -base64 32` in Terminal) |

4. **Deploys → Trigger deploy → Deploy site.**

Once deployed, asap.tools opens on the scheduling calendar (it replaces the current homepage)
and the PRD is at asap.tools/prd. Every push to `main` redeploys automatically.

> Keep `TOKEN_SIGNING_SECRET` the same forever. Changing it breaks every link already sent.

## 3. Resend (email) — optional for now

Without it the app still works: after you create a meeting it shows each person's link to copy
and send yourself. With it, invites and confirmations are emailed automatically.

1. Sign up at [resend.com](https://resend.com). **Domains → Add domain** → `asap.tools`.
2. Resend shows a few DNS records. Add them where asap.tools's DNS is managed (Netlify:
   **Domains → asap.tools → DNS settings → Add new record**). Wait for Resend to show
   **Verified**.
3. **API Keys → Create API key** (sending access only).
4. In Netlify environment variables add `RESEND_API_KEY` (the key) and
   `EMAIL_FROM` = `ASAP <hello@asap.tools>`, then redeploy.

## 4. Google Calendar — later

Needed when the Google integration is built (writing locked meetings to calendars, catching
declines). It needs a Google Cloud project and an OAuth client; steps will be added here then.
