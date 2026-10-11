// The whole /api/* surface (handoff §10), as one fetch-style handler: (Request) => Response.
// Runs as a Netlify Function in production and inside scripts/dev.mjs locally.

import { getPool, tx } from './db.js';
import { newToken, hashToken } from './tokens.js';
import { generateSlots, isValidTz, todayIn, addDays } from './slots.js';
import { scoreMeeting } from './scoring.js';
import { revealHeadline } from './copy.js';
import { formatSlot } from './format.js';
import { sendEmail } from './email.js';

const MAX_BODY = 200_000;
const MAX_PEOPLE = 50;

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

const siteOrigin = (req) => process.env.URL || new URL(req.url).origin;
const linkFor = (req, token) => `${siteOrigin(req)}/s/${token}`;

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
    const iso = d.toISOString();
    if (valid.has(iso)) out[iso] = v;
  }
  return out;
}

async function insertPaints(db, participantId, paints) {
  const keys = Object.keys(paints);
  if (!keys.length) return;
  await db.query(
    `insert into paints (participant_id, slot_ts, level)
     select $1, s, l::paint_level from unnest($2::timestamptz[], $3::text[]) as t(s, l)`,
    [participantId, keys, keys.map((k) => paints[k])],
  );
}

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

// ---------- handlers ----------

async function createMeeting(req) {
  const b = await readJson(req);
  const title = str(b.title, 200, 'Meeting name');
  const tz = str(b.tz, 64, 'Timezone');
  if (!isValidTz(tz)) fail(400, 'Unknown timezone');
  const duration = Number(b.duration_min);
  if (!Number.isInteger(duration) || duration < 30 || duration > 480 || duration % 30) fail(400, 'Duration must be 30–480 minutes in 30-minute steps');
  const days = Number(b.window_days ?? 7);
  if (!Number.isInteger(days) || days < 1 || days > 31) fail(400, 'The window must be 1–31 days');
  const dayStart = Number(b.day_start_min ?? 480), dayEnd = Number(b.day_end_min ?? 1200);
  if (!Number.isInteger(dayStart) || !Number.isInteger(dayEnd) || dayStart < 0 || dayEnd > 1440 || dayEnd - dayStart < duration) fail(400, 'Invalid day hours');
  const start = str(b.window_start, 10, 'Start date');
  const today = todayIn(tz);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || start < addDays(today, -1) || start > addDays(today, 366)) fail(400, 'Start date must be within the next year');

  const org = b.organizer || {};
  const organizer = { name: str(org.name, 80, 'Your name'), email: email(org.email, 'Your email'), is_dm: !!org.is_dm };
  if (!Array.isArray(b.people) || !b.people.length) fail(400, 'Add at least one person');
  if (b.people.length > MAX_PEOPLE) fail(400, `At most ${MAX_PEOPLE} people`);
  const people = b.people.map((p, i) => ({ name: str(p?.name, 80, `Person ${i + 1}'s name`), email: email(p?.email, `Person ${i + 1}'s email`), is_dm: !!p?.is_dm }));

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
      `insert into participants (meeting_id, name, email, role, is_dm, guest_token_hash, tz, responded_at)
       values ($1,$2,$3,'organizer',$4,$5,$6,$7) returning id`,
      [m.id, organizer.name, organizer.email, organizer.is_dm, hashToken(orgToken), orgTz, Object.keys(paints).length ? new Date() : null]);
    await db.query('update meetings set organizer_participant_id = $1 where id = $2', [o.id, m.id]);
    for (const p of invites) {
      await db.query(
        `insert into participants (meeting_id, name, email, role, is_dm, guest_token_hash) values ($1,$2,$3,'invitee',$4,$5)`,
        [m.id, p.name, p.email, p.is_dm, hashToken(p.token)]);
    }
    await insertPaints(db, o.id, paints);
    await db.query(`insert into events (meeting_id, type, payload) values ($1,'created',$2)`, [m.id, { people: invites.length + 1 }]);
    return m.id;
  });

  const sent = await Promise.all(invites.map((p) =>
    sendEmail('invite', p.email, { organizer: organizer.name, title, link: linkFor(req, p.token) }).catch(() => ({ sent: false }))));

  return json(201, {
    meeting_id: meetingId,
    organizer_token: orgToken,
    invites: invites.map((p, i) => ({ name: p.name, email: p.email, is_dm: p.is_dm, link: linkFor(req, p.token), emailed: sent[i].sent })),
  });
}

async function buildView(db, me, meeting) {
  const slots = meetingSlots(meeting);
  const [counts, parts, mine, lock] = await Promise.all([
    db.query('select slot_ts, free_n, inb_n from paint_counts where meeting_id = $1', [meeting.id]),
    db.query('select id, name, email, role, is_dm, tz, responded_at from participants where meeting_id = $1 order by role, created_at', [meeting.id]),
    db.query('select slot_ts, level from paints where participant_id = $1', [me.id]),
    db.query(`select l.locked_at, p.slot_ts from locks l join proposals p on p.id = l.proposal_id
              where l.meeting_id = $1 and l.superseded_by is null order by l.locked_at desc limit 1`, [meeting.id]),
  ]);
  const iso = (d) => new Date(d).toISOString();
  const responses = parts.rows.filter((p) => p.responded_at).length;
  const view = {
    role: me.role,
    me: { id: me.id, name: me.name, is_dm: me.is_dm, responded: !!me.responded_at },
    meeting: {
      id: meeting.id, title: meeting.title, duration_min: meeting.duration_min, tz: meeting.tz, state: meeting.state,
      organizer: parts.rows.find((p) => p.role === 'organizer')?.name, slots,
    },
    responses,
    total: parts.rows.length,
    counts: Object.fromEntries(counts.rows.map((r) => [iso(r.slot_ts), [Number(r.free_n), Number(r.inb_n)]])),
    my_paints: Object.fromEntries(mine.rows.map((r) => [iso(r.slot_ts), r.level])),
    lock: lock.rows[0] ? { slot: iso(lock.rows[0].slot_ts), locked_at: lock.rows[0].locked_at } : null,
  };
  if (me.role !== 'organizer') return view;

  // Organizer-only: who is in, who painted what, proposals with their full breakdowns.
  const [paints, props, neg] = await Promise.all([
    db.query(`select p.participant_id, p.slot_ts, p.level from paints p join participants pa on pa.id = p.participant_id where pa.meeting_id = $1`, [meeting.id]),
    db.query(`select id, slot_ts, score, breakdown_json, status, below_quorum, rank from proposals
              where meeting_id = $1 and status in ('proposed','alternate','locked') order by rank`, [meeting.id]),
    db.query(`select type, payload from events where meeting_id = $1 and type in ('no_slot','proposed') order by at desc, id desc limit 1`, [meeting.id]),
  ]);
  const byPerson = {};
  for (const r of paints.rows) (byPerson[r.participant_id] ||= {})[iso(r.slot_ts)] = r.level;
  view.participants = parts.rows.map((p) => ({ id: p.id, name: p.name, email: p.email, role: p.role, is_dm: p.is_dm, tz: p.tz, responded: !!p.responded_at }));
  view.paints_by_participant = byPerson;
  view.proposals = props.rows.map((p) => ({ id: p.id, slot: iso(p.slot_ts), score: Number(p.score), status: p.status, below_quorum: p.below_quorum, breakdown: p.breakdown_json }));
  view.negotiation = meeting.state === 'OPEN' && neg.rows[0]?.type === 'no_slot' ? neg.rows[0].payload : null;
  return view;
}

async function getMeeting(req) {
  const db = getPool();
  const { me, meeting } = await auth(db, req);
  return json(200, await buildView(db, me, meeting));
}

// Runs the scorer inside the caller's transaction. Returns 'proposed' or 'no_slot'.
async function compute(db, meetingId) {
  const { rows: [m] } = await db.query('select * from meetings where id = $1 for update', [meetingId]);
  if (!['OPEN', 'PROPOSED'].includes(m.state)) fail(409, `Can't compute while the meeting is ${m.state.toLowerCase()}`);
  const parts = (await db.query('select id, name, role, is_dm, tz from participants where meeting_id = $1', [m.id])).rows;
  const paints = {};
  const rows = (await db.query(
    `select p.participant_id, p.slot_ts, p.level from paints p join participants pa on pa.id = p.participant_id where pa.meeting_id = $1`, [m.id])).rows;
  for (const r of rows) (paints[r.participant_id] ||= {})[new Date(r.slot_ts).toISOString()] = r.level;

  const result = scoreMeeting({ slots: meetingSlots(m), durationMin: m.duration_min, participants: parts, paints });
  await db.query(`update proposals set status = 'superseded' where meeting_id = $1 and status in ('proposed','alternate')`, [m.id]);
  if (!result.proposals.length) {
    await db.query(`update meetings set state = 'OPEN' where id = $1`, [m.id]);
    await db.query(`insert into events (meeting_id, type, payload) values ($1,'no_slot',$2)`, [m.id, result.negotiation || {}]);
    return { outcome: 'no_slot', meeting: m };
  }
  for (const [i, p] of result.proposals.entries()) {
    await db.query(
      `insert into proposals (meeting_id, slot_ts, score, breakdown_json, weights_version, rank, status, below_quorum)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [m.id, p.slot, p.score, p, p.weights_version, i, i === 0 ? 'proposed' : 'alternate', p.below_quorum]);
  }
  await db.query(`update meetings set state = 'PROPOSED' where id = $1`, [m.id]);
  await db.query(`insert into events (meeting_id, type, payload) values ($1,'proposed',$2)`, [m.id, { slot: result.proposals[0].slot }]);
  return { outcome: 'proposed', meeting: m, top: result.proposals[0] };
}

async function notifyReveal(req, meeting, top, me) {
  const { rows: [o] } = await getPool().query(`select email, tz from participants where id = $1`, [meeting.organizer_participant_id]);
  if (!o?.email) return;
  await sendEmail('reveal', o.email, {
    title: meeting.title, headline: revealHeadline(top), slot: formatSlot(top.slot, o.tz || meeting.tz, meeting.duration_min),
    link: siteOrigin(req),
  }).catch(() => {});
}

async function savePaints(req) {
  const b = await readJson(req);
  const pool = getPool();
  const { me, meeting } = await auth(pool, req);
  if (!['OPEN', 'PROPOSED'].includes(meeting.state)) fail(409, `This meeting is ${meeting.state.toLowerCase()}; times can't change now`);
  const paints = cleanPaints(b.paints, meetingSlots(meeting));
  const tz = isValidTz(b.tz) ? b.tz : null;

  const result = await tx(async (db) => {
    await db.query('select 1 from meetings where id = $1 for update', [meeting.id]);
    await db.query('delete from paints where participant_id = $1', [me.id]);
    await insertPaints(db, me.id, paints);
    await db.query('update participants set responded_at = now(), tz = coalesce($2, tz) where id = $1', [me.id, tz]);
    await db.query(`insert into events (meeting_id, type, payload) values ($1,'painted',$2)`, [meeting.id, { participant_id: me.id, cells: Object.keys(paints).length }]);
    // Everyone is in (or a proposal already exists and needs refreshing): run the scorer.
    const { rows: [c] } = await db.query(
      `select count(*) filter (where responded_at is null) as waiting, (select state from meetings where id = $1) as state
       from participants where meeting_id = $1`, [meeting.id]);
    if (Number(c.waiting) === 0 || c.state === 'PROPOSED') return compute(db, meeting.id);
    return null;
  });
  if (result?.outcome === 'proposed') await notifyReveal(req, meeting, result.top, me);

  const fresh = await auth(pool, req);
  return json(200, await buildView(pool, fresh.me, fresh.meeting));
}

async function computeNow(req) {
  const pool = getPool();
  const { me, meeting } = await auth(pool, req);
  requireOrganizer(me);
  const result = await tx((db) => compute(db, meeting.id));
  if (result.outcome === 'proposed') await notifyReveal(req, meeting, result.top, me);
  const fresh = await auth(pool, req);
  return json(200, await buildView(pool, fresh.me, fresh.meeting));
}

async function lockProposal(req) {
  const b = await readJson(req);
  const pool = getPool();
  const { me, meeting } = await auth(pool, req);
  requireOrganizer(me);
  const proposalId = str(b.proposal_id, 64, 'proposal_id');
  const slot = await tx(async (db) => {
    const { rows: [m] } = await db.query('select * from meetings where id = $1 for update', [meeting.id]);
    if (m.state !== 'PROPOSED') fail(409, `Can't lock while the meeting is ${m.state.toLowerCase()}`);
    const { rows: [p] } = await db.query(
      `select * from proposals where id = $1 and meeting_id = $2 and status in ('proposed','alternate')`, [proposalId, m.id]);
    if (!p) fail(404, 'That proposal is no longer current');
    await db.query(`update proposals set status = 'locked' where id = $1`, [p.id]);
    await db.query(`insert into locks (meeting_id, proposal_id) values ($1,$2)`, [m.id, p.id]);
    await db.query(`update meetings set state = 'LOCKED' where id = $1`, [m.id]);
    await db.query(`insert into events (meeting_id, type, payload) values ($1,'locked',$2)`, [m.id, { proposal_id: p.id }]);
    return new Date(p.slot_ts).toISOString();
  });
  // Google Calendar event write lands with the Google integration; email confirmations go out now.
  const { rows: people } = await pool.query('select email, tz from participants where meeting_id = $1 and email is not null', [meeting.id]);
  await Promise.all(people.map((p) => sendEmail('lock_confirm', p.email, {
    title: meeting.title, slot: formatSlot(slot, p.tz || meeting.tz, meeting.duration_min), link: siteOrigin(req),
  }).catch(() => {})));
  const fresh = await auth(pool, req);
  return json(200, await buildView(pool, fresh.me, fresh.meeting));
}

// Organizer gets a fresh link for someone (old link stops working). Tokens are stored hashed,
// so this is the only way to show a link again.
async function newLink(req, participantId) {
  const pool = getPool();
  const { me, meeting } = await auth(pool, req);
  requireOrganizer(me);
  const token = newToken();
  const { rowCount } = await pool.query(
    `update participants set guest_token_hash = $1 where id = $2 and meeting_id = $3 and role = 'invitee'`,
    [hashToken(token), participantId, meeting.id]);
  if (!rowCount) fail(404, 'No such person in this meeting');
  return json(200, { link: linkFor(req, token) });
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
    if ((m = route.match(/^POST \/api\/participants\/([0-9a-f-]{36})\/link$/))) return await newLink(req, m[1]);
    if (route === 'GET /api/health') return json(200, { ok: true });
    return json(404, { error: 'Not found' });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    if (e.status === 503) return json(503, { error: e.message });
    console.error(e);
    return json(500, { error: 'Something went wrong on our side' });
  }
}
