// End-to-end API tests against a real Postgres (DATABASE_URL). Skipped without one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { handle } from '../lib/api.js';
import { closePool } from '../lib/db.js';
import { generateSlots, todayIn } from '../lib/slots.js';

const skip = !process.env.DATABASE_URL && 'DATABASE_URL not set';
after(() => closePool());

const call = async (method, path, { token, body } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await handle(new Request(`http://test.local${path}`, { method, headers, body: body && JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const tokenOf = (link) => link.split('/s/')[1];

const TZ = 'UTC';
const start = todayIn(TZ);
const slots = generateSlots({ startDate: start, days: 7, dayStartMin: 480, dayEndMin: 1200, tz: TZ });
const free = (...i) => Object.fromEntries(i.map((n) => [slots[n], 'free']));

async function create(extra = {}) {
  const r = await call('POST', '/api/meetings', {
    body: {
      title: 'Q4 planning', duration_min: 30, tz: TZ, window_start: start, window_days: 7,
      organizer: { name: 'Ana' }, paints: free(3, 4, 5),
      people: [{ name: 'Priya', is_dm: true }, { name: 'Ken' }],
      ...extra,
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { org: r.body.organizer_token, priya: tokenOf(r.body.invites[0].link), ken: tokenOf(r.body.invites[1].link), body: r.body };
}

test('full loop: create → paint → auto-propose → lock', { skip }, async () => {
  const m = await create();
  assert.equal(m.body.invites.length, 2);
  assert.equal(m.body.invites[0].emailed, false); // no Resend key in tests

  let v = await call('GET', '/api/meeting', { token: m.org });
  assert.equal(v.status, 200);
  assert.equal(v.body.meeting.state, 'OPEN');
  assert.equal(v.body.responses, 1);
  assert.equal(v.body.total, 3);
  assert.equal(v.body.meeting.slots.length, slots.length);

  await call('POST', '/api/paints', { token: m.priya, body: { paints: free(4, 5), tz: 'Europe/London' } });
  v = await call('POST', '/api/paints', { token: m.ken, body: { paints: { ...free(4), [slots[5]]: 'if_need_be' } } });
  assert.equal(v.status, 200);
  assert.equal(v.body.meeting.state, 'PROPOSED', 'last response triggers compute');

  v = await call('GET', '/api/meeting', { token: m.org });
  assert.equal(v.body.proposals[0].slot, slots[4]);
  assert.equal(v.body.proposals[0].breakdown.available_n, 3);
  assert.equal(v.body.proposals[1].slot, slots[5]);

  const late = await call('POST', '/api/lock', { token: m.ken, body: { proposal_id: v.body.proposals[0].id } });
  assert.equal(late.status, 403, 'invitees cannot lock');

  v = await call('POST', '/api/lock', { token: m.org, body: { proposal_id: v.body.proposals[0].id } });
  assert.equal(v.status, 200);
  assert.equal(v.body.meeting.state, 'LOCKED');
  assert.equal(v.body.lock.slot, slots[4]);

  const blocked = await call('POST', '/api/paints', { token: m.ken, body: { paints: free(1) } });
  assert.equal(blocked.status, 409, 'no repainting after lock');
});

test('privacy: invitees only ever see aggregate counts', { skip }, async () => {
  const m = await create();
  await call('POST', '/api/paints', { token: m.priya, body: { paints: free(4) } });
  const v = await call('GET', '/api/meeting', { token: m.ken });
  assert.equal(v.body.role, 'invitee');
  for (const k of ['participants', 'paints_by_participant', 'proposals', 'negotiation']) assert.equal(k in v.body, false, `invitee view leaks ${k}`);
  assert.deepEqual(v.body.counts[slots[4]], [2, 0]);
  assert.deepEqual(v.body.my_paints, {});
  const raw = JSON.stringify(v.body);
  assert.ok(!raw.includes('Priya'), 'invitee view must not name other people');

  const o = await call('GET', '/api/meeting', { token: m.org });
  assert.equal(o.body.participants.length, 3);
  const priya = o.body.participants.find((p) => p.name === 'Priya');
  assert.deepEqual(o.body.paints_by_participant[priya.id], { [slots[4]]: 'free' });
});

test('no common slot keeps the meeting open with a flex suggestion', { skip }, async () => {
  const m = await create();
  await call('POST', '/api/paints', { token: m.priya, body: { paints: free(10) } });
  const v = await call('POST', '/api/paints', { token: m.ken, body: { paints: free(3) } });
  assert.equal(v.body.meeting.state, 'OPEN');
  const o = await call('GET', '/api/meeting', { token: m.org });
  assert.deepEqual(o.body.negotiation.missing_required, ['Priya']);
});

test('organizer can force compute and re-issue a link', { skip }, async () => {
  const m = await create();
  const forced = await call('POST', '/api/compute', { token: m.priya });
  assert.equal(forced.status, 403);
  await call('POST', '/api/paints', { token: m.priya, body: { paints: free(4) } });
  const v = await call('POST', '/api/compute', { token: m.org });
  assert.equal(v.body.meeting.state, 'PROPOSED');
  assert.equal(v.body.proposals[0].slot, slots[4]);

  const ken = v.body.participants.find((p) => p.name === 'Ken');
  const same = await call('POST', `/api/participants/${ken.id}/link`, { token: m.org, body: {} });
  assert.equal(tokenOf(same.body.link), m.ken, 'copy link shows the existing link');
  const r = await call('POST', `/api/participants/${ken.id}/link`, { token: m.org, body: { rotate: true } });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/meeting', { token: m.ken })).status, 404, 'old link stops working');
  assert.equal((await call('GET', '/api/meeting', { token: tokenOf(r.body.link) })).status, 200);
});

test('input validation and auth', { skip }, async () => {
  assert.equal((await call('GET', '/api/meeting')).status, 401);
  assert.equal((await call('GET', '/api/meeting', { token: 'nope' })).status, 404);
  assert.equal((await call('POST', '/api/meetings', { body: { title: '' } })).status, 400);
  const badTz = await call('POST', '/api/meetings', { body: { title: 'x', tz: 'Mars/Base', duration_min: 30, window_start: start, organizer: { name: 'a' }, people: [{ name: 'b' }] } });
  assert.equal(badTz.status, 400);
  const m = await create({ paints: { 'not-a-date': 'free', [slots[0]]: 'free', '2000-01-01T00:00:00Z': 'free' } });
  const v = await call('GET', '/api/meeting', { token: m.org });
  assert.deepEqual(Object.keys(v.body.my_paints), [slots[0]], 'unknown slots are dropped');
  assert.equal((await call('POST', '/api/paints', { token: m.ken, body: { paints: { [slots[0]]: 'maybe' } } })).status, 400);
});

test('database: Supabase public roles cannot read tables', { skip }, async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const { rows } = await c.query(`select 1 from pg_roles where rolname = 'anon'`);
    if (!rows.length) return; // plain Postgres without Supabase roles
    for (const t of ['meetings', 'participants', 'paints', 'paint_counts', 'proposals', 'locks', 'events', 'graph_nodes']) {
      await c.query('begin');
      await c.query('set local role anon');
      await assert.rejects(c.query(`select * from ${t} limit 1`), /permission denied/, `anon can read ${t}`);
      await c.query('rollback');
    }
  } finally { await c.end(); }
});

// ---------- repairs and meeting space ----------

async function lockedMeeting() {
  const m = await create();
  await call('POST', '/api/paints', { token: m.priya, body: { paints: free(4, 5) } });
  let v = await call('POST', '/api/paints', { token: m.ken, body: { paints: free(4, 5), tz: 'America/Chicago' } });
  v = await call('GET', '/api/meeting', { token: m.org });
  v = await call('POST', '/api/lock', { token: m.org, body: { proposal_id: v.body.proposals[0].id } });
  assert.equal(v.body.meeting.state, 'LOCKED');
  return m;
}

test('CUJ-4: decline, then find a new time from existing answers and re-lock with history', { skip }, async () => {
  const m = await lockedMeeting();
  assert.equal((await call('POST', '/api/decline', { token: m.org })).status, 400, 'organizer does not decline');
  let v = await call('POST', '/api/decline', { token: m.ken });
  assert.equal(v.body.meeting.state, 'DESTABILIZED');
  v = await call('GET', '/api/meeting', { token: m.org });
  assert.equal(v.body.issue.kind, 'declined');
  assert.equal(v.body.issue.name, 'Ken');
  assert.equal((await call('POST', '/api/repair', { token: m.ken, body: { action: 'find_new' } })).status, 403);
  v = await call('POST', '/api/repair', { token: m.org, body: { action: 'find_new' } });
  assert.equal(v.body.meeting.state, 'PROPOSED', 'nobody repainted; the scorer reused answers');
  assert.equal(v.body.proposals[0].slot, slots[5]);
  v = await call('POST', '/api/lock', { token: m.org, body: { proposal_id: v.body.proposals[0].id } });
  assert.equal(v.body.lock.slot, slots[5]);
  assert.deepEqual(v.body.history, [slots[4]], 'old time kept as history');
});

test('CUJ-4: keep it without them', { skip }, async () => {
  const m = await lockedMeeting();
  await call('POST', '/api/decline', { token: m.ken });
  const v = await call('POST', '/api/repair', { token: m.org, body: { action: 'keep' } });
  assert.equal(v.body.meeting.state, 'LOCKED');
  assert.equal(v.body.lock.slot, slots[4]);
  assert.equal(v.body.total, 2, 'Ken no longer counts as attending');
  assert.equal(v.body.participants.find((p) => p.name === 'Ken').declined, true);
});

test('CUJ-5: flex ask — Sure proposes the closest time', { skip }, async () => {
  const m = await create();
  await call('POST', '/api/paints', { token: m.priya, body: { paints: free(10) } });
  await call('POST', '/api/paints', { token: m.ken, body: { paints: free(3, 10) } });
  let v = await call('GET', '/api/meeting', { token: m.org });
  const neg = v.body.negotiation;
  assert.equal(neg.slot, slots[3], 'closest = earliest of the 2-of-3 times');
  assert.deepEqual(neg.missing_required, ['Priya']);
  const ken = v.body.participants.find((p) => p.name === 'Ken');
  assert.equal((await call('POST', '/api/flex', { token: m.org, body: { participant_id: ken.id } })).status, 400, 'only blockers can be asked');
  const priya = v.body.participants.find((p) => p.name === 'Priya');
  assert.equal((await call('POST', '/api/flex', { token: m.priya, body: { participant_id: priya.id } })).status, 403);
  assert.equal((await call('POST', '/api/flex', { token: m.org, body: { participant_id: priya.id } })).status, 200);
  v = await call('GET', '/api/meeting', { token: m.priya });
  assert.equal(v.body.flex.slot, neg.slot, 'the asked person sees the question');
  assert.equal(JSON.stringify(v.body).includes('Ken'), false, 'the ask names no one');
  v = await call('POST', '/api/flex/answer', { token: m.priya, body: { answer: 'sure' } });
  assert.equal(v.body.meeting.state, 'PROPOSED');
  v = await call('GET', '/api/meeting', { token: m.org });
  assert.equal(v.body.proposals[0].slot, neg.slot);
});

test('CUJ-5: flex ask — Can\'t, then widen the window', { skip }, async () => {
  const m = await create();
  await call('POST', '/api/paints', { token: m.priya, body: { paints: free(10) } });
  await call('POST', '/api/paints', { token: m.ken, body: { paints: free(3) } });
  let v = await call('GET', '/api/meeting', { token: m.org });
  const priya = v.body.participants.find((p) => p.name === 'Priya');
  await call('POST', '/api/flex', { token: m.org, body: { participant_id: priya.id } });
  await call('POST', '/api/flex/answer', { token: m.priya, body: { answer: 'cant' } });
  assert.equal((await call('POST', '/api/flex/answer', { token: m.priya, body: { answer: 'sure' } })).status, 404, 'answered once');
  v = await call('GET', '/api/meeting', { token: m.org });
  assert.equal(v.body.negotiation.asks[0].status, 'cant');
  assert.equal(v.body.notice.type, 'flex_cant');
  assert.equal((await call('POST', '/api/widen', { token: m.ken })).status, 403);
  v = await call('POST', '/api/widen', { token: m.org });
  assert.equal(v.body.meeting.window_days, 30);
  assert.equal(v.body.meeting.slots.length, slots.length / 7 * 30);
  assert.equal(v.body.negotiation, null);
});

test('CUJ-6: add someone after lock — free keeps the lock, busy asks the organizer', { skip }, async () => {
  const m = await lockedMeeting();
  let a = await call('POST', '/api/participants', { token: m.org, body: { name: 'Rui', email: 'rui@example.com' } });
  assert.equal(a.status, 200);
  let v = await call('POST', '/api/paints', { token: tokenOf(a.body.added.link), body: { paints: free(4) } });
  assert.equal(v.body.meeting.state, 'LOCKED', 'free at the locked time: nothing moves');
  v = await call('GET', '/api/meeting', { token: m.org });
  assert.equal(v.body.notice.type, 'added_ok');

  a = await call('POST', '/api/participants', { token: m.org, body: { name: 'Sana', is_required: true } });
  v = await call('POST', '/api/paints', { token: tokenOf(a.body.added.link), body: { paints: free(1) } });
  assert.equal(v.body.meeting.state, 'DESTABILIZED');
  v = await call('GET', '/api/meeting', { token: m.org });
  assert.equal(v.body.issue.kind, 'added_conflict');
  v = await call('POST', '/api/repair', { token: m.org, body: { action: 'keep' } });
  assert.equal(v.body.meeting.state, 'LOCKED');
  assert.equal(v.body.participants.find((p) => p.name === 'Sana').optional, true);
  assert.equal((await call('POST', '/api/paints', { token: tokenOf(a.body.added.link), body: { paints: free(2) } })).status, 409, 'one answer after lock');
});

test('Required flag: a required non-DM blocks a time like a DM does', { skip }, async () => {
  const m = await create({ people: [{ name: 'Priya', is_dm: true }, { name: 'Ken', is_required: true }] });
  await call('POST', '/api/paints', { token: m.priya, body: { paints: free(4, 5) } });
  const v = await call('POST', '/api/paints', { token: m.ken, body: { paints: free(5) } });
  const o = await call('GET', '/api/meeting', { token: m.org });
  assert.deepEqual(o.body.proposals.map((p) => p.slot), [slots[5]]);
  assert.equal(v.body.meeting.state, 'PROPOSED');
});

test('CUJ-7: meeting space after lock — people move themselves, drops persist', { skip }, async () => {
  const m = await lockedMeeting();
  let v = await call('GET', '/api/meeting', { token: m.ken });
  assert.equal(v.body.space.length, 3);
  const ken = v.body.space.find((p) => p.me);
  const priya = v.body.space.find((p) => p.name === 'Priya');
  assert.equal(ken.city, 'Chicago');
  assert.equal((await call('POST', '/api/graph/drop', { token: m.ken, body: { participant_id: priya.id, target: null } })).status, 403);
  v = await call('POST', '/api/graph/drop', { token: m.ken, body: { participant_id: ken.id, target: { type: 'cluster', name: 'UTC' } } });
  assert.equal(v.body.space.find((p) => p.me).mode, 'in_person');
  v = await call('POST', '/api/graph/drop', { token: m.org, body: { participant_id: ken.id, target: { type: 'person', pid: priya.id } } });
  const k = v.body.space.find((p) => p.id === ken.id);
  assert.deepEqual([k.mode, k.at], ['remote_with', priya.id]);
});
