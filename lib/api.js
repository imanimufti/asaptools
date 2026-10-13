// The whole /api/* surface (handoff §10), as one fetch-style handler: (Request) => Response.
// Runs as a Netlify Function in production and inside scripts/dev.mjs locally.

import { getPool, tx } from './db.js';
import { newToken, hashToken, encryptToken, decryptToken } from './tokens.js';
import { generateSlots, isValidTz, todayIn, addDays, coveredSlots } from './slots.js';
import { scoreMeeting } from './scoring.js';
import { revealHeadline } from './copy.js';
import { formatSlot } from './format.js';
import { sendEmail } from './email.js';

const MAX_BODY = 200_000;
const MAX_PEOPLE = 50;
const MAX_DAYS = 31;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) fail(413, 'Request too large');
  if (!text) return {};
  try { return JSON.parse(text); } catch { fail(400, 'Invalid JSON'); }
}

const str = (v, max, field, { optional = false } = {}) => {
  if (v == null || v === '') { if (optional) return null; fail(400, `${field} is required`); }
  if (typeof v !== 'string') fail(400, `${field} must be text`);
  const s = v.trim();
  if (!s && !optional) fail(400, `${field} is required`);
  if (s.length > max) fail(400, `${field} is too long`);
  return s || null;
};
const email = (v, field) => {
  const s = str(v, 254, field, { optional: true });
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail(400, `${field} doesn't look like an email address`);
  return s;
};
const uuid = (v, field) => {
  if (typeof v !== 'string' || !/^[0-9a-f-]{36}$/.test(v)) fail(400, `${field} is invalid`);
  return v;
};

const siteOrigin = (req) => process.env.URL || new URL(req.url).origin;
const linkFor = (req, token) => `${siteOrigin(req)}/s/${token}`;
const storedLink = (req, row) => { const t = decryptToken(row.token_enc); return t ? linkFor(req, t) : null; };
export const cityOf = (tz) => (tz ? tz.split('/').pop().replace(/_/g, ' ') : null);
const iso = (d) => new Date(d).toISOString();

const meetingSlots = (m) => generateSlots({
  startDate: m.window_start, days: m.window_days, dayStartMin: m.day_start_min, dayEndMin: m.day_end_min, tz: m.tz,
});

// Keep only known slots and levels.
function cleanPaints(raw, slots) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'paints must be an object of slot → level');
  const valid = new Set(slots), out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v !== 'free' && v !== 'if_need_be') fail(400, `Unknown paint level: ${v}`);
    const d = new Date(k);
    if (Number.isNaN(d.getTime())) continue;
    const s = d.toISOString();
    if (valid.has(s)) out[s] = v;
  }
  return out;
}

async function insertPaints(db, participantId, paints) {
  const keys = Object.keys(paints);
  if (!keys.length) return;
  await db.query(
    `insert into paints (participant_id, slot_ts, level)
     select $1, s, l::paint_level from unnest($2::timestamptz[], $3::text[]) as t(s, l)
     on conflict (participant_id, slot_ts) do update set level = excluded.level`,
    [participantId, keys, keys.map((k) => paints[k])],
  );
}

const event = (db, meetingId, type, payload = {}) =>
  db.query('insert into events (meeting_id, type, payload) values ($1,$2,$3)', [meetingId, type, payload]);

async function auth(db, req) {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) fail(401, 'Missing link token');
  const { rows } = await db.query(
    `select p.*, row_to_json(m.*) as meeting from participants p join meetings m on m.id = p.meeting_id
     where p.guest_token_hash = $1`, [hashToken(token)]);
  if (!rows[0]) fail(404, 'This link is not valid anymore');
  const { meeting, ...me } = rows[0];
  return { me, meeting };
}
const requireOrganizer = (me) => { if (me.role !== 'organizer') fail(403, 'Only the organizer can do that'); };
const requireState = (m, ...states) => {
  if (!states.includes(m.state)) fail(409, `Can't do that while the meeting is ${m.state.toLowerCase()}`);
};

async function loadPeopleAndPaints(db, meetingId) {
  const parts = (await db.query(
    `select id, name, email, role, is_dm, is_required, optional, declined_at, tz, home_city, responded_at, token_enc
     from participants where meeting_id = $1 order by role, created_at`, [meetingId])).rows;
  const paints = {};
  const rows = (await db.query(
    `select p.participant_id, p.slot_ts, p.level from paints p join participants pa on pa.id = p.participant_id
     where pa.meeting_id = $1`, [meetingId])).rows;
  for (const r of rows) (paints[r.participant_id] ||= {})[iso(r.slot_ts)] = r.level;
  return { parts, paints };
}

async function currentLock(db, meetingId) {
  const { rows } = await db.query(
    `select l.id, l.locked_at, l.proposal_id, p.slot_ts from locks l join proposals p on p.id = l.proposal_id
     where l.meeting_id = $1 and l.superseded_by is null order by l.locked_at desc limit 1`, [meetingId]);
  return rows[0] || null;
}

// ---------- create ----------

async function createMeeting(req) {
  const b = await readJson(req);
  const title = str(b.title, 200, 'Meeting name');
  const tz = str(b.tz, 64, 'Timezone');
  if (!isValidTz(tz)) fail(400, 'Unknown timezone');
  const duration = Number(b.duration_min);
  if (!Number.isInteger(duration) || duration < 30 || duration > 480 || duration % 30) fail(400, 'Duration must be 30–480 minutes in 30-minute steps');
  const days = Number(b.window_days ?? 7);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) fail(400, `The window must be 1–${MAX_DAYS} days`);
  const dayStart = Number(b.day_start_min ?? 480), dayEnd = Number(b.day_end_min ?? 1200);
  if (!Number.isInteger(dayStart) || !Number.isInteger(dayEnd) || dayStart < 0 || dayEnd > 1440 || dayEnd - dayStart < duration) fail(400, 'Invalid day hours');
  const start = str(b.window_start, 10, 'Start date');
  const today = todayIn(tz);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || start < addDays(today, -1) || start > addDays(today, 366)) fail(400, 'Start date must be within the next year');

  const org = b.organizer || {};
  const organizer = { name: str(org.name, 80, 'Your name'), email: email(org.email, 'Your email'), is_dm: !!org.is_dm };
  if (!Array.isArray(b.people) || !b.people.length) fail(400, 'Add at least one person');
  if (b.people.length > MAX_PEOPLE) fail(400, `At most ${MAX_PEOPLE} people`);
  const people = b.people.map((p, i) => ({
    name: str(p?.name, 80, `Person ${i + 1}'s name`), email: email(p?.email, `Person ${i + 1}'s email`),
    is_dm: !!p?.is_dm, is_required: !!p?.is_required,
  }));

  const slots = generateSlots({ startDate: start, days, dayStartMin: dayStart, dayEndMin: dayEnd, tz });
  const paints = cleanPaints(b.paints, slots);
  const orgTz = isValidTz(org.tz) ? org.tz : tz;

  const orgToken = newToken();
  const invites = people.map((p) => ({ ...p, token: newToken() }));

  const meetingId = await tx(async (db) => {
    const { rows: [m] } = await db.query(
      `insert into meetings (title, duration_min, tz, window_start, window_days, day_start_min, day_end_min)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`, [title, duration, tz, start, days, dayStart, dayEnd]);
    const { rows: [o] } = await db.query(
      `insert into participants (meeting_id, name, email, role, is_dm, guest_token_hash, token_enc, tz, home_city, responded_at)
       values ($1,$2,$3,'organizer',$4,$5,$6,$7,$8,$9) returning id`,
      [m.id, organizer.name, organizer.email, organizer.is_dm, hashToken(orgToken), encryptToken(orgToken), orgTz, cityOf(orgTz),
        Object.keys(paints).length ? new Date() : null]);
    await db.query('update meetings set organizer_participant_id = $1 where id = $2', [o.id, m.id]);
    for (const p of invites) {
      await db.query(
        `insert into participants (meeting_id, name, email, role, is_dm, is_required, guest_token_hash, token_enc)
         values ($1,$2,$3,'invitee',$4,$5,$6,$7)`,
        [m.id, p.name, p.email, p.is_dm, p.is_required, hashToken(p.token), encryptToken(p.token)]);
    }
    await insertPaints(db, o.id, paints);
    await event(db, m.id, 'created', { people: invites.length + 1 });
    return m.id;
  });

  const sent = await Promise.all(invites.map((p) =>
    sendEmail('invite', p.email, { organizer: organizer.name, title, link: linkFor(req, p.token) }).catch(() => ({ sent: false }))));

  return json(201, {
    meeting_id: meetingId,
    organizer_token: orgToken,
    invites: invites.map((p, i) => ({ name: p.name, email: p.email, is_dm: p.is_dm, is_required: p.is_required, link: linkFor(req, p.token), emailed: sent[i].sent })),
  });
}

// ---------- view ----------

async function buildView(db, me, meeting) {
  const slots = meetingSlots(meeting);
  const [counts, mine, lock, history, nodes] = await Promise.all([
    db.query('select slot_ts, free_n, inb_n from paint_counts where meeting_id = $1', [meeting.id]),
    db.query('select slot_ts, level from paints where participant_id = $1', [me.id]),
    currentLock(db, meeting.id),
    db.query(`select p.slot_ts from locks l join proposals p on p.id = l.proposal_id
              where l.meeting_id = $1 and l.superseded_by is not null order by l.locked_at`, [meeting.id]),
    db.query(`select ref_id, cluster_key, mode from graph_nodes where meeting_id = $1 and kind = 'person'`, [meeting.id]),
  ]);
  const { parts, paints } = await loadPeopleAndPaints(db, meeting.id);
  const active = parts.filter((p) => !p.declined_at);
  const responses = active.filter((p) => p.responded_at).length;
  const myFlex = (await db.query(
    `select id, slot_ts from flex_asks where participant_id = $1 and status = 'pending' order by created_at desc limit 1`, [me.id])).rows[0];
  const canPaint = ['OPEN', 'PROPOSED'].includes(meeting.state) || (meeting.state === 'LOCKED' && !me.responded_at);

  const view = {
    role: me.role,
    me: { id: me.id, name: me.name, is_dm: me.is_dm, responded: !!me.responded_at, declined: !!me.declined_at, can_paint: canPaint },
    meeting: {
      id: meeting.id, title: meeting.title, duration_min: meeting.duration_min, tz: meeting.tz, state: meeting.state,
      window_days: meeting.window_days, organizer: parts.find((p) => p.role === 'organizer')?.name, slots,
    },
    responses,
    total: active.length,
    counts: Object.fromEntries(counts.rows.map((r) => [iso(r.slot_ts), [Number(r.free_n), Number(r.inb_n)]])),
    my_paints: Object.fromEntries(mine.rows.map((r) => [iso(r.slot_ts), r.level])),
    lock: lock ? { slot: iso(lock.slot_ts), locked_at: lock.locked_at } : null,
    history: history.rows.map((r) => iso(r.slot_ts)),
    flex: myFlex ? { id: myFlex.id, slot: iso(myFlex.slot_ts) } : null,
  };

  // Meeting space: once locked, attendees see who is coming and how (no availability data).
  if (meeting.state === 'LOCKED' || meeting.state === 'CLOSED') {
    const placed = Object.fromEntries(nodes.rows.map((n) => [n.ref_id, n]));
    view.space = active.map((p) => ({
      id: p.id, name: p.name, role: p.role, is_dm: p.is_dm, city: p.home_city || cityOf(p.tz) || 'Unknown',
      mode: placed[p.id]?.mode || 'home', at: placed[p.id]?.cluster_key || null, me: p.id === me.id,
    }));
  }
  if (me.role !== 'organizer') return view;

  // Organizer-only: who is in, who painted what, proposals with their full breakdowns, repairs.
  const [props, latest, issue, flexes, recent] = await Promise.all([
    db.query(`select id, slot_ts, score, breakdown_json, status, below_quorum, rank from proposals
              where meeting_id = $1 and status in ('proposed','alternate') order by rank`, [meeting.id]),
    db.query(`select type, payload, at from events where meeting_id = $1 and type in ('no_slot','proposed','widened')
              order by at desc, id desc limit 1`, [meeting.id]),
    db.query(`select type, payload from events where meeting_id = $1 and type in ('declined','added_conflict')
              order by at desc, id desc limit 1`, [meeting.id]),
    db.query(`select f.id, f.participant_id, f.slot_ts, f.status, p.name from flex_asks f join participants p on p.id = f.participant_id
              where f.meeting_id = $1 order by f.created_at desc limit 5`, [meeting.id]),
    db.query(`select type, payload, at from events where meeting_id = $1
              and type in ('added_ok','kept_without','made_optional','flex_cant','flex_sure','widened','added')
              order by at desc, id desc limit 1`, [meeting.id]),
  ]);
  view.participants = parts.map((p) => ({
    id: p.id, name: p.name, email: p.email, role: p.role, is_dm: p.is_dm, is_required: p.is_required, optional: p.optional,
    declined: !!p.declined_at, tz: p.tz, responded: !!p.responded_at,
  }));
  view.paints_by_participant = Object.fromEntries(active.map((p) => [p.id, paints[p.id] || {}]));
  view.proposals = props.rows.map((p) => ({ id: p.id, slot: iso(p.slot_ts), score: Number(p.score), status: p.status, below_quorum: p.below_quorum, breakdown: p.breakdown_json }));
  const neg = latest.rows[0];
  view.negotiation = meeting.state === 'OPEN' && neg?.type === 'no_slot' ? neg.payload : null;
  if (view.negotiation) {
    view.negotiation.asks = flexes.rows
      .filter((f) => view.negotiation.slot && iso(f.slot_ts) === view.negotiation.slot)
      .map((f) => ({ participant_id: f.participant_id, name: f.name, status: f.status }));
  }
  view.issue = meeting.state === 'DESTABILIZED' && issue.rows[0] ? { kind: issue.rows[0].type, ...issue.rows[0].payload } : null;
  view.notice = recent.rows[0] ? { type: recent.rows[0].type, ...recent.rows[0].payload, at: recent.rows[0].at } : null;
  return view;
}

async function respondWithView(req, pool) {
  const fresh = await auth(pool, req);
  return json(200, await buildView(pool, fresh.me, fresh.meeting));
}

async function getMeeting(req) {
  return respondWithView(req, getPool());
}

// ---------- compute + lock ----------

// Runs the scorer inside the caller's transaction. Returns 'proposed' or 'no_slot'.
async function compute(db, meetingId) {
  const { rows: [m] } = await db.query('select * from meetings where id = $1 for update', [meetingId]);
  requireState(m, 'OPEN', 'PROPOSED', 'RECOMPUTING');
  const { parts, paints } = await loadPeopleAndPaints(db, m.id);
  const active = parts.filter((p) => !p.declined_at);
  const result = scoreMeeting({ slots: meetingSlots(m), durationMin: m.duration_min, participants: active, paints });
  await db.query(`update proposals set status = 'superseded' where meeting_id = $1 and status in ('proposed','alternate')`, [m.id]);
  if (!result.proposals.length) {
    await db.query(`update meetings set state = 'OPEN' where id = $1`, [m.id]);
    await event(db, m.id, 'no_slot', result.negotiation || {});
    return { outcome: 'no_slot', meeting: m };
  }
  for (const [i, p] of result.proposals.entries()) {
    await db.query(
      `insert into proposals (meeting_id, slot_ts, score, breakdown_json, weights_version, rank, status, below_quorum)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [m.id, p.slot, p.score, p, p.weights_version, i, i === 0 ? 'proposed' : 'alternate', p.below_quorum]);
  }
  await db.query(`update meetings set state = 'PROPOSED' where id = $1`, [m.id]);
  await event(db, m.id, 'proposed', { slot: result.proposals[0].slot });
  return { outcome: 'proposed', meeting: m, top: result.proposals[0] };
}

async function notifyReveal(req, meeting, top) {
  const { rows: [o] } = await getPool().query(`select email, tz, token_enc from participants where id = $1`, [meeting.organizer_participant_id]);
  if (!o?.email) return;
  await sendEmail('reveal', o.email, {
    title: meeting.title, headline: revealHeadline(top), slot: formatSlot(top.slot, o.tz || meeting.tz, meeting.duration_min),
    link: storedLink(req, o) || siteOrigin(req),
  }).catch(() => {});
}

async function computeNow(req) {
  const pool = getPool();
  const { me, meeting } = await auth(pool, req);
  requireOrganizer(me);
  const result = await tx((db) => compute(db, meeting.id));
  if (result.outcome === 'proposed') await notifyReveal(req, meeting, result.top);
  return respondWithView(req, pool);
}

async function lockProposal(req) {
  const b = await readJson(req);
  const pool = getPool();
  const { me, meeting } = await auth(pool, req);
  requireOrganizer(me);
  const proposalId = uuid(b.proposal_id, 'proposal_id');
  const { slot, previous } = await tx(async (db) => {
    const { rows: [m] } = await db.query('select * from meetings where id = $1 for update', [meeting.id]);
    requireState(m, 'PROPOSED');
    const { rows: [p] } = await db.query(
      `select * from proposals where id = $1 and meeting_id = $2 and status in ('proposed','alternate')`, [proposalId, m.id]);
    if (!p) fail(404, 'That proposal is no longer current');
    const prev = await currentLock(db, m.id);
    await db.query(`update proposals set status = 'locked' where id = $1`, [p.id]);
    const { rows: [l] } = await db.query(`insert into locks (meeting_id, proposal_id) values ($1,$2) returning id`, [m.id, p.id]);
    if (prev) {
      // A re-lock after a repair: chain the history and retire the old time.
      await db.query(`update locks set superseded_by = $1 where id = $2`, [l.id, prev.id]);
      await db.query(`update proposals set status = 'superseded' where id = $1`, [prev.proposal_id]);
    }
    await db.query(`update meetings set state = 'LOCKED' where id = $1`, [m.id]);
    await event(db, m.id, 'locked', { proposal_id: p.id, previous: prev ? iso(prev.slot_ts) : null });
    return { slot: iso(p.slot_ts), previous: prev ? iso(prev.slot_ts) : null };
  });
  // Google Calendar write lands with the Google integration; email confirmations go out now.
  const { rows: people } = await pool.query(
    'select email, tz, token_enc from participants where meeting_id = $1 and email is not null and declined_at is null', [meeting.id]);
  await Promise.all(people.map((p) => {
    const z = p.tz || meeting.tz;
    const data = { title: meeting.title, slot: formatSlot(slot, z, meeting.duration_min), link: storedLink(req, p) || siteOrigin(req) };
    return (previous
      ? sendEmail('resched', p.email, { ...data, old: formatSlot(previous, z, meeting.duration_min) })
      : sendEmail('lock_confirm', p.email, data)).catch(() => {});
  }));
  return respondWithView(req, pool);
}

// ---------- painting ----------

async function savePaints(req) {
  const b = await readJson(req);
  const pool = getPool();
  const { me, meeting } = await auth(pool, req);
  const addedAfterLock = meeting.state === 'LOCKED' && !me.responded_at;
  if (!['OPEN', 'PROPOSED'].includes(meeting.state) && !addedAfterLock) {
    fail(409, `This meeting is ${meeting.state.toLowerCase()}; times can't change now`);
  }
  const paints = cleanPaints(b.paints, meetingSlots(meeting));
  const tz = isValidTz(b.tz) ? b.tz : null;

  const result = await tx(async (db) => {
    const { rows: [m] } = await db.query('select * from meetings where id = $1 for update', [meeting.id]);
    await db.query('delete from paints where participant_id = $1', [me.id]);
    await insertPaints(db, me.id, paints);
    await db.query(
      'update participants set responded_at = now(), tz = coalesce($2, tz), home_city = coalesce(home_city, $3) where id = $1',
      [me.id, tz, cityOf(tz)]);
    await event(db, m.id, 'painted', { participant_id: me.id, cells: Object.keys(paints).length });

    if (m.state === 'LOCKED') {
      // Someone added after lock (6): does the locked time work for them?
      const lock = await currentLock(db, m.id);
      const covered = coveredSlots(iso(lock.slot_ts), m.duration_min);
      const ok = covered.every((s) => paints[s]);
      if (ok) await event(db, m.id, 'added_ok', { participant_id: me.id, name: me.name, slot: iso(lock.slot_ts) });
      else {
        await db.query(`update meetings set state = 'DESTABILIZED' where id = $1`, [m.id]);
        await event(db, m.id, 'added_conflict', { participant_id: me.id, name: me.name, slot: iso(lock.slot_ts) });
      }
      return null;
    }
    // Everyone is in (or a proposal already exists and needs refreshing): run the scorer.
    const { rows: [c] } = await db.query(
      `select count(*) filter (where responded_at is null and declined_at is null) as waiting from participants where meeting_id = $1`, [m.id]);
    if (Number(c.waiting) === 0 || m.state === 'PROPOSED') return compute(db, m.id);
    return null;
  });
  if (result?.outcome === 'proposed') await notifyReveal(req, meeting, result.top);
  return respondWithView(req, pool);
}

// ---------- repairs (4, 5, 6) ----------

// An attendee can't make the locked time anymore (in-app; Google decline webhooks feed the same path).
async function decline(req) {
  const pool = getPool();
  const { me, meeting } = await auth(pool, req);
  if (me.role === 'organizer') fail(400, 'Organizers reschedule instead of declining');
  await tx(async (db) => {
    const { rows: [m] } = await db.query('select * from meetings where id = $1 for update', [meeting.id]);
    requireState(m, 'LOCKED');
    const lock = await currentLock(db, m.id);
    const covered = coveredSlots(iso(lock.slot_ts), m.duration_min);
    await db.query('delete from paints where participant_id = $1 and slot_ts = any($2::timestamptz[])', [me.id, covered]);
    await db.query(`update meetings set state = 'DESTABILIZED' where id = $1`, [m.id]);
    await event(db, m.id, 'declined', { participant_id: me.id, name: me.name, slot: iso(lock.slot_ts) });
  });
  const { rows: [o] } = await pool.query(`select email, tz, token_enc from participants where id = $1`, [meeting.organizer_participant_id]);
  if (o?.email) {
    const lock = await currentLock(pool, meeting.id);
    await sendEmail('declined', o.email, {
      name: me.name, title: meeting.title, slot: formatSlot(iso(lock.slot_ts), o.tz || meeting.tz, meeting.duration_min),
      link: storedLink(req, o) || siteOrigin(req),
    }).catch(() => {});
  }
  return respondWithView(req, pool);
}

// The organizer's choice on a destabilized meeting: keep the time, or find a new one from
// everyone's existing answers. ASAP never picks for them.
async function repair(req) {
  const b = await readJson(req);
  const pool = getPool();
  const { me, meeting } = await auth(pool, req);
  requireOrganizer(me);
  if (!['keep', 'find_new'].includes(b.action)) fail(400, 'action must be keep or find_new');
  const result = await tx(async (db) => {
    const { rows: [m] } = await db.query('select * from meetings where id = $1 for update', [meeting.id]);
    requireState(m, 'DESTABILIZED');
    const { rows: [issue] } = await db.query(
      `select type, payload from events where meeting_id = $1 and type in ('declined','added_conflict') order by at desc, id desc limit 1`, [m.id]);
    if (b.action === 'keep') {
      const pid = issue?.payload?.participant_id;
      if (issue?.type === 'declined') {
        await db.query('update participants set declined_at = now() where id = $1 and meeting_id = $2', [pid, m.id]);
        await event(db, m.id, 'kept_without', { participant_id: pid, name: issue.payload.name });
      } else if (issue) {
        await db.query('update participants set optional = true where id = $1 and meeting_id = $2', [pid, m.id]);
        await event(db, m.id, 'made_optional', { participant_id: pid, name: issue.payload.name });
      }
      await db.query(`update meetings set state = 'LOCKED' where id = $1`, [m.id]);
      return null;
    }
    await db.query(`update meetings set state = 'RECOMPUTING' where id = $1`, [m.id]);
    await event(db, m.id, 'recomputing', {});
    return compute(db, m.id);
  });
  if (result?.outcome === 'proposed') await notifyReveal(req, meeting, result.top);
  return respondWithView(req, pool);
}

// 2f: ask one blocking person to flex for the closest time. Organizer-triggered only.
async function sendFlex(req) {
  const b = await readJson(req);
  const pool = getPool();
  const { me, meeting } = await auth(pool, req);
  requireOrganizer(me);
  const pid = uuid(b.participant_id, 'participant_id');
  const { person, slot } = await tx(async (db) => {
    const { rows: [m] } = await db.query('select * from meetings where id = $1 for update', [meeting.id]);
    requireState(m, 'OPEN');
    const { rows: [neg] } = await db.query(
      `select type, payload from events where meeting_id = $1 and type in ('no_slot','proposed','widened') order by at desc, id desc limit 1`, [m.id]);
    if (neg?.type !== 'no_slot' || !neg.payload?.slot) fail(409, 'There is nothing to ask for right now');
    if (!(neg.payload.missing_required_ids || []).includes(pid)) fail(400, 'That person isn’t blocking the closest time');
    const { rows: [p] } = await db.query('select * from participants where id = $1 and meeting_id = $2', [pid, m.id]);
    const { rows: [dup] } = await db.query(
      `select 1 from flex_asks where participant_id = $1 and slot_ts = $2 and status = 'pending'`, [pid, neg.payload.slot]);
    if (!dup) await db.query(`insert into flex_asks (meeting_id, participant_id, slot_ts) values ($1,$2,$3)`, [m.id, pid, neg.payload.slot]);
    await event(db, m.id, 'flex_sent', { participant_id: pid, name: p.name, slot: neg.payload.slot });
    return { person: p, slot: neg.payload.slot };
  });
  if (person.email) {
    await sendEmail('flex_ask', person.email, {
      title: meeting.title, slot: formatSlot(slot, person.tz || meeting.tz, meeting.duration_min), link: storedLink(req, person) || siteOrigin(req),
    }).catch(() => {});
  }
  return respondWithView(req, pool);
}

async function answerFlex(req) {
  const b = await readJson(req);
  const pool = getPool();
  const { me, meeting } = await auth(pool, req);
  if (!['sure', 'cant'].includes(b.answer)) fail(400, 'answer must be sure or cant');
  const result = await tx(async (db) => {
    const { rows: [m] } = await db.query('select * from meetings where id = $1 for update', [meeting.id]);
    const { rows: [f] } = await db.query(
      `select * from flex_asks where participant_id = $1 and status = 'pending' order by created_at desc limit 1 for update`, [me.id]);
    if (!f) fail(404, 'There is no open question for you');
    await db.query(`update flex_asks set status = $2, answered_at = now() where id = $1`, [f.id, b.answer]);
    if (b.answer === 'cant') { await event(db, m.id, 'flex_cant', { participant_id: me.id, name: me.name }); return null; }
    const paints = Object.fromEntries(coveredSlots(iso(f.slot_ts), m.duration_min).map((s) => [s, 'free']));
    await insertPaints(db, me.id, paints);
    await event(db, m.id, 'flex_sure', { participant_id: me.id, name: me.name });
    if (m.state === 'OPEN' || m.state === 'PROPOSED') return compute(db, m.id);
    return null;
  });
  if (result?.outcome === 'proposed') await notifyReveal(req, meeting, result.top);
  return respondWithView(req, pool);
}

// Widen the date range when no time works: people paint only the new days.
async function widen(req) {
  const pool = getPool();
  const { me, meeting } = await auth(pool, req);
  requireOrganizer(me);
  await tx(async (db) => {
    const { rows: [m] } = await db.query('select * from meetings where id = $1 for update', [meeting.id]);
    requireState(m, 'OPEN');
    if (m.window_days >= MAX_DAYS) fail(409, `The window is already ${MAX_DAYS} days`);
    const days = m.window_days < 30 ? 30 : MAX_DAYS;
    await db.query('update meetings set window_days = $2 where id = $1', [m.id, days]);
    await event(db, m.id, 'widened', { from: m.window_days, to: days });
  });
  return respondWithView(req, pool);
}

// Add someone (any time before the meeting closes; after lock this is 6).
async function addParticipant(req) {
  const b = await readJson(req);
  const pool = getPool();
  const { me, meeting } = await auth(pool, req);
  requireOrganizer(me);
  const person = { name: str(b.name, 80, 'Name'), email: email(b.email, 'Email'), is_dm: !!b.is_dm, is_required: !!b.is_required };
  const token = newToken();
  await tx(async (db) => {
    const { rows: [m] } = await db.query('select * from meetings where id = $1 for update', [meeting.id]);
    requireState(m, 'OPEN', 'PROPOSED', 'LOCKED');
    const { rows: [{ n }] } = await db.query('select count(*)::int as n from participants where meeting_id = $1', [m.id]);
    if (n >= MAX_PEOPLE + 1) fail(400, `At most ${MAX_PEOPLE} people`);
    await db.query(
      `insert into participants (meeting_id, name, email, role, is_dm, is_required, guest_token_hash, token_enc)
       values ($1,$2,$3,'invitee',$4,$5,$6,$7)`,
      [m.id, person.name, person.email, person.is_dm, person.is_required, hashToken(token), encryptToken(token)]);
    await event(db, m.id, 'added', { name: person.name });
  });
  const sent = await sendEmail('invite', person.email, { organizer: me.name, title: meeting.title, link: linkFor(req, token) }).catch(() => ({ sent: false }));
  const view = await buildView(pool, me, (await auth(pool, req)).meeting);
  return json(200, { ...view, added: { name: person.name, link: linkFor(req, token), emailed: sent.sent } });
}

// Show someone's link again (or replace it, which stops the old one working).
async function participantLink(req, participantId) {
  const b = await readJson(req);
  const pool = getPool();
  const { me, meeting } = await auth(pool, req);
  requireOrganizer(me);
  const { rows: [p] } = await pool.query(
    `select id, token_enc from participants where id = $1 and meeting_id = $2 and role = 'invitee'`, [participantId, meeting.id]);
  if (!p) fail(404, 'No such person in this meeting');
  const existing = !b.rotate && storedLink(req, p);
  if (existing) return json(200, { link: existing });
  const token = newToken();
  await pool.query('update participants set guest_token_hash = $1, token_enc = $2 where id = $3', [hashToken(token), encryptToken(token), p.id]);
  return json(200, { link: linkFor(req, token), rotated: true });
}

// ---------- meeting space (7) ----------

async function graphDrop(req) {
  const b = await readJson(req);
  const pool = getPool();
  const { me, meeting } = await auth(pool, req);
  requireState(meeting, 'LOCKED');
  const pid = uuid(b.participant_id, 'participant_id');
  if (me.role !== 'organizer' && pid !== me.id) fail(403, 'You can only move yourself');
  const t = b.target || null;
  let mode = 'home', at = null;
  if (t?.type === 'cluster') { mode = 'in_person'; at = str(t.name, 80, 'City'); }
  else if (t?.type === 'person') { mode = 'remote_with'; at = uuid(t.pid, 'Person'); if (at === pid) fail(400, 'Pick someone else'); }
  else if (t) fail(400, 'Unknown drop target');
  await tx(async (db) => {
    const { rows: [p] } = await db.query('select id, name from participants where id = $1 and meeting_id = $2', [pid, meeting.id]);
    if (!p) fail(404, 'No such person in this meeting');
    if (mode === 'remote_with') {
      const { rows: [q] } = await db.query('select 1 from participants where id = $1 and meeting_id = $2', [at, meeting.id]);
      if (!q) fail(404, 'No such person in this meeting');
    }
    await db.query(
      `insert into graph_nodes (meeting_id, kind, parent_meeting_id, ref_id, cluster_key, mode) values ($1,'person',$1,$2,$3,$4)
       on conflict (meeting_id, kind, ref_id) do update set cluster_key = excluded.cluster_key, mode = excluded.mode`,
      [meeting.id, pid, at, mode]);
    await event(db, meeting.id, 'moved', { participant_id: pid, mode, at });
  });
  return respondWithView(req, pool);
}

// ---------- router ----------

export async function handle(req) {
  const { pathname } = new URL(req.url);
  const route = `${req.method} ${pathname.replace(/\/+$/, '')}`;
  try {
    let m;
    if (route === 'POST /api/meetings') return await createMeeting(req);
    if (route === 'GET /api/meeting') return await getMeeting(req);
    if (route === 'POST /api/paints') return await savePaints(req);
    if (route === 'POST /api/compute') return await computeNow(req);
    if (route === 'POST /api/lock') return await lockProposal(req);
    if (route === 'POST /api/decline') return await decline(req);
    if (route === 'POST /api/repair') return await repair(req);
    if (route === 'POST /api/flex') return await sendFlex(req);
    if (route === 'POST /api/flex/answer') return await answerFlex(req);
    if (route === 'POST /api/widen') return await widen(req);
    if (route === 'POST /api/participants') return await addParticipant(req);
    if (route === 'POST /api/graph/drop') return await graphDrop(req);
    if ((m = route.match(/^POST \/api\/participants\/([0-9a-f-]{36})\/link$/))) return await participantLink(req, m[1]);
    if (route === 'GET /api/health') return json(200, { ok: true });
    return json(404, { error: 'Not found' });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    if (e.status === 503) return json(503, { error: e.message });
    console.error(e);
    return json(500, { error: 'Something went wrong on our side' });
  }
}

