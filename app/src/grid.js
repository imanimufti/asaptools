// Availability grid: day columns × time rows in the viewer's timezone.
// Desktop: drag to paint. Touch: drag to paint, long-press to paint "if need be".
// Narrow screens show one day at a time (2d) with ≥44px cells.
import { h } from './dom.js';
import { localParts, coveredSlots } from '../../lib/slots.js';

const LONG_PRESS_MS = 450;
const narrowMq = window.matchMedia('(max-width: 640px)');

function timeLabel(min) {
  const hh = Math.floor(min / 60), mm = min % 60;
  const h12 = ((hh + 11) % 12) + 1, ap = hh < 12 ? 'AM' : 'PM';
  return mm ? '' : `${h12} ${ap}`;
}
function dayLabel(date) {
  const d = new Date(`${date}T12:00:00Z`);
  return {
    dow: new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(d),
    dom: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d),
  };
}

export function createGrid(opts) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let o = { editable: true, brush: 'free', mine: {}, counts: {}, total: 0, marks: {}, durationMin: 30, ...opts };
  let dayIndex = 0;
  const root = h('div', { class: 'grid-wrap' });

  // Layout from slots
  // A viewer "day" starts at the local time of the meeting's first slot, so a window that
  // crosses midnight for this viewer (e.g. 8am–8pm New York seen from London) stays one
  // continuous column instead of wrapping its late hours to the top.
  let cols = [], rows = [], cellOf = new Map(), placed = false;
  function layout() {
    const dates = new Set(), mins = new Set();
    cellOf = new Map();
    const anchor = o.slots.length ? localParts(o.slots[0], tz).minutes : 0;
    for (const s of o.slots) {
      const p = localParts(s, tz);
      const col = localParts(new Date(Date.parse(s) - anchor * 60000).toISOString(), tz).date;
      const row = (p.minutes - anchor + 1440) % 1440;
      dates.add(col); mins.add(row);
      cellOf.set(`${col}|${row}`, s);
    }
    cols = [...dates].sort();
    rows = [...mins].sort((a, b) => a - b).map((r) => ({ key: r, minutes: (r + anchor) % 1440 }));
    if (!placed && cols.length) {
      // Open on the first day anyone has painted (matters on phones, which show one day).
      placed = true;
      const busy = cols.findIndex((c) => rows.some((r) => { const s = cellOf.get(`${c}|${r.key}`); return s && (o.counts[s] || o.mine[s]); }));
      dayIndex = Math.max(0, busy);
    }
    dayIndex = Math.min(dayIndex, cols.length - 1);
  }
  const colOfSlot = (slot) => { for (const [k, s] of cellOf) if (s === slot) return k.split('|')[0]; return null; };

  // ----- painting -----
  let gesture = null; // { action: 'free'|'if_need_be'|null, timer, startX, startY, startSlot, touched:Set }
  function apply(slot) {
    if (!slot || gesture.touched.has(slot)) return;
    gesture.touched.add(slot);
    if (gesture.action) o.mine[slot] = gesture.action; else delete o.mine[slot];
    paintCell(slot);
  }
  function slotAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el?.closest?.('[data-slot]')?.dataset.slot || null;
  }
  function onDown(e) {
    const cell = e.target.closest('[data-slot]');
    if (!cell) return;
    const slot = cell.dataset.slot;
    if (!o.editable) { o.onCellClick?.(slot, cell); return; }
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    gesture = {
      action: o.mine[slot] === o.brush ? null : o.brush,
      startX: e.clientX, startY: e.clientY, startSlot: slot, touched: new Set(), moved: false,
    };
    if (e.pointerType !== 'mouse') {
      gesture.timer = setTimeout(() => {
        if (!gesture || gesture.moved) return;
        gesture.action = o.mine[slot] === 'if_need_be' && gesture.action !== 'if_need_be' ? null : 'if_need_be';
        gesture.touched.clear();
        apply(slot);
        navigator.vibrate?.(15);
      }, LONG_PRESS_MS);
    }
    apply(slot);
  }
  function onMove(e) {
    if (!gesture) return;
    if (Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) > 6) gesture.moved = true;
    apply(slotAt(e.clientX, e.clientY));
  }
  function onUp() {
    if (!gesture) return;
    clearTimeout(gesture.timer);
    const changed = gesture.touched.size > 0;
    gesture = null;
    if (changed) o.onChange?.({ ...o.mine });
  }

  // Keyboard: arrows move, Space/Enter paints with the current brush.
  let focus = null;
  function onKey(e) {
    if (!cols.length) return;
    const keys = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    let [c, r] = focus || [narrowMq.matches ? dayIndex : pageStart(), 0];
    if (keys[e.key]) {
      e.preventDefault();
      c = Math.max(0, Math.min(cols.length - 1, c + keys[e.key][0]));
      r = Math.max(0, Math.min(rows.length - 1, r + keys[e.key][1]));
      if (!inView(c)) { dayIndex = c; render(); }
      focus = [c, r];
      highlightFocus();
    } else if ((e.key === ' ' || e.key === 'Enter') && focus) {
      e.preventDefault();
      const slot = cellOf.get(`${cols[c]}|${rows[r].key}`);
      if (!slot) return;
      if (!o.editable) { o.onCellClick?.(slot, root.querySelector(`[data-slot="${slot}"]`)); return; }
      gesture = { action: o.mine[slot] === o.brush ? null : o.brush, touched: new Set() };
      apply(slot);
      onUp();
    }
  }
  function highlightFocus() {
    root.querySelector('.cell.kb')?.classList.remove('kb');
    if (!focus) return;
    const slot = cellOf.get(`${cols[focus[0]]}|${rows[focus[1]].key}`);
    const el = slot && root.querySelector(`[data-slot="${slot}"]`);
    if (el) { el.classList.add('kb'); el.scrollIntoView({ block: 'nearest' }); }
  }

  // ----- rendering -----
  // Desktop shows a week of columns at a time (longer windows page by week); phones show one day.
  const WEEK = 7;
  const pageStart = () => Math.floor(dayIndex / WEEK) * WEEK;
  const inView = (c) => (narrowMq.matches ? c === dayIndex : Math.floor(c / WEEK) === Math.floor(dayIndex / WEEK));
  function markSets() {
    const m = o.marks || {}, sets = { prop: new Set(), alt: new Set(), locked: new Set(), why: new Set() };
    if (m.proposed) coveredSlots(m.proposed, o.durationMin).forEach((s) => sets.prop.add(s));
    for (const a of m.alternates || []) coveredSlots(a, o.durationMin).forEach((s) => sets.alt.add(s));
    if (m.locked) coveredSlots(m.locked, o.durationMin).forEach((s) => sets.locked.add(s));
    if (m.why) sets.why.add(m.why);
    return sets;
  }
  let sets = markSets();
  function paintCell(slot, el = root.querySelector(`[data-slot="${CSS.escape(slot)}"]`)) {
    if (!el) return;
    const mine = o.mine[slot];
    const [f, i] = o.counts[slot] || [0, 0];
    const heat = o.total ? Math.min(1, (f + 0.5 * i) / o.total) : 0;
    el.style.setProperty('--heat', heat.toFixed(3));
    el.classList.toggle('free', mine === 'free');
    el.classList.toggle('inb', mine === 'if_need_be');
    el.classList.toggle('prop', sets.prop.has(slot));
    el.classList.toggle('alt', sets.alt.has(slot));
    el.classList.toggle('locked', sets.locked.has(slot));
    el.classList.toggle('why', sets.why.has(slot));
    const who = o.total ? `, ${f + i} of ${o.total} available` : '';
    el.setAttribute('aria-label', `${el.dataset.label}${mine ? `, you: ${mine === 'free' ? 'free' : 'if need be'}` : ''}${who}`);
  }

  function render() {
    layout();
    sets = markSets();
    const narrow = narrowMq.matches;
    const shown = narrow ? [cols[dayIndex]] : cols.slice(pageStart(), pageStart() + WEEK);
    root.replaceChildren();
    root.classList.toggle('readonly', !o.editable);

    if (narrow && cols.length > 1) {
      const { dow, dom } = dayLabel(cols[dayIndex]);
      root.append(h('div', { class: 'daynav' },
        h('button', { class: 'btn ghost icon', 'aria-label': 'Previous day', disabled: dayIndex === 0, onclick: () => { dayIndex--; render(); } }, '‹'),
        h('span', {}, `${dow} ${dom}`),
        h('button', { class: 'btn ghost icon', 'aria-label': 'Next day', disabled: dayIndex === cols.length - 1, onclick: () => { dayIndex++; render(); } }, '›'),
      ));
    } else if (!narrow && cols.length > WEEK) {
      const first = dayLabel(shown[0]), last = dayLabel(shown.at(-1));
      const ps = pageStart();
      root.append(h('div', { class: 'daynav' },
        h('button', { class: 'btn ghost icon', 'aria-label': 'Previous week', disabled: ps === 0, onclick: () => { dayIndex = ps - WEEK; render(); } }, '‹'),
        h('span', {}, `${first.dom} – ${last.dom}`, h('span', { class: 'muted small' }, ` · week ${ps / WEEK + 1} of ${Math.ceil(cols.length / WEEK)}`)),
        h('button', { class: 'btn ghost icon', 'aria-label': 'Next week', disabled: ps + WEEK >= cols.length, onclick: () => { dayIndex = ps + WEEK; render(); } }, '›'),
      ));
    }

    const grid = h('div', {
      class: 'grid', role: 'grid', tabindex: '0', 'aria-label': o.editable ? 'Your availability. Drag to paint.' : 'Availability',
      style: { gridTemplateColumns: `3.5rem repeat(${shown.length}, minmax(0, 1fr))` },
      onkeydown: onKey,
    });
    const tzShort = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value || '';
    grid.append(h('div', { class: 'corner' }, tzShort));
    for (const d of shown) {
      const { dow, dom } = dayLabel(d);
      grid.append(h('div', { class: 'colhead', role: 'columnheader' }, h('b', {}, dow), ' ', dom));
    }
    for (const [ri, { key, minutes: r }] of rows.entries()) {
      grid.append(h('div', { class: `rowhead${r % 60 ? ' half' : ''}${ri === 0 ? ' first' : ''}` }, timeLabel(r)));
      for (const d of shown) {
        const slot = cellOf.get(`${d}|${key}`);
        if (!slot) { grid.append(h('div', { class: 'cell off', 'aria-hidden': 'true' })); continue; }
        const { dow, dom } = dayLabel(d);
        const label = `${dow} ${dom} ${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`;
        const el = h('div', { class: `cell${r % 60 ? ' half' : ''}`, role: 'gridcell', 'data-slot': slot, 'data-label': label });
        paintCell(slot, el);
        grid.append(el);
      }
    }
    grid.addEventListener('pointerdown', onDown);
    grid.addEventListener('pointermove', onMove);
    grid.addEventListener('pointerup', onUp);
    grid.addEventListener('pointercancel', onUp);
    grid.addEventListener('lostpointercapture', onUp);
    grid.addEventListener('contextmenu', (e) => e.preventDefault());
    root.append(grid);
    highlightFocus();
  }

  narrowMq.addEventListener?.('change', render);
  render();

  return {
    el: root,
    // Update data without losing the current day/focus. Re-renders only if the slot list changed.
    update(next) {
      const slotsChanged = next.slots && next.slots !== o.slots && next.slots.join() !== o.slots.join();
      o = { ...o, ...next };
      if (slotsChanged) { render(); return; }
      sets = markSets();
      root.classList.toggle('readonly', !o.editable);
      for (const el of root.querySelectorAll('[data-slot]')) paintCell(el.dataset.slot, el);
    },
    cellEl: (slot) => root.querySelector(`[data-slot="${CSS.escape(slot)}"]`),
    showDayOf(slot) {
      const i = cols.indexOf(colOfSlot(slot));
      if (i >= 0 && !inView(i)) { dayIndex = i; render(); }
    },
    get mine() { return { ...o.mine }; },
  };
}
