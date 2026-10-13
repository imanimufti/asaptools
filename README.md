# ASAP — asap.tools

Share one link, everyone paints when they're free, and ASAP finds the time that works for the
people who matter. A deterministic scheduler (no LLM) whose certainty shows as motion: a teal
nebula that calms as answers arrive and settles gold when the meeting locks.

- **Proposal (what it does, how it works, roadmap):** [`docs/PROPOSAL.md`](docs/PROPOSAL.md)
- **Development log:** [`docs/DEVLOG.md`](docs/DEVLOG.md)
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

- **Homepage = the calendar:** name the meeting, pick 7 or 30 days, add people as Attendee,
  Required or Decision maker, paint your times, send.
- **Invite links:** each person gets their own link (`/s/:token`), with no account needed. Links
  are emailed when Resend is set up; the organizer can always copy them again from the people
  list, or reset a lost one.
- **Painting:** drag-paint *free* / *if need be*. Phones show one day at a time, with 44px cells
  and long-press for *if need be*; 30-day windows page by week on desktop. Shading shows how many
  people can make each time.
- **Finding the time:** runs automatically once everyone has answered (or when the organizer
  clicks **Find the time now**). It never picks a time without the organizer, decision makers or
  Required people.
- **Reveal and lock:** the orb docks on the winning cell; one proposal, alternates, ⓘ reasons,
  "why not" on any other time, below-quorum warning. Lock sends confirmations.
- **Reschedule (CUJ-4):** an attendee taps *Can't make it anymore* → the meeting turns amber → the
  organizer chooses *Find a new time* (reuses everyone's answers) or *Keep it without them*.
  Re-locks show history (old time struck through) and email everyone.
- **No common time (CUJ-5):** the orb won't settle; the organizer can ask each blocking person to
  flex (they get a one-tap *Sure* / *Can't* that names no one) or widen the window to 30 days.
- **Add someone after lock (CUJ-6):** they paint; if the locked time works nothing moves,
  otherwise the organizer picks *Invite as optional* or *Find a new time for all*.
- **Meeting space (CUJ-7, `/m/:token`):** after lock, the meeting as a star and attendees grouped
  by city. Shift-drag (or **Move**) into a city's halo = in person there, onto a person = remote
  with them, open space = home. Drops are saved for everyone.
- **Privacy:** before lock, invitees only ever get per-time counts, never names or who painted
  what. This is enforced in the API and covered by tests. Supabase's public API keys can't read
  any table.

## Not built yet

| Item | Why it waits |
|---|---|
| Google Calendar (event write, decline webhooks, conflict hints) | Needs a Google Cloud OAuth client from you |
| Supabase Realtime (the page polls every 5s for now) | Needs the Supabase project |
| Magic-link claim | Fast follow |
| Rate limiting, retention job | Hardening before launch |
| 365 / 3,365-day views | Later (decision D3) |
