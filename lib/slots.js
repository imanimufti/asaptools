// Slot math shared by the browser and the API. Slots are UTC instants (ISO strings);
// a meeting's slots are generated from its organizer-local window so every client and
// the server agree on the exact same list.

export const STEP_MIN = 30;

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTz(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { dtf(tz); return true; } catch { return false; }
}

function parts(ms, tz) {
  const o = {};
  for (const p of dtf(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}

// Offset of tz from UTC at an instant, in minutes (local - utc).
function offsetMin(ms, tz) {
  const p = parts(ms, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - ms) / 60000);
}

// UTC ms for a wall-clock time (date 'YYYY-MM-DD' + minutes after midnight) in tz.
export function zonedToUtcMs(date, minutes, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const off1 = offsetMin(guess, tz);
  let ms = guess - off1 * 60000;
  const off2 = offsetMin(ms, tz);
  if (off2 !== off1) ms = guess - off2 * 60000;
  return ms;
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Today's date in tz as 'YYYY-MM-DD'.
export function todayIn(tz, now = Date.now()) {
  const p = parts(now, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

// Wall-clock view of an instant in tz: { date: 'YYYY-MM-DD', minutes, weekday }.
export function localParts(iso, tz) {
  const p = parts(Date.parse(iso), tz);
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute, weekday: p.weekday };
}

export function generateSlots({ startDate, days, dayStartMin, dayEndMin, tz, stepMin = STEP_MIN }) {
  const out = new Set();
  for (let i = 0; i < days; i++) {
    const date = addDays(startDate, i);
    for (let m = dayStartMin; m + stepMin <= dayEndMin; m += stepMin) {
      out.add(new Date(zonedToUtcMs(date, m, tz)).toISOString());
    }
  }
  return [...out].sort();
}

// Slots covered by a meeting starting at `iso`.
export function coveredSlots(iso, durationMin, stepMin = STEP_MIN) {
  const start = Date.parse(iso), n = Math.ceil(durationMin / stepMin), out = [];
  for (let i = 0; i < n; i++) out.push(new Date(start + i * stepMin * 60000).toISOString());
  return out;
}
