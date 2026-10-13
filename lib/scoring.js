// Deterministic scoring engine (handoff §6). Pure functions, no I/O, no LLM.
//
// Required people = the organizer, decision makers and anyone marked Required, unless the
// organizer made them optional. A start slot is a candidate when every required person painted
// every slot the meeting covers (free or if-need-be). People who haven't painted a slot count
// as unavailable for it. Callers leave out people the meeting was kept without (declined).

import config from './scoring.v1.json' with { type: 'json' };
import { coveredSlots, localParts, STEP_MIN } from './slots.js';

export const SCORING = config;

export const isRequired = (p) => !p.optional && (p.is_dm || p.is_required || p.role === 'organizer');

// paints: { [participantId]: { [slotIso]: 'free' | 'if_need_be' } }
function availability(p, paints, covered) {
  const mine = paints[p.id] || {};
  let anyInb = false;
  for (const s of covered) {
    const lvl = mine[s];
    if (!lvl) return null;
    if (lvl === 'if_need_be') anyInb = true;
  }
  return anyInb ? 'if_need_be' : 'free';
}

function outsideHours(p, start, durationMin, cfg) {
  if (!p.tz) return false;
  const { minutes } = localParts(start, p.tz);
  return minutes < cfg.workhours.start_min || minutes + durationMin > cfg.workhours.end_min;
}

// Full breakdown for one start slot. This object is stored verbatim as breakdown_json and is
// the only input the copy templates and the ⓘ panel read from.
export function evaluate(start, { durationMin, participants, paints, cfg = config }) {
  const covered = coveredSlots(start, durationMin, STEP_MIN);
  const total = participants.length;
  const free = [], inb = [], missing = [], outside = [];
  for (const p of participants) {
    const a = availability(p, paints, covered);
    if (a === 'free') free.push(p);
    else if (a === 'if_need_be') inb.push(p);
    else { missing.push(p); continue; }
    if (outsideHours(p, start, durationMin, cfg)) outside.push(p);
  }
  const available = free.length + inb.length;
  const dms = participants.filter((p) => p.is_dm);
  const dmsPresent = dms.every((p) => !missing.includes(p));
  const missingRequired = missing.filter(isRequired);
  const invitees = participants.filter((p) => p.role !== 'organizer').length;
  const attendance = total ? available / total : 0;
  const belowQuorum = !(dmsPresent && (invitees <= 3 || attendance >= 0.5));
  const w = cfg.weights;
  const parts = {
    free_ratio: total ? free.length / total : 0,
    all_dms_present: dmsPresent ? 1 : 0,
    attendance_ratio: attendance,
    workhours_fit: available ? 1 - outside.length / available : 1,
    if_need_be: total ? inb.length / total : 0,
  };
  const score =
    w.free_ratio * parts.free_ratio +
    w.all_dms_present * parts.all_dms_present +
    w.attendance_ratio * parts.attendance_ratio +
    w.workhours_fit * parts.workhours_fit -
    w.if_need_be * parts.if_need_be;
  const names = (arr) => arr.map((p) => p.name);
  return {
    slot: start,
    weights_version: cfg.version,
    score: Math.round(score * 10000) / 10000,
    parts,
    total,
    available_n: available,
    free_n: free.length,
    inb_n: inb.length,
    missing: names(missing),
    missing_required: names(missingRequired),
    missing_required_ids: missingRequired.map((p) => p.id),
    inb_names: names(inb),
    outside_hours: names(outside),
    dm_names: names(dms),
    dms_present: dmsPresent,
    below_quorum: belowQuorum,
    candidate: missingRequired.length === 0 && available > 0,
  };
}

// Start slots whose whole duration fits inside the meeting's slot list (no crossing day ends).
export function startSlots(slots, durationMin) {
  const set = new Set(slots);
  return slots.filter((s) => coveredSlots(s, durationMin, STEP_MIN).every((c) => set.has(c)));
}

// Returns { proposals: [breakdown...] } best first, or { proposals: [], negotiation } when
// no start slot works for every required person (2f).
export function scoreMeeting({ slots, durationMin, participants, paints, cfg = config }) {
  const evals = startSlots(slots, durationMin).map((s) => evaluate(s, { durationMin, participants, paints, cfg }));
  const candidates = evals.filter((e) => e.candidate);
  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score || a.slot.localeCompare(b.slot));
    const top = candidates.slice(0, cfg.max_proposals);
    const lower = candidates.length - 1;
    for (const e of top) e.alternates_lower = lower;
    return { proposals: top, negotiation: null };
  }
  // Cheapest flex ask: the slot missing the fewest required people, then most attendance, then earliest.
  const near = evals
    .filter((e) => e.available_n > 0)
    .sort((a, b) =>
      a.missing_required.length - b.missing_required.length ||
      b.available_n - a.available_n ||
      a.slot.localeCompare(b.slot));
  const best = near[0];
  return {
    proposals: [],
    negotiation: best ? { slot: best.slot, missing_required: best.missing_required, missing_required_ids: best.missing_required_ids, available_n: best.available_n, total: best.total } : null,
  };
}
