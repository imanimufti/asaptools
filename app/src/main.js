import './styles.css';
import { h, toast, copy, store, session } from './dom.js';
import { api } from './api.js';
import { createGrid } from './grid.js';
import { setOrb, revealBeat } from './orb.js';
import { renderSpace } from './space.js';
import { generateSlots, todayIn } from '../../lib/slots.js';
import { evaluate } from '../../lib/scoring.js';
import {
  revealHeadline, reasons, whyNot, negotiationLine, paintedLine,
  declinedLine, addedConflictLine, flexAskLine, noticeLine,
} from '../../lib/copy.js';
import { formatSlot, shortSlot } from '../../lib/format.js';

const app = document.getElementById('app');
const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DURATIONS = [[30, '30 min'], [60, '1 hr'], [90, '1.5 hr'], [120, '2 hr']];
const WINDOWS = [[7, 'Next 7 days'], [30, 'Next 30 days']];
const DAY = { start: 8 * 60, end: 20 * 60 };
const ROLES = [['attendee', 'Attendee'], ['required', 'Required'], ['dm', 'Decision maker']];

function brushToggle(get, set) {
  const mk = (val, label, hint) => h('button', {
    class: `seg${get() === val ? ' on' : ''}`, type: 'button', 'aria-pressed': String(get() === val), title: hint,
    onclick: (e) => { set(val); for (const b of e.currentTarget.parentNode.children) { const on = b === e.currentTarget; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); } },
  }, h('i', { class: `sw ${val}` }), label);
  return h('div', { class: 'segs', role: 'group', 'aria-label': 'Paint as' },
    mk('free', 'Free', 'Paint times you’re free'),
    mk('if_need_be', 'If need be', 'Paint times that work if needed (long-press on touch)'));
}

const roleSelect = (value, onchange, label) => h('select', { class: 'field role', 'aria-label': label, onchange },
  ROLES.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
const roleFlags = (role) => ({ is_dm: role === 'dm', is_required: role === 'required' });

// ---------------------------------------------------------------- create (homepage)

function renderCreate() {
  document.title = 'ASAP';
  setOrb({ state: 'OPEN', responses: 0, total: 0 });
  const startDate = todayIn(viewerTz);
  const slotsFor = (days) => generateSlots({ startDate, days, dayStartMin: DAY.start, dayEndMin: DAY.end, tz: viewerTz });
  const st = { duration: 30, days: 7, brush: 'free', paints: {}, people: [], showPeople: false };

  const title = h('input', { class: 'title-input', placeholder: 'What’s the meeting?', maxlength: '200', 'aria-label': 'Meeting name', autocomplete: 'off' });
  const myName = h('input', { class: 'field', placeholder: 'Your name', maxlength: '80', 'aria-label': 'Your name', value: store.get('asap:name', '') });
  const myEmail = h('input', { class: 'field', type: 'email', placeholder: 'Your email (optional)', maxlength: '254', 'aria-label': 'Your email', value: store.get('asap:email', '') });

  const duration = h('select', { class: 'chip', 'aria-label': 'Duration', onchange: (e) => { st.duration = Number(e.target.value); grid.update({ durationMin: st.duration }); } },
    DURATIONS.map(([v, l]) => h('option', { value: v }, l)));
  const range = h('select', { class: 'chip', 'aria-label': 'Date range', onchange: (e) => {
    st.days = Number(e.target.value);
    const slots = slotsFor(st.days), keep = new Set(slots);
    st.paints = Object.fromEntries(Object.entries(st.paints).filter(([s]) => keep.has(s)));
    grid.update({ slots, mine: st.paints });
  } }, WINDOWS.map(([v, l]) => h('option', { value: v }, l)));
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
    status.textContent = `0 / ${n + 1} responded`;
    setOrb({ state: 'OPEN', responses: 0, total: n + 1 });
  }
  function addPerson() {
    st.people.push({ name: '', email: '', role: 'attendee' });
    drawPeople();
    peoplePanel.querySelectorAll('input[data-k="name"]')[st.people.length - 1]?.focus();
  }
  function drawPeople() {
    peoplePanel.replaceChildren(
      h('p', { class: 'muted small' }, 'Who needs to be there? Decision makers and Required people must be able to come — I won’t pick a time without them.'),
      ...st.people.map((p, i) => h('div', { class: 'person-row' },
        h('input', { class: 'field', 'data-k': 'name', placeholder: 'Name', maxlength: '80', value: p.name, 'aria-label': `Person ${i + 1} name`, oninput: (e) => { p.name = e.target.value; refreshCounts(); } }),
        h('input', { class: 'field', type: 'email', placeholder: 'Email (optional)', maxlength: '254', value: p.email, 'aria-label': `Person ${i + 1} email`, oninput: (e) => { p.email = e.target.value; } }),
        roleSelect(p.role, (e) => { p.role = e.target.value; }, `Person ${i + 1} role`),
        h('button', { class: 'btn ghost icon', type: 'button', 'aria-label': `Remove person ${i + 1}`, onclick: () => { st.people.splice(i, 1); drawPeople(); refreshCounts(); } }, '×'),
      )),
      h('button', { class: 'btn ghost', type: 'button', onclick: addPerson }, '+ Add person'),
    );
  }

  const grid = createGrid({
    slots: slotsFor(st.days), editable: true, brush: st.brush, mine: st.paints, durationMin: st.duration,
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
        window_start: startDate, window_days: st.days, day_start_min: DAY.start, day_end_min: DAY.end,
        organizer: { name: myName.value, email: myEmail.value || null, tz: viewerTz },
        people: people.map((p) => ({ name: p.name, email: p.email || null, ...roleFlags(p.role) })),
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
      h('div', { class: 'chips' }, duration, range, peopleBtn),
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
  const st = { view: null, grid: null, brush: 'free', dirty: false, mine: {}, showAlts: false, showWhy: false, why: null, revealedFor: null, poll: null, showAdd: false };
  const invites = session.take(`asap:invites:${token}`);
  app.replaceChildren(h('section', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…')));

  const isOrg = () => st.view?.role === 'organizer';
  const tz = viewerTz;
  const label = (s) => formatSlot(s, tz, st.view.meeting.duration_min);

  async function load({ quiet = false } = {}) {
    try { apply(await api.meeting(token)); }
    catch (e) { if (!quiet || e.status === 404) showError(e); }
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

  const orbStateFor = (v) => (v.meeting.state === 'OPEN' && v.negotiation ? 'NO_SLOT' : v.meeting.state);

  // Every action: run it, show the new view, toast on failure.
  const act = (fn, done) => async (...args) => {
    try { const v = await fn(...args); if (!v) return; apply(v); if (done) toast(typeof done === 'function' ? done(v) : done); }
    catch (e) { toast(e.message, 'error'); }
  };
  const save = act(async () => { const v = await api.savePaints(token, st.mine, tz); st.dirty = false; return v; }, () => (isOrg() ? 'Saved' : paintedLine()));
  const computeNow = act(async () => { if (st.dirty) { await api.savePaints(token, st.mine, tz); st.dirty = false; } return api.compute(token); });
  const lock = act((id) => api.lock(token, id), 'Locked');
  const repair = act((action) => api.repair(token, action));
  const flex = act((pid) => api.flex(token, pid), 'Asked');
  const answerFlex = act((a) => api.answerFlex(token, a), (v) => (v.flex ? 'Saved' : 'Thanks — I’ll let the organizer know.'));
  const widen = act(() => api.widen(token));
  const decline = act(async () => {
    if (!confirm('Let the organizer know you can’t make this time anymore?')) return null;
    return api.decline(token);
  }, 'The organizer will pick what happens next.');
  async function copyLink(p, rotate = false) {
    if (rotate && !confirm(`Make a new link for ${p.name}? Their old link will stop working.`)) return;
    try { copy((await api.link(token, p.id, rotate)).link); } catch (e) { toast(e.message, 'error'); }
  }

  function addForm() {
    const name = h('input', { class: 'field', placeholder: 'Name', maxlength: '80', 'aria-label': 'Name' });
    const mail = h('input', { class: 'field', type: 'email', placeholder: 'Email (optional)', maxlength: '254', 'aria-label': 'Email' });
    let role = 'attendee';
    const go = act(async () => {
      if (!name.value.trim()) { name.focus(); throw new Error('Add a name'); }
      const v = await api.addPerson(token, { name: name.value, email: mail.value || null, ...roleFlags(role) });
      st.showAdd = false;
      if (!v.added.emailed) copy(v.added.link);
      return v;
    }, (v) => (v.added.emailed ? `Invited ${v.added.name}` : `Copied ${v.added.name}’s link — send it to them`));
    return h('div', { class: 'add-row' }, name, mail, roleSelect(role, (e) => { role = e.target.value; }, 'Role'),
      h('button', { class: 'btn primary', type: 'button', onclick: go }, 'Add'));
  }

  function stateCard(v) {
    const m = v.meeting;
    const history = v.history?.length ? h('p', { class: 'history' }, ...v.history.map((s) => h('s', {}, shortSlot(s, tz), ' ')), '→ ', h('b', {}, shortSlot(v.lock?.slot || v.proposals?.[0]?.slot || v.history.at(-1), tz))) : null;

    if (v.flex && !isOrg()) {
      return h('div', { class: 'card amber' },
        h('p', {}, flexAskLine()), h('p', { class: 'big' }, label(v.flex.slot)),
        h('p', { class: 'muted small' }, 'Either answer is fine. The organizer only sees your reply.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => answerFlex('sure') }, 'Sure, I’ll flex'),
          h('button', { class: 'btn', type: 'button', onclick: () => answerFlex('cant') }, 'Can’t')));
    }
    if (m.state === 'LOCKED' && v.lock) {
      const added = !isOrg() && v.me.can_paint;
      return h('div', { class: 'card gold' },
        h('p', { class: 'kicker gold' }, 'Locked'),
        h('p', { class: 'big' }, label(v.lock.slot)),
        history,
        added ? h('p', {}, `${m.organizer} added you. Paint when you’re free so I can check this time works for you.`) : null,
        isOrg() && v.notice ? h('p', { class: 'small' }, noticeLine(v.notice, shortSlot(v.lock.slot, tz))) : null,
        h('div', { class: 'row' },
          h('a', { class: 'btn', href: `/m/${token}`, 'data-link': true }, 'Enter meeting space →'),
          isOrg() ? h('button', { class: 'btn ghost', type: 'button', 'aria-expanded': String(st.showAdd), onclick: () => { st.showAdd = !st.showAdd; draw(); } }, '+ Add someone') : null,
          !isOrg() && !added && !v.me.declined ? h('button', { class: 'btn ghost', type: 'button', onclick: decline }, 'Can’t make it anymore') : null),
        isOrg() && st.showAdd ? addForm() : null,
        h('p', { class: 'muted small' }, isOrg() ? 'Everyone with an email on file got a confirmation.' : added ? null : 'See you there.'));
    }
    if (m.state === 'DESTABILIZED' && isOrg() && v.issue) {
      const i = v.issue, when = shortSlot(i.slot, tz);
      const conflict = i.kind === 'added_conflict';
      return h('div', { class: 'card amber' },
        h('p', { class: 'big-ish' }, conflict ? addedConflictLine(i.name, when) : declinedLine(i.name, when)),
        h('p', { class: 'muted small' }, 'A new time is found from everyone’s existing answers — nobody repaints.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn amber', type: 'button', onclick: () => repair('find_new') }, conflict ? `Find a new time for all ${v.total}` : 'Find a new time'),
          h('button', { class: 'btn', type: 'button', onclick: () => repair('keep') }, conflict ? 'Invite as optional' : `Keep it without ${i.name}`)));
    }
    if (['DESTABILIZED', 'RECOMPUTING'].includes(m.state)) {
      return h('div', { class: 'card amber' }, h('p', {}, `${m.organizer} is finding a new time. Your answers are kept.`));
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
        history,
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
      const n = v.negotiation, asks = Object.fromEntries((n.asks || []).map((a) => [a.participant_id, a.status]));
      const blockers = (n.missing_required_ids || []).map((id, i) => ({ id, name: n.missing_required[i] }));
      return h('div', { class: 'card amber' },
        h('p', {}, negotiationLine(n.slot ? n : null, n.slot ? shortSlot(n.slot, tz) : '')),
        blockers.length ? h('div', { class: 'row' }, blockers.map((p) => {
          const s = asks[p.id];
          if (s === 'pending') return h('span', { class: 'chip static' }, `Asked ${p.name} · waiting`);
          if (s === 'cant') return h('span', { class: 'chip warn' }, `${p.name} can’t`);
          return h('button', { class: 'btn amber', type: 'button', onclick: () => flex(p.id) }, `Ask ${p.name} to flex`);
        })) : null,
        m.window_days < 31 ? h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: widen }, m.window_days < 30 ? 'Widen to the next 30 days' : 'Widen to 31 days')) : null,
        h('p', { class: 'muted small' }, 'The person you ask only sees that everyone else can make it, not who. Nothing is sent until you press a button.'));
    }
    if (m.state === 'OPEN' && isOrg()) {
      const waiting = v.total - v.responses;
      return h('div', { class: 'card' },
        h('p', {}, waiting ? `Waiting on ${waiting} of ${v.total}. I’ll find the time as soon as everyone’s in.` : 'Everyone’s in.'),
        v.notice ? h('p', { class: 'small' }, noticeLine(v.notice, '')) : null,
        h('p', { class: 'muted small' }, 'Or find the best time with the answers so far.'));
    }
    if (m.state === 'OPEN' && v.me.responded && !st.dirty) return h('div', { class: 'card' }, h('p', {}, paintedLine()));
    return null;
  }

  function invitesCard() {
    if (!invites?.length) return null;
    const box = h('div', { class: 'card' },
      h('div', { class: 'row spread' }, h('p', { class: 'kicker' }, 'Invite links'), h('button', { class: 'btn ghost small', type: 'button', onclick: () => box.remove() }, 'Done')),
      h('p', { class: 'muted small' }, 'Each person has their own link. Emailed ones are marked; send the rest yourself. You can copy them again from the people list.'),
      h('ul', { class: 'links' }, invites.map((p) => h('li', {},
        h('span', {}, p.name, p.is_dm ? h('span', { class: 'badge' }, 'DM') : p.is_required ? h('span', { class: 'badge' }, 'Required') : null, p.emailed ? h('span', { class: 'muted small' }, ' · emailed') : null),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => copy(p.link) }, 'Copy link')))),
      h('p', { class: 'muted small' }, 'Your organizer link is this page — bookmark it. ',
        h('button', { class: 'linkish', type: 'button', onclick: () => copy(location.href) }, 'Copy it')));
    return box;
  }

  function peopleList(v) {
    if (!isOrg()) return null;
    return h('div', { class: 'people-list' },
      h('p', { class: 'kicker' }, `${v.responses} of ${v.total} responded`),
      h('ul', {}, v.participants.map((p) => h('li', { class: p.declined ? 'out' : p.responded ? 'in' : '' },
        h('span', { class: 'dot', 'aria-hidden': 'true' }),
        h('span', { class: 'name' }, p.name, p.role === 'organizer' ? h('span', { class: 'muted small' }, ' (you)') : null),
        p.is_dm ? h('span', { class: 'badge' }, 'DM') : p.is_required ? h('span', { class: 'badge' }, 'Required') : null,
        h('span', { class: 'muted small' }, p.declined ? 'not coming' : p.optional ? 'optional' : p.responded ? 'in' : 'waiting'),
        p.role === 'invitee' ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => copyLink(p), title: 'Copy their link' }, 'Copy link') : null,
        p.role === 'invitee' ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => copyLink(p, true), title: 'Replace a lost or leaked link' }, 'Reset') : null))));
  }

  function onCellClick(slot) {
    const v = st.view;
    if (!isOrg() || v.meeting.state !== 'PROPOSED') return;
    const active = v.participants.filter((p) => !p.declined);
    const b = evaluate(slot, { durationMin: v.meeting.duration_min, participants: active, paints: v.paints_by_participant });
    st.why = whyNot(b, shortSlot(slot, tz));
    st.whySlot = slot;
    draw();
  }

  let topbar, cardSlot, peopleSlot, actions, gridHost;
  function draw() {
    const v = st.view, m = v.meeting;
    document.title = `${m.title} · ASAP`;
    setOrb({ state: orbStateFor(v), responses: v.responses, total: v.total });
    const top = v.proposals?.find((p) => p.status === 'proposed');
    const marks = {
      proposed: m.state === 'PROPOSED' ? (top?.slot || null) : null,
      alternates: m.state === 'PROPOSED' && st.showAlts ? v.proposals.filter((p) => p.status === 'alternate').map((p) => p.slot) : [],
      locked: v.lock?.slot || null,
      why: st.why ? st.whySlot : null,
    };
    // Organizer reviewing a proposal taps cells to ask "why not"; painting resumes when OPEN.
    const gridEditable = v.me.can_paint && !(isOrg() && m.state === 'PROPOSED');
    const gridOpts = { slots: m.slots, mine: st.mine, counts: v.counts, total: v.total, editable: gridEditable, brush: st.brush, durationMin: m.duration_min, marks };

    if (!st.grid) {
      st.grid = createGrid({ ...gridOpts, onChange: (mine) => { st.mine = mine; st.dirty = true; drawActions(); }, onCellClick });
      topbar = h('div', {}); cardSlot = h('div', {}); peopleSlot = h('div', {}); actions = h('div', { class: 'action-bar' }); gridHost = h('div', {});
      app.replaceChildren(h('section', { class: 'page' }, topbar, invitesCard(), cardSlot, peopleSlot, gridHost, actions));
      gridHost.append(st.grid.el);
    } else st.grid.update(gridOpts);

    const stateName = { OPEN: v.negotiation ? 'Won’t settle' : 'Collecting availability', PROPOSED: 'Proposed', LOCKED: 'Locked', COMPUTING: 'Thinking', DESTABILIZED: 'Needs a new time', RECOMPUTING: 'Finding a new time', CLOSED: 'Done' }[m.state];
    topbar.replaceChildren(...[
      h('p', { class: 'kicker' }, isOrg() ? 'You’re organizing' : `${m.organizer} invited you`),
      h('div', { class: 'row spread wrap' },
        h('h1', {}, m.title),
        h('span', { class: `chip state ${orbStateFor(v).toLowerCase()}` }, h('i', { class: 'pulse' }), stateName)),
      h('div', { class: 'chips' },
        h('span', { class: 'chip static' }, DURATIONS.find(([d]) => d === m.duration_min)?.[1] || `${m.duration_min} min`),
        h('span', { class: 'chip static' }, `${v.responses} / ${v.total} responded`)),
      gridEditable ? h('div', { class: 'paint-bar' }, brushToggle(() => st.brush, (b) => { st.brush = b; st.grid.update({ brush: b }); }),
        h('span', { class: 'muted small hint' }, isOrg() ? 'Faint shading = everyone’s answers so far.' : 'Drag to paint when you’re free. Shading = how many others can make it.')) : null,
    ].filter(Boolean));
    cardSlot.replaceChildren(stateCard(v) || '');
    peopleSlot.replaceChildren(peopleList(v) || '');
    drawActions();
  }

  let saveBtn = null;
  function drawActions() {
    const v = st.view, m = v.meeting;
    const editable = v.me.can_paint && !(isOrg() && m.state === 'PROPOSED');
    saveBtn = editable ? h('button', { class: `btn ${st.dirty || !v.me.responded ? 'primary' : ''}`, type: 'button', disabled: !st.dirty && v.me.responded, onclick: save },
      isOrg() ? 'Save my times' : (v.me.responded ? (st.dirty ? 'Update my times' : 'Saved') : 'Done')) : null;
    const find = isOrg() && m.state === 'OPEN' ? h('button', { class: 'btn primary', type: 'button', onclick: computeNow }, 'Find the time now') : null;
    const frozen = isOrg() && m.state === 'PROPOSED' ? h('span', { class: 'muted small' }, 'Times are frozen while you decide.') : null;
    actions.replaceChildren(h('span', { class: 'muted small' }, st.dirty ? 'Unsaved changes' : ''), h('div', { class: 'row' }, frozen, saveBtn, find));
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
  let m;
  if ((m = path.match(/^\/s\/([A-Za-z0-9_-]{16,})\/?$/))) cleanup = renderMeeting(m[1]);
  else if ((m = path.match(/^\/m\/([A-Za-z0-9_-]{16,})\/?$/))) cleanup = renderSpace(app, m[1]);
  else if (path === '/' || path === '/index.html') renderCreate();
  else {
    setOrb({ state: 'OPEN' });
    app.replaceChildren(h('section', { class: 'page narrow' }, h('h1', {}, 'Nothing here'), h('a', { class: 'btn', href: '/', 'data-link': true }, 'Schedule a meeting')));
  }
  window.scrollTo(0, 0);
}
export function navigate(path) { history.pushState(null, '', path); route(); }
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey && a.origin === location.origin) { e.preventDefault(); navigate(a.pathname); }
});
window.addEventListener('popstate', route);
route();
