# ASAP — Engineering Handoff (full context log)

**Read this first.** It covers everything the product owner and design agreed: what we're building, why, every decision made, and where each reference file lives. If the code and this doc disagree, this doc wins. Open questions are listed in §14.

- Product site (to build): Netlify site serving `asap.tools`
- PRD site (already written, static): `prd-site/` → deploy as `asap.tools/prd`
- Date: Oct 11 2026 · Plan: **v1 in 6 weeks**, Fast team (4 eng + 1 designer + motion contractor)

---

## 0. Project files and what each is for

| File | What it is | How to use it |
|---|---|---|
| `design/Nebula Habitats.dc.html` | Interactive reference prototype: grid + orb, meeting-space graph, landing nebula | **Source of truth for motion and feel.** Open in a browser. |
| `design/Nebula Habitats - Bundled.html` | Same prototype as one offline file | Send to people; don't edit it. |
| `app/src/nebula.js` | `<nebula-field>` web component: canvas particles plus graph physics | **Used as-is by the app** (see §7). |
| `CUJ Wireframes.dc.html` (not in repo yet) | Wireframes of every journey (ids 1a–3d) | Source of truth for flows. CUJ ids below refer to it. The deck below has the same content. |
| `design/CUJ Wireframes Deck.dc.html` + `design/CUJ-wireframes.pptx` | The same wireframes as a slide deck | For presenting. |
| `hyperframes-composition.html` (not in repo yet) | 21.5s motion composition for the video | Shows motion timing; the marketing video uses reveal 2a. |
| `prd-site/*.html` | Product, Backend, Integration PRDs + Decision Log | Long-form detail; this doc summarizes all of it. |
| `design/support.js`, `deck-stage.js` | Prototype runtime | **Not production code.** Ignore. |

---

## 1. The one principle

**Motion is uncertainty made visible.** The nebula is a certainty gauge, not a mascot.

- Open meeting: fast, chaotic swirl (teal).
- Each response adds density and slows the swirl.
- Locked: slow breathing (gold).
- Conflict: amber flicker, swirl speeds back up. **Motion changes before any text appears.**

Every backend state has exactly one motion signature, so users can read state without reading text.

Copy rules:
- The AI speaks in first person ("I found a time that works for all 6 of you").
- Reasoning sits behind an ⓘ tap.
- No personality beyond professional motion.
- The AI flags, recommends and drafts. **It never acts on its own**: no auto-rebooking, no auto-nagging, no editing anyone's availability.

---

## 2. v1 scope

**Ships in v1:**

| CUJ | Feature |
|---|---|
| 1b–1d | Core loop: create → paint → reveal → lock |
| 1e | Reschedule loop |
| 2f | No-common-slot negotiation (**without** the best-5 exit) |
| 2g | Add attendee after lock |
| 1f | Meeting-space knowledge graph with drag physics and semantic drops |
| 2d | Mobile invitee paint view |
| — | Calendar homepage: asap.tools opens straight on the scheduling page (1g landing page dropped, see §5.8) |

**Not in v1:**

| CUJ | Feature | Status |
|---|---|---|
| 2e | Keep-partial / async attendee contract | v2 |
| 2h | Recurring series | v2 |
| t3 (3a–3d) | Breakout blobs / live rooms | v2 (**the groundwork ships in v1**, see §11) |
| 1C-3 | Invitee-side conflict nudges | v1.1 (needs invitee OAuth) |
| — | Outlook, CalDAV, ICS, Slack, push, SMS, any LLM API | Out of scope |

**Reveal pattern: 2b, grid-anchored.** The orb shrinks and docks onto the winning grid cell. A popover shows one proposal plus a "Why not [slot]?" link to question any other slot. Alternates are behind a button. After lock, the gold cell stays on the grid as the record. (2a, the cinematic takeover, is only for the marketing video.)

---

## 3. Roles and privacy

| Role | Auth | Sees |
|---|---|---|
| Organizer | Guest token (+ optional Google OAuth) | Everything: per-person paints, scores, full breakdown |
| Decision-maker (DM) | Guest token | Aggregate heatmap only |
| Invitee | Guest token | Aggregate heatmap only (count per cell) |

- **The organizer tags DMs. More than one is allowed.**
- **No one signs up.** Every participant is a guest using a signed link. A magic link (Resend) lets a guest claim their history into a real account later.
- **Privacy rule:** invitees never see who painted what. **Supabase RLS enforces this server-side** (not just the UI).
- The only exception is the 2f flex ask. The asked invitee is told "everyone else can do X", which reveals the aggregate but not individuals.

---

## 4. Nebula state machine (shared by backend and frontend)

`meetings.state` mirrors this exactly.

| State | Color | Motion | Moves to |
|---|---|---|---|
| `OPEN` | teal | Fast chaotic swirl. density ∝ responses/total; speed ∝ 1 − responses/total | all responded, or organizer forces compute → `COMPUTING` |
| `COMPUTING` | teal | Dense fast swirl; orb expands to center for ~2s | proposal ready → `PROPOSED`; no valid slot → negotiation (2f) |
| `PROPOSED` | gold | Orb docks onto the winning cell, gold outline | organizer locks → `LOCKED`; organizer picks an alternate → re-score, stays `PROPOSED` |
| `LOCKED` | gold | Slow breathing, nearly still | decline or removal → `DESTABILIZED`; meeting time passes → `CLOSED` |
| `DESTABILIZED` | amber | Gold→amber flicker, swirl speeds up | organizer picks a repair path → `RECOMPUTING` (or keeps the slot → `LOCKED`) |
| `RECOMPUTING` | amber | Amber swirl (means "working", not "broken") | → `PROPOSED`, keeping the struck-through old slot |
| `CLOSED` | — | Static | terminal |

**Palette (RGB)**, exactly as in `nebula.js` `PAL`:

```js
open:    [[73,201,166],[125,232,201],[46,143,122],[160,240,220]]
locked:  [[232,194,104],[245,217,143],[201,162,74],[255,236,190]]
resched: [[224,138,82],[240,164,136],[217,80,63],[248,196,160]]
```

UI tokens used in the PRD and wireframes:

| Token | Main | Background / tint |
|---|---|---|
| teal | `#0d9488` | bg `#e6f4f2`, cell tint `#8ed7cf` |
| gold | `#b8860b` | bg `#faf3dd`, cell `#ffe9a8` |
| amber | `#d97706` | bg `#fdeedd` |

---

## 5. CUJ specs and acceptance criteria

### 5.1 Create (1b)
- One intent field ("What's this about?") plus chips for duration, date window and people.
- The AI drafts the ask in first person and suggests windows, e.g. "I'd avoid Friday — 3 are out". The organizer can **veto** windows before sending.
- On send: Resend `invite` emails go out, the state becomes `OPEN`, and the orb appears small, fast and scattered.
- ✅ No spinner anywhere. The orb is the waiting indicator.

### 5.2 Invitee paint (1c, mobile 2d)
- The invite link opens straight on the grid. No account wall.
- Two paint levels: `free` (full teal tint) and `if_need_be` (half tint).
  - Desktop: drag-paint.
  - Mobile: one day per screen, 3 columns, cells **≥44px**, swipe between days, **long-press** for if-need-be.
- The orb drifts toward the cursor while painting.
- On submit, the shared orb gains density **live for everyone** watching (realtime).
- ✅ The organizer gets conflict nudges from Google free/busy ("Tue 2pm clashes with your 1:1 — keep it?"). The AI **never** changes paint. Invitees get no nudges in v1.

### 5.3 Reveal and lock (1d / 2b)
- When all have responded (or the organizer forces it): `COMPUTING` beat (~2s), then the orb docks onto the winning cell.
- Popover:
  - "I found a time that works for all N of you." plus an ⓘ.
  - Buttons: **Lock it** / **Show alternates** / "Why not [slot]?".
- ⓘ shows the **raw deterministic score breakdown** (§6), filled into text templates.
- On lock:
  - Write a Google Calendar event (organizer's calendar, invitees as guests).
  - Send Resend `lock_confirm`.
  - The orb settles into slow gold breathing.
  - The gold cell stays on the grid.
- If the slot misses quorum, show an amber **below-quorum warning chip** (soft rule, §6). Lock is still allowed.

### 5.4 Reschedule (1e)
- A decline arrives (Google webhook or in-app) → `DESTABILIZED`. The orb flickers before any copy appears.
- Copy: "Diego can't make Tuesday anymore. Want me to find another slot, or keep it without him?" Options:
  - **Find new time**
  - **Keep without [name]**
- Recompute reuses everyone's existing paints. **No one re-fills the grid.**
- Re-lock shows history: ~~Tue 2pm~~ → Thu 10am. Store it with `locks.superseded_by`.
- Update the **same** Google event (don't create a new one). Send Resend `resched`.

### 5.5 No common slot (2f)
- No cell works for all required people → amber orb that **visibly fails to settle**.
- The AI names the cheapest single ask: "Closest: Wed 4pm — only Ken painted it busy."
- Button: **Ask Ken to flex** (organizer-triggered only).
- Ken gets a Resend `flex_ask` with one-tap **Sure, flex it** / **Can't**. "Can't" is a valid answer.
  - Sure → lock path.
  - Can't → the AI suggests **widening the date window**, which re-enters painting for the new cells only.
- ❌ **Best-5 exit: CUT.**

### 5.6 Add after lock (2g)
- Adding a person (from the graph: drag a new node onto the star, or from a list) runs a check.
  - Known user with OAuth: calendar check. Guest: an availability ask.
  - No conflict: "Rui is free Thu 10am — adding won't move anything." Gold stays.
  - Conflict: the organizer chooses **Optional invite** or **Re-run for N+1**, which goes into 1e.

### 5.7 Meeting-space graph (1f)
- **Star** = the meeting, gold, always anchored.
- **Person nodes** settle by home city.
- **Dashed teal halo** = people in the same city.
- **Square nodes** = artifacts (agenda, docs). Tap to open.

Drag physics (already in `nebula.js`):
- Shift-drag on desktop, or the move-mode toggle.
- Pull spreads along links and gets weaker per hop.
- Links stretch elastically. The star never moves.
- The swirl speeds up during a drag.
- On release, nodes re-settle at **speed 7**.

**Semantic drops** (persist only these; positions stay client-side):

| Drop target | Meaning | Confirmation copy |
|---|---|---|
| Inside a city halo | Attend in person with that cluster | "Priya joins in-person in SF" |
| On a person node | Attend remotely, paired with them | "Priya attends from London with Amara" |
| Open space | Return to home city | — |

Every drop shows its confirmation copy with an ⓘ.

### 5.8 Homepage (replaces the 1g landing page)
- **Decided Oct 11 2026:** asap.tools opens straight on the scheduling calendar. There is no marketing landing page.
- The homepage is Create (5.1): name the meeting, paint your own times, add people, send. No signup wall.

---

## 6. Scoring engine: deterministic, no LLM

**The "AI" is a pure function plus motion. There is no LLM call anywhere in v1.**

```
candidates = cells where every REQUIRED participant painted free or if_need_be
if none → negotiation path (2f)

score = w1·free_ratio
      + w2·all_DMs_present
      + w3·attendance_ratio
      + w4·workhours_fit        // penalize outside 8am–7pm in each participant's local tz ("London guard")
      − w5·if_need_be_count
```

- **Quorum (soft rule):** all DMs present AND (invitees ≤ 3 OR attendance ≥ 50%). Slots that fail are still proposable but marked `below_quorum = true`, which shows the warning chip.
- Weights live in `scoring.v1.json` in the repo. Each proposal stores the weights version in `breakdown_json`.
- **All user-facing copy comes from templates filled from `breakdown_json` fields.** The ⓘ renders the breakdown as-is. Example template sources:
  - "all 6 painted it free"
  - "only slot inside Priya's London hours"
  - "avoids Ken's 1:1"
  - "2 alternates scored lower"
- Performance: about 6 people × ~50 slots, so milliseconds. It runs inside a Netlify Function; no queue.

**Success metric (lock quality):** every DM attends, and for meetings with more than 3 invitees, ≥50% attend.
Secondary metrics:
- Median time-to-lock < 24h
- Response rate ≥ 80%
- Zero silent reschedules

---

## 7. Frontend notes

- **Port `nebula.js` without changing its behavior.** It's a `<nebula-field>` custom element with these attributes:
  - `state` = open | locked | resched
  - `certainty`, `density`, `motion` (each 0–1)
  - `mode` = field | orb | graph
  - `nodes` (JSON)
  - `movemode` (0/1)
- It already handles:
  - Palette lerping between states
  - Particle seeding by area: orb `area/220`, field `area/1400`, clamped 40–900
  - devicePixelRatio capped at 2
  - ResizeObserver
  - Pointer drag physics with per-hop falloff and re-settling toward home positions
- **Motion is derived on the client.** The server sends only `{state, responses, total, below_quorum}`. The client computes `certainty = responses/total`, density and speed. **No animation parameters go over the wire.**
- **Reduced motion:** respect `prefers-reduced-motion`. Keep the color states but cut motion to a slow pulse. (Not in the prototype; add it.)
- Copy is first person. Reasoning is always behind ⓘ, never inline paragraphs.
- Mobile hit targets ≥ 44px.

---

## 8. Architecture

```
Client (static, Netlify CDN)
   │  writes                      ▲ realtime subscribe (anon key + RLS)
   ▼                              │
Netlify Functions /api/*  ──►  Supabase Postgres  ──►  Supabase Realtime  channel meeting:{id}
   │                              ▲
   ├─► Google Calendar (OAuth, events, watch webhooks)
   └─► Resend (all email)
```

- **All writes go through Netlify Functions.** The Supabase service-role key never reaches the client.
- The client subscribes directly to Realtime (anon key, RLS-scoped).
- Environments:
  - Git `main` → production.
  - Each PR gets a deploy preview, wired to the **staging** Supabase project.
- Migrations run with `supabase db push` in CI. Separate prod and staging Supabase projects.
- Scheduled functions (daily):
  - Google watch-channel renewal (channels expire after about 7 days)
  - Retention anonymizer

---

## 9. Data model (Postgres)

```sql
meetings      (id, title, duration_min, window_start, window_end,
               state,                       -- enum mirrors §4
               quorum_mode default 'soft',
               organizer_participant_id, created_at)

participants  (id, meeting_id, name, email,
               role,                        -- organizer | invitee
               is_dm bool,
               guest_token_hash,            -- signed link token, hashed at rest
               claimed_user_id null,        -- set on magic-link claim
               home_city, tz)

paints        (participant_id, slot_ts timestamptz,   -- UTC; render local
               level)                       -- free | if_need_be
               -- PK (participant_id, slot_ts)

proposals     (id, meeting_id, slot_ts, score, breakdown_json,
               weights_version, status, below_quorum bool)

locks         (meeting_id, proposal_id, locked_at, gcal_event_id,
               superseded_by null)          -- chain = visible reschedule history

events        (id, meeting_id, type, payload jsonb, at)   -- append-only audit

graph_nodes   (id, meeting_id,
               kind,                        -- person | artifact | blob  (blob unused in v1, reserved)
               parent_meeting_id,           -- v2 groundwork: breakout notes re-attach here
               cluster_key null,            -- semantic drop result (city / paired-with)
               ref_id)                      -- participant or artifact id
```

- An **aggregate view** `paint_counts(meeting_id, slot_ts, free_n, inb_n)` is the **only** thing invitee tokens can select.
- RLS:
  - Organizer token → full access to `paints` for their meeting.
  - Invitee token → own `paints` rows plus `paint_counts`.

---

## 10. API (Netlify Functions)

| Endpoint | Auth | Does |
|---|---|---|
| `POST /api/meetings` | none → returns organizer token | Create meeting + participants, send invites |
| `GET /api/meetings/:id` | participant token | Role-scoped view (organizer: full; invitee: aggregate) |
| `POST /api/paints` | participant token | Upsert paints, broadcast realtime counts |
| `POST /api/compute` | organizer | Run the scorer → proposals → `PROPOSED` (or start 2f) |
| `POST /api/lock` | organizer | Lock + write Google event + send `lock_confirm` |
| `POST /api/flex` | organizer | Send the 2f flex ask |
| `POST /api/flex/:id/answer` | invitee | Record Sure / Can't |
| `POST /api/participants` | organizer | Add after lock (2g), including the check |
| `POST /api/graph/drop` | participant | Persist a semantic drop (cluster change) |
| `POST /api/webhooks/gcal` | Google channel token | Detect a decline → `DESTABILIZED` |
| `POST /api/claim` | magic-link token | Guest → account; re-parent participant rows |

Security:
- Rate-limit every token-bearing endpoint.
- Verify Google channel tokens on the webhook.
- CORS: site origin only.

---

## 11. v2 breakout blobs: groundwork that MUST ship in v1

**v2 behavior (3a–3c):**

1. **Spawn:** drag 2 or more nodes together and hold ~1s. A teal proto-blob forms.
2. **Confirm:** "Go live now" or "Just a blob for later".
3. **Live blob:** solid teal ring, filled member nodes, a name label, and an × to close.
4. **Join / leave:** drag your **own** node across the ring to enter (video tiles). Drag it out to leave. No confirm dialog.
5. **Persistence:** empty blobs stay on the canvas (dashed, idle) until someone clicks or closes them.
   - **Click** opens a peek card: "Priya + Ken were here 20 min ago", with **Enter** and **Schedule →** (Schedule turns the blob into a full meeting, going to 1b with members pre-filled).
   - **×** closes the blob. Its artifacts fold back into the parent graph as square nodes.

**Build these into v1 now:**
1. Cluster hit-testing is **generic**: any n nodes, not just person→halo.
2. Drag physics stays as is. A blob is just a new kind of drop target.
3. **Solid rings are reserved.** v1 halos are always **dashed**, so "solid ring = room you can enter" stays unambiguous.
4. Artifact nodes carry `parent_meeting_id` from day one.
5. The graph canvas never auto-centers or crops. Blobs need room to park.
6. `graph_nodes.kind` includes `blob`.

**Media layer: decide at end of week 6.** The spike runs weeks 4–6 inside the live graph. Owner: infra eng.

Criteria, in order:
1. Drag-in → media connected in under 2s
2. Live presence (who's inside) visible from the graph
3. Recording (needed for the 2e async attendee feature)
4. Cost per active blob-hour

Candidates:

| Option | Assessment |
|---|---|
| **Daily** | Fastest to embed; has a recording API |
| **LiveKit Cloud** | Most UI control; open-source fallback |
| Meet/Zoom links | Ruled out unless both SDKs fail; it breaks join-by-drag |

---

## 12. Integrations

**Google Calendar** (the only calendar in v1):
- **Scopes, requested incrementally:**
  - `calendar.readonly` at create time, only if the organizer opts into nudges
  - `calendar.events` at the first lock
- **Watch channel** per locked meeting, renewed daily.
- **OAuth tokens** encrypted at rest (pgsodium). Organizer only in v1.
- **If OAuth is declined**, lock still works:
  - Confirmation falls back to the Resend email.
  - Decline detection falls back to in-app only.

**Resend** (the only notification channel). Templates live in the repo (React Email), written as templates with no generated copy:

| Template | Sent when |
|---|---|
| `invite` | Meeting created |
| `reveal` (to organizer) | State → `PROPOSED` |
| `lock_confirm` | State → `LOCKED` |
| `flex_ask` | Organizer sends a 2f flex ask |
| `resched` | Re-lock after a reschedule (old slot struck through) |
| `magic_link` | Guest claims history (15-min single-use link) |

- **SPF/DKIM** on the product domain by wk 2.

**Netlify:**
- Product site `asap.tools`: static build plus `netlify/functions/*`.
- Environment variables per context:
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY` (server only)
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_CLIENT_SECRET`
  - `RESEND_API_KEY`
  - `TOKEN_SIGNING_SECRET`

**Data retention:** guest paints and emails are anonymized 90 days after lock. After that, `events` keeps only the type and timestamp.

---

## 13. Six-week plan

| Week | Work |
|---|---|
| 1–2 | Supabase schema + RLS, guest-token auth, scoring engine + `scoring.v1.json`, core create/paint |
| 2–3 | 2b reveal, realtime orb channel, Resend invite/reveal/confirm, port `nebula.js` |
| 3–4 | 1e reschedule, 2f negotiation, 2g add-after-lock, Google event write + watch webhooks |
| 4–5 | 1f graph + semantic drops ∥ 2d mobile. **v2 media spike starts (wk 4).** |
| 5–6 | Motion contractor pass on all states, reduced-motion, hardening, launch. **Wk 6: media-layer decision.** |

Alternatives that were considered and rejected:
- Lean: 2 eng, 10 weeks
- Balanced: 3 eng, 8 weeks

---

## 14. Decision log (condensed)

**Decided** (answered by the product owner):
- v1 scope (§2)
- Reveal 2b
- Deterministic scoring, no LLM
- Google only, read + write
- Everyone is a guest; magic-link claim later
- Netlify + Supabase
- Organizer sees everything, invitees see the aggregate
- Email only
- Lock-quality metric
- Fast plan
- Soft quorum
- Multiple DMs
- Invitee nudges in v1.1
- Best-5 cut
- PRD at `asap.tools/prd`, product site `asap.tools`

**Assumed** (design's pick; overridable, ask the product owner):

| Topic | Assumption |
|---|---|
| Email provider | Resend |
| Quorum | **ALL** DMs must attend |
| Time zones | UTC storage + work-hours guard |
| Retention | 90-day anonymization |
| Privacy enforcement | RLS enforces privacy |
| Realtime | Supabase Realtime for the orb |
| ⓘ | Shows the raw breakdown |
| Scoring weights | Versioned weights file |

**Still open:**
- v2 media layer (wk 6)
- Starting values for scoring weights `w1..w5`: **eng proposes them in wk 1** and tunes them on real test meetings

---

## 15. Definition of done for v1

- [ ] Every v1 CUJ (§5) can be done end to end on desktop, and 1c/2d on mobile
- [ ] Each meeting state shows its motion signature; the orb is driven only by realtime counts
- [ ] Invitee tokens cannot read per-person paints (RLS test in CI)
- [ ] No code path calls an LLM; all copy comes from templates
- [ ] Lock writes and reschedules update a single Google event; declines trigger `DESTABILIZED`
- [ ] The AI never auto-books, auto-nags or edits paint
- [ ] v1 halos are dashed; `graph_nodes` supports `blob` and `parent_meeting_id`
- [ ] `prefers-reduced-motion` is respected
- [ ] Hit targets are ≥44px on mobile
