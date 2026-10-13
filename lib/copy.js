// User-facing copy, filled only from breakdown fields (handoff §6). Every string the "AI"
// says lives here, so changing a template is a reviewable diff.

const list = (names) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

export function revealHeadline(b) {
  if (b.available_n === b.total) return `I found a time that works for all ${b.total} of you.`;
  return `I found a time that works for ${b.available_n} of ${b.total} of you.`;
}

// Reasons shown behind the ⓘ, in order.
export function reasons(b) {
  const out = [];
  if (b.free_n === b.total) out.push(`all ${b.total} painted it free`);
  else {
    out.push(`${b.free_n} free${b.inb_n ? `, ${b.inb_n} if need be (${list(b.inb_names)})` : ''}`);
    if (b.missing.length) out.push(`${list(b.missing)} can't make it`);
  }
  if (b.dm_names.length) out.push(b.dms_present ? `${list(b.dm_names)} (decision maker${b.dm_names.length > 1 ? 's' : ''}) can attend` : `a decision maker is missing`);
  out.push(b.outside_hours.length ? `outside working hours for ${list(b.outside_hours)}` : 'inside working hours for everyone');
  if (b.alternates_lower) out.push(`${b.alternates_lower} other time${b.alternates_lower > 1 ? 's' : ''} scored lower`);
  out.push(`score ${b.score} · weights ${b.weights_version}`);
  return out;
}

export function belowQuorumChip(b) {
  return b.below_quorum ? 'Below quorum' : null;
}

export function whyNot(b, slotLabel) {
  if (b.missing_required.length) return `${slotLabel}: ${list(b.missing_required)} can't make it (required).`;
  if (b.missing.length) return `${slotLabel}: ${list(b.missing)} can't make it. Score ${b.score}.`;
  return `${slotLabel}: works for everyone, but scored ${b.score}${b.inb_n ? ` (${b.inb_n} only if need be)` : ''}${b.outside_hours.length ? `, outside hours for ${list(b.outside_hours)}` : ''}.`;
}

export function negotiationLine(n, slotLabel) {
  if (!n) return 'Nobody has painted any times yet.';
  if (!n.missing_required.length) return `No time works yet. Closest: ${slotLabel}.`;
  return `No time works for everyone required. Closest: ${slotLabel} — only ${list(n.missing_required)} ${n.missing_required.length > 1 ? 'are' : 'is'} busy.`;
}

export function lockedLine(slotLabel) {
  return `${slotLabel} is locked.`;
}

export function declinedLine(name, slotLabel) {
  return `${name} can't make ${slotLabel} anymore. Want me to find another time, or keep it without them?`;
}

export function addedConflictLine(name, slotLabel) {
  return `${name} is busy ${slotLabel}. Invite them as optional, or find a new time for everyone?`;
}

export function flexAskLine() {
  return 'Everyone else can make this time. Could you move things to join?';
}

export function noticeLine(n, slotLabel) {
  if (!n) return null;
  if (n.type === 'added_ok') return `${n.name} is free ${slotLabel} — adding them didn't move anything.`;
  if (n.type === 'added') return `${n.name} was added. I'll check the time once they paint.`;
  if (n.type === 'kept_without') return `Kept the time without ${n.name}.`;
  if (n.type === 'made_optional') return `${n.name} is invited as optional.`;
  if (n.type === 'flex_cant') return `${n.name} can't move things. Widening the dates is the next option.`;
  if (n.type === 'flex_sure') return `${n.name} can flex.`;
  if (n.type === 'widened') return `The window now covers ${n.to} days. People can paint the new days.`;
  return null;
}

export function dropLine(name, mode, place) {
  if (mode === 'in_person') return `${name} joins in person in ${place}.`;
  if (mode === 'remote_with') return `${name} attends remotely with ${place}.`;
  return `${name} attends from home.`;
}

export function paintedLine() {
  return 'Got it — I’ll let you know when I find the time.';
}
