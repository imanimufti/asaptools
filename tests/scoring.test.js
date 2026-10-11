import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreMeeting, evaluate } from '../lib/scoring.js';
import { reasons, revealHeadline, negotiationLine, whyNot } from '../lib/copy.js';

// Mon Oct 12 2026, 9:00–12:00 UTC in 30-minute slots
const S = (h, m = 0) => `2026-10-12T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
const slots = [S(9), S(9, 30), S(10), S(10, 30), S(11), S(11, 30)];
const people = [
  { id: 'o', name: 'Sarah', role: 'organizer', is_dm: false, tz: 'UTC' },
  { id: 'p', name: 'Priya', role: 'invitee', is_dm: true, tz: 'UTC' },
  { id: 'k', name: 'Ken', role: 'invitee', is_dm: false, tz: 'UTC' },
];
const paint = (...isos) => Object.fromEntries(isos.map((s) => [s, 'free']));

test('picks the slot where everyone is free', () => {
  const paints = { o: paint(S(9), S(10), S(11)), p: paint(S(10), S(11)), k: paint(S(10)) };
  const { proposals, negotiation } = scoreMeeting({ slots, durationMin: 30, participants: people, paints });
  assert.equal(negotiation, null);
  assert.equal(proposals[0].slot, S(10));
  assert.equal(proposals[0].available_n, 3);
  assert.equal(revealHeadline(proposals[0]), 'I found a time that works for all 3 of you.');
  assert.equal(proposals[0].alternates_lower, 1); // S(11) also works for the required people
});

test('free beats if-need-be at the same attendance', () => {
  const paints = {
    o: paint(S(9), S(10)), p: paint(S(9), S(10)),
    k: { [S(9)]: 'if_need_be', [S(10)]: 'free' },
  };
  const { proposals } = scoreMeeting({ slots, durationMin: 30, participants: people, paints });
  assert.equal(proposals[0].slot, S(10));
  assert.equal(proposals[1].slot, S(9));
  assert.deepEqual(proposals[1].inb_names, ['Ken']);
});

test('decision makers and the organizer are required; others are not', () => {
  // Ken (optional) is only free at 9; Priya (DM) only at 11. 11 must win even without Ken.
  const paints = { o: paint(S(9), S(11)), p: paint(S(11)), k: paint(S(9)) };
  const { proposals } = scoreMeeting({ slots, durationMin: 30, participants: people, paints });
  assert.deepEqual(proposals.map((p) => p.slot), [S(11)]);
  assert.deepEqual(proposals[0].missing, ['Ken']);
  assert.equal(revealHeadline(proposals[0]), 'I found a time that works for 2 of 3 of you.');
});

test('longer meetings need every covered slot painted', () => {
  const paints = { o: paint(S(9), S(9, 30), S(10)), p: paint(S(9), S(10), S(10, 30)), k: paint(S(9), S(9, 30), S(10), S(10, 30)) };
  const { proposals } = scoreMeeting({ slots, durationMin: 60, participants: people, paints });
  assert.equal(proposals.length, 0); // 9:00 misses Priya at 9:30; 10:00 misses Sarah at 10:30
  const ok = scoreMeeting({ slots, durationMin: 60, participants: people, paints: { ...paints, p: paint(S(9), S(9, 30)) } });
  assert.equal(ok.proposals[0].slot, S(9));
});

test('no common slot names the cheapest flex ask (2f)', () => {
  const paints = { o: paint(S(9), S(10)), p: paint(S(11)), k: paint(S(9), S(10)) };
  const { proposals, negotiation } = scoreMeeting({ slots, durationMin: 30, participants: people, paints });
  assert.equal(proposals.length, 0);
  assert.deepEqual(negotiation.missing_required, ['Priya']);
  assert.equal(negotiation.slot, S(9)); // 2 of 3 available, earliest
  assert.equal(negotiationLine(negotiation, 'Mon 9am'), 'No time works for everyone required. Closest: Mon 9am — only Priya is busy.');
});

test('working-hours guard penalises slots outside 8am–7pm local', () => {
  const ppl = [
    { id: 'o', name: 'Sarah', role: 'organizer', is_dm: false, tz: 'America/New_York' }, // 9:00Z = 5am NY
    { id: 'a', name: 'Amara', role: 'invitee', is_dm: false, tz: 'Europe/London' },
  ];
  const paints = { o: paint(S(9), S(14)), a: paint(S(9), S(14)) };
  const { proposals } = scoreMeeting({ slots: [S(9), S(14)], durationMin: 30, participants: ppl, paints });
  assert.equal(proposals[0].slot, S(14));
  assert.deepEqual(proposals[1].outside_hours, ['Sarah']);
});

test('soft quorum flags but still proposes', () => {
  const ppl = [people[0], people[1], ...['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, role: 'invitee', is_dm: false }))];
  const paints = { o: paint(S(9)), p: paint(S(9)), a: paint(S(9)) }; // 3 of 6 → 50% → ok
  const r1 = scoreMeeting({ slots, durationMin: 30, participants: ppl, paints });
  assert.equal(r1.proposals[0].below_quorum, false);
  const r2 = scoreMeeting({ slots, durationMin: 30, participants: ppl, paints: { o: paint(S(9)), p: paint(S(9)) } });
  assert.equal(r2.proposals[0].below_quorum, true); // 2 of 6 < 50%, more than 3 invitees
});

test('breakdown is deterministic and drives the copy', () => {
  const paints = { o: paint(S(10)), p: paint(S(10)), k: {} };
  const a = evaluate(S(10), { durationMin: 30, participants: people, paints });
  const b = evaluate(S(10), { durationMin: 30, participants: people, paints });
  assert.deepEqual(a, b);
  assert.equal(a.weights_version, 'v1');
  assert.ok(reasons(a).includes('Priya (decision maker) can attend'));
  assert.ok(reasons(a).includes("Ken can't make it"));
  assert.equal(whyNot(evaluate(S(9), { durationMin: 30, participants: people, paints }), 'Mon 9am'), "Mon 9am: Sarah and Priya can't make it (required).");
});
