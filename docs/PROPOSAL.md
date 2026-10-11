---
title: ASAP — Product Proposal
aliases: [ASAP, asap.tools]
tags: [asap, proposal, product]
status: v1 in progress
updated: 2026-10-11
---

# ASAP — Product Proposal

**asap.tools** · Share one link. Everyone paints when they're free. ASAP finds the time that
works for the people who matter.

> Full engineering spec: [`ENGINEERING_HANDOFF.md`](../ENGINEERING_HANDOFF.md). Work history: [Development log](DEVLOG.md).

---

## 1. The problem

Calendars know when you're busy. They don't know whether a meeting is **viable**.

A normal scheduler asks, *"Are these calendars free?"*
ASAP asks, *"Can the people required to make this meeting useful actually attend?"*

Meetings fail when the decision maker can't come, when the time is 6am for someone in
London, or when a slot "works" because half the room quietly said *if I must*. Existing tools
treat everyone as interchangeable and leave the organizer to reconcile replies by hand.

## 2. What ASAP does

1. **The organizer opens asap.tools.** The homepage *is* the calendar: there's no signup and no
   landing page.
2. They name the meeting, pick a duration, add people and **mark the decision makers**.
3. They paint their own free times and press **Send invites**.
4. **Each person gets their own link.** It opens straight on the grid, with no account or login.
   They paint times as *free* or *if need be*.
5. **When everyone has answered, ASAP picks the best time.** The organizer can also ask it to
   decide early. It weighs who's required, how many can come, time zones and working hours.
6. **The organizer locks it.** Everyone gets a confirmation.
7. **If something changes** (a decline or a new person), ASAP proposes a repair and the organizer
   decides. *(Coming next; see §6.)*

## 3. What makes it different

### Motion shows certainty
A living particle **nebula** acts as a certainty gauge, not a mascot:

| Meeting state | What you see |
|---|---|
| Collecting answers | Teal, fast, chaotic swirl that gets denser and calmer with every reply |
| Thinking | The orb swells to the centre of the screen (~2s) |
| Proposed | It docks onto the winning time on the grid, which turns gold |
| Locked | A slow gold breath, nearly still |
| No time works / conflict | Amber; visibly refuses to settle |

Every state has exactly one look, so you can read where things stand without reading text. There
are no spinners anywhere.

### An honest "AI" that never acts alone
- **No LLM.** The engine is a deterministic, versioned formula. The same inputs always give the
  same answer, and every choice can be explained.
- It speaks in first person ("*I found a time that works for all 6 of you*"), but every sentence
  comes from a fixed template filled with the score breakdown.
- Its reasoning sits behind an ⓘ: who's free, who's *if need be*, decision makers, working hours,
  and how many alternatives scored lower.
- **It recommends; people decide.** It never books, re-books, nags or edits anyone's availability
  on its own.

### Privacy by default
- Invitees see only **how many** people can make each time, never who.
- The organizer sees everything.
- This is enforced on the server, and Supabase's public database keys can't read any table.

## 4. How it works

```
Browser (asap.tools)                       Netlify
  calendar grid + nebula orb   ──────►  Function  /api/*
  computes motion locally                    │
        ▲                                    ├──►  Postgres (Supabase)
        └──── state + response counts ───────┤
                                             └──►  Resend (email)
```

- **Hosting:** Netlify serves the app and runs the API as a serverless function. The PRD pages are
  served at `asap.tools/prd`.
- **Database:** Supabase Postgres. All access goes through the API; tables are locked to the
  public keys.
- **Links:** every person's link carries a random token. Only a keyed hash of it is stored, so a
  database leak doesn't leak working links.
- **Time zones:** times are stored in UTC and shown in each viewer's local time. The window is
  defined in the organizer's time zone.

### The scoring formula

```
candidates = start times where every REQUIRED person (decision makers + organizer)
             painted every slot the meeting covers

score = 1.0 × share painted free
      + 2.0 × all decision makers present
      + 2.0 × share who can attend
      + 1.0 × share inside working hours (8am–7pm local)
      − 0.5 × share only "if need be"
```

- **Soft quorum:** all decision makers, plus at least half the invitees when there are more than
  three. A time that misses quorum can still be proposed, but with a **Below quorum** warning.
- **No candidate:** ASAP names the cheapest fix ("*Closest: Wed 4pm — only Ken is busy*") instead
  of guessing.
- **Weights:** they live in `lib/scoring.v1.json`, and every proposal records which version
  scored it.

## 5. What's built (v1 core, Oct 11 2026)

- **Calendar homepage:** create, add people, tag decision makers, paint, send.
- **Invite links:** a personal link per person. Emailed when Resend is configured, otherwise shown
  to copy.
- **Painting:** drag to paint *free* or *if need be*. Phones show one day per screen with 44px
  cells and long-press for *if need be*. A heatmap shows how many can make each time.
- **Auto-compute:** when the last person answers, or on demand.
- **Reveal:** orb beat, one proposal, alternates, ⓘ reasons, "why not" on any other time,
  below-quorum chip.
- **Lock,** with confirmation emails.
- **No common time:** amber state, plus the cheapest flex suggestion.
- **Organizer tools:** who's responded, and fresh links if someone loses theirs.
- **Privacy split** enforced in the API; database locked down.
- **Tests:** 18 automated tests, including end-to-end and privacy checks.

## 6. Planned features

### Next (rest of v1)

| Feature | What it does |
|---|---|
| **Reschedule loop** | A decline turns the locked meeting amber. The organizer chooses *find a new time* or *keep it without them*. Everyone's existing answers are reused, so no one repaints. History shows ~~Tue 2pm~~ → Thu 10am. |
| **Google Calendar** | Locking writes the event to the organizer's calendar with invitees as guests. Reschedules update the same event, and declines in Google trigger the reschedule loop. Optional conflict nudges for the organizer. |
| **Flex asks** | When no time works, the organizer sends the blocking person a one-tap *Sure* / *Can't*. *Can't* leads to widening the date window. |
| **Add someone after lock** | A calendar or availability check. If it's clear, nothing moves; if not, the organizer picks an optional invite or a re-run. |
| **Meeting space** (`/m/:id`) | A live graph: the meeting as a star, people as nodes clustered by city. Drag someone into a city's halo to attend in person, onto a person to attend remotely with them. |
| **Live updates** | Supabase Realtime, so the orb reacts the instant someone answers (today the page refreshes every 5s). |
| **Longer horizons** | 30-day, 365-day and 3,365-day calendar views for planning far ahead. |
| **Claim your history** | A magic link turns a guest into an account without losing past meetings. |
| **Hardening** | Rate limiting, a 90-day anonymization of guest data, and a reduced-motion polish pass. |

### v2

| Feature | What it does |
|---|---|
| **Breakout rooms ("blobs")** | Drag two or more people together in the meeting space to spawn a room. Drag your own node in to join live video and out to leave. Rooms persist until closed. The video provider (Daily vs LiveKit) is decided at the end of week 6. |
| **Async attendance** | Keep the slot and attend later via a recording and recap, shown honestly as "5 live + 1 async". |
| **Recurring series** | Offered only after a successful lock. Each occurrence has its own state and can be repaired alone. |
| **Invitee conflict nudges** | Invitees connect their calendar to get "this clashes with your 1:1" hints. |

### Not planned
Outlook/CalDAV, Slack, SMS or push notifications, and any LLM-written copy, unless demand data
says otherwise.

## 7. Success measures

- **Lock quality (primary):** every decision maker attends and, for more than three invitees, at
  least half attend.
- **Median time from create to lock:** under 24 hours.
- **Response rate:** at least 80%.
- **Zero silent reschedules:** every change is announced, with history.

## 8. Going live

See [`SETUP.md`](../SETUP.md): create a Supabase project, link the repo in Netlify, and add two environment
variables. Email via Resend is optional.
