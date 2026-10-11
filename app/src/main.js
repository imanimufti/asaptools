import './styles.css';
import { h, toast, copy, store, session } from './dom.js';
import { api } from './api.js';
import { createGrid } from './grid.js';
import { setOrb, revealBeat } from './orb.js';
import { generateSlots, todayIn } from '../../lib/slots.js';
import { evaluate } from '../../lib/scoring.js';
import { revealHeadline, reasons, whyNot, negotiationLine, paintedLine } from '../../lib/copy.js';
import { formatSlot, shortSlot } from '../../lib/format.js';

const app = document.getElementById('app');
const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DURATIONS = [[30, '30 min'], [60, '1 hr'], [90, '1.5 hr'], [120, '2 hr']];
const WINDOW = { days: 7, dayStartMin: 8 * 60, dayEndMin: 20 * 60 };

function brushToggle(get, set) {
  const mk = (val, label, hint) => h('button', {
    class: `seg${get() === val ? ' on' : ''}`, type: 'button', 'aria-pressed': String(get() === val), title: hint,
    onclick: (e) => { set(val); for (const b of e.currentTarget.parentNode.children) { const on = b === e.currentTarget; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); } },
  }, h('i', { class: `sw ${val}` }), label);
  return h('div', { class: 'segs', role: 'group', 'aria-label': 'Paint as' },
    mk('free', 'Free', 'Paint times you’re free'),
    mk('if_need_be', 'If need be', 'Paint times that work if needed (long-press on touch)'));
}

// ---------------------------------------------------------------- create (homepage)

function renderCreate() {
  document.title = 'ASAP';
  setOrb({ state: 'OPEN', responses: 0, total: 0 });
  const startDate = todayIn(viewerTz);
  const slots = generateSlots({ startDate, days: WINDOW.days, dayStartMin: WINDOW.dayStartMin, dayEndMin: WINDOW.dayEndMin, tz: viewerTz });
  const st = { duration: 30, brush: 'free', paints: {}, people: [], showPeople: false };

  const title = h('input', { class: 'title-input', placeholder: 'What’s the meeting?', maxlength: '200', 'aria-label': 'Meeting name', autocomplete: 'off' });
  const myName = h('input', { class: 'field', placeholder: 'Your name', maxlength: '80', 'aria-label': 'Your name', value: store.get('asap:name', '') });
  const myEmail = h('input', { class: 'field', type: 'email', placeholder: 'Your email (optional)', maxlength: '254', 'aria-label': 'Your email', value: store.get('asap:email', '') });

  const duration = h('select', { class: 'chip', 'aria-label': 'Duration', onchange: (e) => { st.duration = Number(e.target.value); grid.update({ durationMin: st.duration }); } },
    DURATIONS.map(([v, l]) => h('option', { value: v }, l)));
  const peopleBtn = h('button', { class: 'chip', type: 'button', 'aria-expanded': 'false', onclick: () => togglePeople() });
  const peoplePanel = h('div', { class: 'panel people', hidden: true });
  const status = h('span', { class: 'muted' });
  const send = h('button', { class: 'btn primary', type: 'button', onclick: submit }, 'Send invites');

  function togglePeople(force) {
    st.showPeople = force ?? !st.showPeople;
    peoplePanel.hidden = !st.showPeople;
    peopleBtn.setAttribute('aria-expanded', String(st.showPeople));
    if (st.showPeople && !st.people.length) addPerson();
  }
  function refreshCounts() {
    const n = st.people.filter((p) => p.name.trim()).length;
    peopleBtn.textContent = n ? `${n} ${n === 1 ? 'person' : 'people'}` : '+ people';
    const total = n + 1;
    status.textContent = `0 / ${total} responded`;
    setOrb({ state: 'OPEN', responses: 0, total });
  }
  function addPerson() {
    st.people.push({ name: '', email: '', is_dm: false });
    drawPeople();
    peoplePanel.querySelectorAll('input[data-k="name"]')[st.people.length - 1]?.focus();
  }
  function drawPeople() {
    peoplePanel.replaceChildren(
      h('p', { class: 'muted small' }, 'Who needs to be there? Mark decision makers — I won’t pick a time without them.'),
      ...st.people.map((p, i) => h('div', { class: 'person-row' },
        h('input', { class: 'field', 'data-k': 'name', placeholder: 'Name', maxlength: '80', value: p.name, 'aria-label': `Person ${i + 1} name`, oninput: (e) => { p.name = e.target.value; refreshCounts(); } }),
        h('input', { class: 'field', type: 'email', placeholder: 'Email (optional)', maxlength: '254', value: p.email, 'aria-label': `Person ${i + 1} email`, oninput: (e) => { p.email = e.target.value; } }),
        h('label', { class: 'dm-toggle' }, h('input', { type: 'checkbox', checked: p.is_dm, onchange: (e) => { p.is_dm = e.target.checked; } }), 'Decision maker'),
        h('button', { class: 'btn ghost icon', type: 'button', 'aria-label': `Remove person ${i + 1}`, onclick: () => { st.people.splice(i, 1); drawPeople(); refreshCounts(); } }, '×'),
      )),
      h('button', { class: 'btn ghost', type: 'button', onclick: addPerson }, '+ Add person'),
    );
  }

  const grid = createGrid({
    slots, editable: true, brush: st.brush, mine: st.paints, durationMin: st.duration,
    onChange: (m) => { st.paints = m; },
  });

  async function submit() {
    const people = st.people.filter((p) => p.name.trim());
    if (!title.value.trim()) { title.focus(); return toast('Name the meeting first'); }
    if (!myName.value.trim()) { myName.focus(); return toast('Add your name'); }
    if (!people.length) { togglePeople(true); return toast('Add at least one person'); }
    if (!Object.keys(st.paints).length) return toast('Paint at least one time you’re free');
    send.disabled = true; send.textContent = 'Sending…';
    store.set('asap:name', myName.value.trim());
    store.set('asap:email', myEmail.value.trim());
    try {
      const r = await api.createMeeting({
        title: title.value, duration_min: st.duration, tz: viewerTz,
        window_start: startDate, window_days: WINDOW.days, day_start_min: WINDOW.dayStartMin, day_end_min: WINDOW.dayEndMin,
        organizer: { name: myName.value, email: myEmail.value || null, tz: viewerTz },
        people: people.map((p) => ({ name: p.name, email: p.email || null, is_dm: p.is_dm })),
        paints: st.paints,
      });
      const recent = store.get('asap:recent', []).filter((m) => m.token !== r.organizer_token);
      store.set('asap:recent', [{ token: r.organizer_token, title: title.value.trim(), at: Date.now() }, ...recent].slice(0, 10));
      session.set(`asap:invites:${r.organizer_token}`, r.invites);
      navigate(`/s/${r.organizer_token}`);
    } catch (e) {
      toast(e.message, 'error');
      send.disabled = false; send.textContent = 'Send invites';
    }
  }

  const recent = store.get('asap:recent', []);
  app.replaceChildren(
    h('section', { class: 'page' },
      title,
      h('div', { class: 'chips' }, duration, h('span', { class: 'chip static' }, 'Next 7 days'), peopleBtn),
      peoplePanel,
      h('div', { class: 'me-row' }, myName, myEmail),
      h('div', { class: 'paint-bar' }, brushToggle(() => st.brush, (b) => { st.brush = b; grid.update({ brush: b }); }),
        h('span', { class: 'muted small hint' }, 'Drag to paint when you’re free.')),
      grid.el,
      h('div', { class: 'action-bar' }, status, send),
      recent.length ? h('div', { class: 'recent' }, h('h2', {}, 'Your meetings'),
        h('ul', {}, recent.map((m) => h('li', {}, h('a', { href: `/s/${m.token}`, 'data-link': true }, m.title))))) : null,
    ),
  );
  refreshCounts();
  title.focus();
}

// ---------------------------------------------------------------- meeting (/s/:token)

function renderMeeting(token) {
  const st = { view: null, grid: null, brush: 'free', dirty: false, mine: {}, showAlts: false, showWhy: false, why: null, revealedFor: null, poll: null };
  const invites = session.take(`asap:invites:${token}`);
  app.replaceChildren(h('section', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…')));

  const isOrg = () => st.view?.role === 'organizer';
  const tz = viewerTz;

  async function load({ quiet = false } = {}) {
    try {
      const v = await api.meeting(token);
      apply(v);
    } catch (e) {
      if (!quiet || e.status === 404) showError(e);
    }
  }

  function showError(e) {
    clearInterval(st.poll);
    setOrb({ state: 'OPEN' });
    app.replaceChildren(h('section', { class: 'page narrow' },
      h('h1', {}, e.status === 404 ? 'This link doesn’t work anymore' : 'Something went wrong'),
      h('p', { class: 'muted' }, e.status === 404 ? 'Ask the organizer for a fresh link.' : e.message),
      h('a', { class: 'btn', href: '/', 'data-link': true }, 'Schedule a meeting')));
  }

  function apply(v) {
    const prevState = st.view?.meeting.state;
    st.view = v;
    if (!st.dirty) st.mine = { ...v.my_paints };
    draw();
    const top = v.proposals?.find((p) => p.status === 'proposed');
    if (v.meeting.state === 'PROPOSED' && top && st.revealedFor !== top.id && prevState !== 'PROPOSED') {
      st.revealedFor = top.id;
      st.grid.showDayOf(top.slot);
      revealBeat(st.grid.cellEl(top.slot));
    } else if (top) st.revealedFor = top.id;
  }

  function orbStateFor(v) {
    if (v.meeting.state === 'OPEN' && v.negotiation) return 'NO_SLOT';
    return v.meeting.state;
  }

  async function save() {
    try {
      saveBtn && (saveBtn.disabled = true);
      const v = await api.savePaints(token, st.mine, tz);
      st.dirty = false;
      apply(v);
      toast(isOrg() ? 'Saved' : paintedLine());
    } catch (e) { toast(e.message, 'error'); saveBtn && (saveBtn.disabled = false); }
  }
  async function computeNow() {
    try {
      if (st.dirty) { await api.savePaints(token, st.mine, tz); st.dirty = false; }
      apply(await api.compute(token));
    } catch (e) { toast(e.message, 'error'); }
  }
  async function lock(id) {
    try { apply(await api.lock(token, id)); toast('Locked'); } catch (e) { toast(e.message, 'error'); }
  }
  async function freshLink(p) {
    if (!confirm(`Make a new link for ${p.name}? Their old link will stop working.`)) return;
    try { const r = await api.newLink(token, p.id); copy(r.link); } catch (e) { toast(e.message, 'error'); }
  }

  let saveBtn = null;

  function stateCard(v) {
    const m = v.meeting;
    const label = (s) => formatSlot(s, tz, m.duration_min);
    if (m.state === 'LOCKED' && v.lock) {
      return h('div', { class: 'card gold' },
        h('p', { class: 'kicker gold' }, 'Locked'),
        h('p', { class: 'big' }, label(v.lock.slot)),
        h('p', { class: 'muted small' }, isOrg() ? 'Everyone with an email on file got a confirmation.' : 'See you there.'));
    }
    if (m.state === 'PROPOSED' && isOrg()) {
      const top = v.proposals.find((p) => p.status === 'proposed');
      const alts = v.proposals.filter((p) => p.status === 'alternate');
      if (!top) return null;
      const b = top.breakdown;
      return h('div', { class: 'card gold reveal' },
        h('p', {}, revealHeadline(b), ' ',
          h('button', { class: 'info', type: 'button', 'aria-expanded': String(st.showWhy), 'aria-label': 'Why this time', onclick: () => { st.showWhy = !st.showWhy; draw(); } }, 'ⓘ')),
        h('p', { class: 'big' }, label(top.slot)),
        b.below_quorum ? h('span', { class: 'chip warn' }, 'Below quorum') : null,
        st.showWhy ? h('ul', { class: 'reasons' }, reasons(b).map((r) => h('li', {}, r))) : null,
        h('div', { class: 'row' },
          h('button', { class: 'btn gold', type: 'button', onclick: () => lock(top.id) }, 'Lock it'),
          alts.length ? h('button', { class: 'btn ghost', type: 'button', 'aria-expanded': String(st.showAlts), onclick: () => { st.showAlts = !st.showAlts; draw(); } }, st.showAlts ? 'Hide alternates' : `Show alternates (${alts.length})`) : null),
        st.showAlts ? h('ul', { class: 'alts' }, alts.map((a) => h('li', {},
          h('span', {}, `${label(a.slot)} · ${a.breakdown.available_n} of ${a.breakdown.total}`),
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => lock(a.id) }, 'Lock this instead')))) : null,
        h('p', { class: 'muted small' }, st.why ? st.why : 'Tap any other time to ask why not.'));
    }
    if (m.state === 'PROPOSED') {
      return h('div', { class: 'card' }, h('p', {}, `${m.organizer} is choosing the final time. You can still change your times until then.`));
    }
    if (m.state === 'OPEN' && isOrg() && v.negotiation) {
      const n = v.negotiation;
      return h('div', { class: 'card amber' },
        h('p', {}, negotiationLine(n.slot ? n : null, n.slot ? shortSlot(n.slot, tz) : '')),
        h('p', { class: 'muted small' }, n.missing_required?.length
          ? `Ask ${n.missing_required.join(' and ')} to update their times — use “New link” below if they lost theirs — then find the time again.`
          : 'Wait for more people to paint, then find the time again.'));
    }
    if (m.state === 'OPEN' && isOrg()) {
      const waiting = v.total - v.responses;
      return h('div', { class: 'card' },
        h('p', {}, waiting ? `Waiting on ${waiting} of ${v.total}. I’ll find the time as soon as everyone’s in.` : 'Everyone’s in.'),
        h('p', { class: 'muted small' }, 'Or find the best time with the answers so far.'));
    }
    if (m.state === 'OPEN' && v.me.responded && !st.dirty) {
      return h('div', { class: 'card' }, h('p', {}, paintedLine()));
    }
    return null;
  }

  function invitesCard() {
    if (!invites?.length) return null;
    const box = h('div', { class: 'card' },
      h('div', { class: 'row spread' }, h('p', { class: 'kicker' }, 'Invite links'), h('button', { class: 'btn ghost small', type: 'button', onclick: () => box.remove() }, 'Done')),
      h('p', { class: 'muted small' }, 'Each person has their own link. Emailed ones are marked; send the rest yourself. This is the only time links are shown — you can make new ones later.'),
      h('ul', { class: 'links' }, invites.map((p) => h('li', {},
        h('span', {}, p.name, p.is_dm ? h('span', { class: 'badge' }, 'DM') : null, p.emailed ? h('span', { class: 'muted small' }, ' · emailed') : null),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => copy(p.link) }, 'Copy link')))),
      h('p', { class: 'muted small' }, 'Your organizer link is this page — bookmark it. ',
        h('button', { class: 'linkish', type: 'button', onclick: () => copy(location.href) }, 'Copy it')));
    return box;
  }

  function peopleList(v) {
    if (!isOrg()) return null;
    return h('div', { class: 'people-list' },
      h('p', { class: 'kicker' }, `${v.responses} of ${v.total} responded`),
      h('ul', {}, v.participants.map((p) => h('li', { class: p.responded ? 'in' : '' },
        h('span', { class: 'dot', 'aria-hidden': 'true' }),
        h('span', { class: 'name' }, p.name, p.role === 'organizer' ? h('span', { class: 'muted small' }, ' (you)') : null),
        p.is_dm ? h('span', { class: 'badge' }, 'DM') : null,
        h('span', { class: 'muted small' }, p.responded ? 'in' : 'waiting'),
        p.role === 'invitee' ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => freshLink(p) }, 'New link') : null))));
  }

  function onCellClick(slot) {
    const v = st.view;
    if (!isOrg() || v.meeting.state !== 'PROPOSED') return;
    const b = evaluate(slot, { durationMin: v.meeting.duration_min, participants: v.participants, paints: v.paints_by_participant });
    st.why = whyNot(b, shortSlot(slot, tz));
    st.whySlot = slot;
    draw();
  }

  let topbar, cardSlot, peopleSlot, actions, gridHost;
  function draw() {
    const v = st.view, m = v.meeting;
    document.title = `${m.title} · ASAP`;
    setOrb({ state: orbStateFor(v), responses: v.responses, total: v.total });
    const editable = ['OPEN', 'PROPOSED'].includes(m.state);
    const top = v.proposals?.find((p) => p.status === 'proposed');
    const marks = {
      proposed: m.state === 'PROPOSED' ? (top?.slot || null) : null,
      alternates: m.state === 'PROPOSED' && st.showAlts ? v.proposals.filter((p) => p.status === 'alternate').map((p) => p.slot) : [],
      locked: v.lock?.slot || null,
      why: st.why ? st.whySlot : null,
    };
    // Organizer reviewing a proposal taps cells to ask "why not"; painting resumes when OPEN.
    const gridEditable = editable && !(isOrg() && m.state === 'PROPOSED');
    const gridOpts = { slots: m.slots, mine: st.mine, counts: v.counts, total: v.total, editable: gridEditable, brush: st.brush, durationMin: m.duration_min, marks };

    if (!st.grid) {
      st.grid = createGrid({ ...gridOpts, onChange: (mine) => { st.mine = mine; st.dirty = true; drawActions(); }, onCellClick });
      topbar = h('div', {}); cardSlot = h('div', {}); peopleSlot = h('div', {}); actions = h('div', { class: 'action-bar' }); gridHost = h('div', {});
      app.replaceChildren(h('section', { class: 'page' }, topbar, invitesCard(), cardSlot, peopleSlot, gridHost, actions));
      gridHost.append(st.grid.el);
    } else st.grid.update(gridOpts);

    const stateName = { OPEN: 'Collecting availability', PROPOSED: 'Proposed', LOCKED: 'Locked', COMPUTING: 'Thinking', DESTABILIZED: 'Needs a new time', RECOMPUTING: 'Rescheduling', CLOSED: 'Done' }[m.state];
    topbar.replaceChildren(...[
      h('p', { class: 'kicker' }, isOrg() ? 'You’re organizing' : `${m.organizer} invited you`),
      h('div', { class: 'row spread wrap' },
        h('h1', {}, m.title),
        h('span', { class: `chip state ${orbStateFor(v).toLowerCase()}` }, h('i', { class: 'pulse' }), stateName)),
      h('div', { class: 'chips' },
        h('span', { class: 'chip static' }, DURATIONS.find(([d]) => d === m.duration_min)?.[1] || `${m.duration_min} min`),
        h('span', { class: 'chip static' }, `${v.responses} / ${v.total} responded`)),
      editable && gridEditable ? h('div', { class: 'paint-bar' }, brushToggle(() => st.brush, (b) => { st.brush = b; st.grid.update({ brush: b }); }),
        h('span', { class: 'muted small hint' }, isOrg() ? 'Faint shading = everyone’s answers so far.' : 'Drag to paint when you’re free. Shading = how many others can make it.')) : null,
    ].filter(Boolean));
    cardSlot.replaceChildren(stateCard(v) || '');
    peopleSlot.replaceChildren(peopleList(v) || '');
    drawActions();
  }

  function drawActions() {
    const v = st.view, m = v.meeting;
    const editable = ['OPEN', 'PROPOSED'].includes(m.state) && !(isOrg() && m.state === 'PROPOSED');
    saveBtn = editable ? h('button', { class: `btn ${st.dirty || !v.me.responded ? 'primary' : ''}`, type: 'button', disabled: !st.dirty && v.me.responded, onclick: save },
      isOrg() ? 'Save my times' : (v.me.responded ? (st.dirty ? 'Update my times' : 'Saved') : 'Done')) : null;
    const find = isOrg() && m.state === 'OPEN' ? h('button', { class: 'btn primary', type: 'button', onclick: computeNow }, 'Find the time now') : null;
    const reopen = isOrg() && m.state === 'PROPOSED' ? h('span', { class: 'muted small' }, 'Times are frozen while you decide.') : null;
    actions.replaceChildren(h('span', { class: 'muted small' }, st.dirty ? 'Unsaved changes' : ''), h('div', { class: 'row' }, reopen, saveBtn, find));
  }

  load();
  // Realtime arrives with Supabase Realtime; until then, poll while the tab is visible.
  st.poll = setInterval(() => { if (!document.hidden) load({ quiet: true }); }, 5000);
  return () => clearInterval(st.poll);
}

// ---------------------------------------------------------------- router

let cleanup = null;
function route() {
  cleanup?.(); cleanup = null;
  const path = location.pathname;
  const m = path.match(/^\/s\/([A-Za-z0-9_-]{16,})\/?$/);
  if (m) cleanup = renderMeeting(m[1]);
  else if (path === '/' || path === '/index.html') renderCreate();
  else {
    setOrb({ state: 'OPEN' });
    app.replaceChildren(h('section', { class: 'page narrow' }, h('h1', {}, 'Nothing here'), h('a', { class: 'btn', href: '/', 'data-link': true }, 'Schedule a meeting')));
  }
  window.scrollTo(0, 0);
}
function navigate(path) { history.pushState(null, '', path); route(); }
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey && a.origin === location.origin) { e.preventDefault(); navigate(a.pathname); }
});
window.addEventListener('popstate', route);
route();
