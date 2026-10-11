# ASAP — asap.tools

Share one link, everyone paints when they're free, and ASAP finds the time that works for the
people who matter. A deterministic scheduler (no LLM) whose certainty shows as motion: a teal
nebula that calms as answers arrive and settles gold when the meeting locks.

- **What to build and why:** [`ENGINEERING_HANDOFF.md`](ENGINEERING_HANDOFF.md) (the source of truth)
- **Long-form PRD:** `prd-site/`, served at asap.tools/prd
- **Going live:** [`SETUP.md`](SETUP.md)

## Layout

| Path | What |
|---|---|
| `app/` | The web app (Vite, plain JS). `app/src/nebula.js` is the motion engine, used as-is. |
| `lib/` | Code shared by the app and the API: slots/timezones, scoring engine, copy templates. |
| `lib/api.js` | The `/api/*` handlers. `netlify/functions/api.mjs` serves them on Netlify. |
| `supabase/migrations/` | Database schema. |
| `tests/` | Unit tests plus end-to-end API tests against Postgres. |
| `prd-site/` | PRD pages. |
| `design/` | Wireframe decks and the interactive prototype (reference only, not shipped). |

## Run it locally

Needs Node 22 and a Postgres database.

```bash
npm install
cp .env.example .env        # set DATABASE_URL and TOKEN_SIGNING_SECRET
npm run db:migrate
npm run dev                 # http://localhost:8888
npm test
```

## What works today

- **Homepage = the calendar:** name the meeting, add people (mark decision makers), paint your
  times, send.
- **Invite links:** each person gets their own link (`/s/:token`), with no account needed. Links
  are emailed when Resend is set up; otherwise they're shown to copy.
- **Painting:** drag-paint *free* / *if need be*. Phones show one day at a time, with 44px cells
  and long-press for *if need be*. Shading shows how many people can make each time.
- **Finding the time:** the scorer runs automatically once everyone has answered (or when the
  organizer clicks **Find the time now**). It never picks a time without the decision makers and
  the organizer.
- **Reveal:** the orb swells, then docks on the winning cell. One proposal, with alternates behind
  a button, ⓘ reasons, "why not" on any other time, and a below-quorum warning.
- **Lock,** with confirmation emails.
- **No common time:** the orb turns amber and names the closest time and who's blocking it.
- **Privacy:** invitees only ever get per-time counts, never names or who painted what. This is
  enforced in the API and covered by tests. Supabase's public API keys can't read any table.

## Not built yet

| Item | Handoff section |
|---|---|
| Reschedule loop | 5.4 |
| Sending flex asks / widening the window | 5.5 |
| Add attendee after lock | 5.6 |
| Meeting-space graph `/m/:id` | 5.7 |
| Google Calendar | 12 |
| Supabase Realtime (the page polls every 5s for now) | 7 |
| Magic-link claim | 3 |
| Rate limiting | 10 |
| Retention job | 12 |
| 30 / 365 / 3,365-day calendar views | asap.tools wireframes 3b–3d |
