---
title: ASAP — Development Log
tags: [asap, devlog]
updated: 2026-10-11
---

# ASAP — Development Log

A running record of what changed, why, and what was decided. Newest first. See the [Proposal](PROPOSAL.md) for
what the product is.

---

## 2026-10-11 — v1 core built

**Commit:** `a3c173f`, *Build v1 core: calendar homepage, scoring engine, API, schema*

### Built
- **Calendar homepage** at `/`: meeting name, duration (30 min–2 hr), people with
  decision-maker flags, organizer's own painting, *Send invites*.
- **Meeting page** at `/s/:token`, the same page for organizer and invitees. What it shows
  depends on the role.
- **Paint grid** (`app/src/grid.js`):
  - Drag-paint *free* / *if need be*, plus keyboard support.
  - Phones show one day per screen with 44px cells and long-press for *if need be*.
  - Columns stay continuous when a viewer's day crosses midnight (e.g. New York hours seen from
    London).
- **Scoring engine** (`lib/scoring.js`, `lib/scoring.v1.json`):
  - Deterministic, with no LLM. Decision makers and the organizer are required.
  - Soft quorum, a working-hours guard, and the cheapest flex ask when no time works.
- **Copy templates** (`lib/copy.js`): every sentence the "AI" says, filled from the score
  breakdown.
- **API** (`lib/api.js`, served by `netlify/functions/api.mjs`):

  | Endpoint | Does |
  |---|---|
  | `POST /api/meetings` | Create a meeting |
  | `GET /api/meeting` | Role-scoped view |
  | `POST /api/paints` | Save painted times |
  | `POST /api/compute` | Find the time |
  | `POST /api/lock` | Lock a proposal |
  | `POST /api/participants/:id/link` | Make a fresh link |

- **Database** (`supabase/migrations/20261011000000_init.sql`):
  - Tables: meetings, participants, paints, proposals, locks, events, and graph nodes (with
    `blob` and `parent_meeting_id` reserved for v2).
  - A `paint_counts` aggregate view.
  - RLS on with no policies, plus grants revoked, so Supabase's public keys can't read anything.
- **Email** (`lib/email.js`): Resend invite, reveal and lock-confirm templates. When no API key is
  set, emails are logged and the links are shown to copy instead.
- **Orb** (`app/src/orb.js`): drives `nebula.js` from state and response counts only. Includes
  the reveal beat (swell to centre, dock on the winning cell) and honours reduced motion.
- **Netlify config** (`netlify.toml`): build, functions, `/s/*` and `/m/*` app routes, and the
  PRD at `/prd`.
- **Local dev:** `npm run dev` (Vite and the API on one port), `npm run db:migrate`, `npm test`.

### Verified
- **18 automated tests pass:**
  - Slot and timezone maths, including DST.
  - Scoring rules.
  - The end-to-end loop: create → paint → auto-propose → lock.
  - Invitees never receive names or per-person paints.
  - Supabase's `anon` role is denied on every table.
- **Browser walkthrough:** the organizer in New York (desktop), an invitee in London (phone) and
  an invitee in Chicago completed the full flow. The locked time showed as 10:00 AM in New York
  and 3:00 PM in London.
- **Packaging:** the function bundles with esbuild, as Netlify does, and runs.

### Decisions
- **D28 — the homepage is the calendar.** The 1g marketing landing page is dropped.
- **The name is ASAP / asap.tools;** "wenmeet" is removed from all docs.
- **One Netlify site** serves both the product (`asap.tools`) and the PRD (`asap.tools/prd`).
- **The API talks to Postgres directly** through a connection string (local Postgres in dev,
  Supabase's pooler in production), rather than through Supabase's client API. The privacy split
  lives in the API and is covered by tests.
- **Only a hash of each link token is stored.** A lost link is replaced with a fresh one (the old
  one stops working) instead of being shown again.
- **30-minute slots;** durations are 30, 60, 90 or 120 minutes. **The default window** is the next
  7 days, 8am–8pm in the organizer's time zone.
- **Required people** = decision makers + the organizer.

### Known gaps / next
- **Not built yet:** reschedule loop, Google Calendar, flex-ask sending, add-after-lock,
  meeting-space graph, Supabase Realtime (the page polls every 5s), magic-link claim, rate
  limiting, retention job, and the 30/365/3,365-day views.
- **To go live,** the owner needs to create a Supabase project and set `DATABASE_URL` and
  `TOKEN_SIGNING_SECRET` in Netlify (see `SETUP.md`).
- **One PowerPoint** (`design/CUJ-wireframes.pptx`) still says "WENMEET" on its title slide.

---

## 2026-10-11 — Repo set up

- **Uploaded:** the PRD site, the wireframe decks (HTML and PPTX), and the bundled Nebula
  prototype.
- **Added:** `ENGINEERING_HANDOFF.md`, the full spec and source of truth.
- **Added:** `nebula.js`, the `<nebula-field>` motion engine. It was taken from inside the
  bundled prototype because the pasted copy had garbled characters; the code was identical.
- **Unbundled the prototype** into an editable `Nebula Habitats.dc.html` plus `support.js` and
  fonts. It renders identically to the bundled version.
- **Reorganized the repo** into `app/`, `lib/`, `prd-site/` and `design/`.
