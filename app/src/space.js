// Meeting space (CUJ-7): the locked meeting as a star, attendees as nodes grouped by city.
// Shift-drag (or the Move toggle) a person: into a city's halo = in person there, onto a
// person = remote with them, open space = home. Only drops are saved; positions are not.
import './nebula.js';
import { h, toast } from './dom.js';
import { api } from './api.js';
import { setOrb } from './orb.js';
import { formatSlot } from '../../lib/format.js';
import { dropLine } from '../../lib/copy.js';

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

// Where each person is, as the graph shows it.
function placeOf(p, byId) {
  if (p.mode === 'in_person') return p.at;
  if (p.mode === 'remote_with') return byId[p.at]?.city || p.city;
  return p.city;
}

export function buildNodes(view) {
  const people = view.space || [];
  const byId = Object.fromEntries(people.map((p) => [p.id, p]));
  const place = (p) => (p.mode === 'remote_with' ? null : placeOf(p, byId));
  const counts = {};
  for (const p of people) { const k = place(p); if (k) counts[k] = (counts[k] || 0) + 1; }
  // Each place gets its own sector of the circle; people in the same place sit side by side
  // so their halo stays tight. Remote-with people sit next to the person they're with.
  const groupOf = (p) => (p.mode === 'remote_with' ? placeOf(p, byId) : place(p)) || '';
  const groups = [...new Set(people.map(groupOf))].sort();
  const STEP = 0.42; // radians between neighbours in one place
  const nodes = [{ id: 'star', type: 'star', angle: 0, dist: 0, label: view.meeting.title, sub: view.lock ? formatSlot(view.lock.slot, Intl.DateTimeFormat().resolvedOptions().timeZone, view.meeting.duration_min) : '' }];
  groups.forEach((g, gi) => {
    const centre = -Math.PI / 2 + (gi * 2 * Math.PI) / groups.length;
    const members = people.filter((p) => groupOf(p) === g).sort((a, b) => a.name.localeCompare(b.name));
    members.forEach((p, i) => {
      const k = place(p);
      const sub = p.mode === 'remote_with' ? `remote with ${byId[p.at]?.name || 'someone'}` : p.mode === 'in_person' ? `in person · ${p.at}` : p.city;
      nodes.push({
        id: p.id, type: 'person', angle: centre + (i - (members.length - 1) / 2) * STEP, dist: 0.72,
        cluster: k && counts[k] > 1 ? k : undefined, label: p.me ? `${p.name} (you)` : p.name, sub, kdm: p.is_dm,
      });
    });
  });
  return nodes;
}

export function renderSpace(app, token) {
  const st = { view: null, nodesJson: '', move: false, poll: null };
  document.body.classList.add('in-space');
  const field = h('nebula-field', { state: 'locked', certainty: '1', density: '0.6', motion: reduced.matches ? '0.12' : '1', class: 'space-field' });
  const moveBtn = h('button', { class: 'btn', type: 'button', 'aria-pressed': 'false', onclick: () => {
    st.move = !st.move; field.setAttribute('movemode', st.move ? '1' : '0');
    moveBtn.setAttribute('aria-pressed', String(st.move)); moveBtn.classList.toggle('on', st.move);
  } }, '✥ Move');
  const head = h('div', {}), side = h('aside', { class: 'space-side', 'aria-label': 'Attendees' }), note = h('p', { class: 'space-note', role: 'status' });
  app.replaceChildren(h('section', { class: 'page wide' }, head,
    h('div', { class: 'space-wrap' }, h('div', { class: 'space-canvas' }, field, note), side)));

  function draw() {
    const v = st.view, m = v.meeting;
    document.title = `${m.title} · meeting space · ASAP`;
    setOrb({ state: 'LOCKED', responses: v.responses, total: v.total });
    head.replaceChildren(
      h('a', { href: `/s/${token}`, 'data-link': true, class: 'small' }, '← Calendar'),
      h('div', { class: 'row spread wrap' }, h('h1', {}, m.title),
        h('span', { class: 'chip state locked' }, h('i', { class: 'pulse' }), v.lock ? `Locked · ${formatSlot(v.lock.slot, Intl.DateTimeFormat().resolvedOptions().timeZone, m.duration_min)}` : m.state)));
    if (!v.space) {
      side.replaceChildren(h('p', {}, 'The meeting space opens once the time is locked.'));
      field.removeAttribute('nodes');
      return;
    }
    const nodes = buildNodes(v), json = JSON.stringify(nodes);
    if (json !== st.nodesJson) { st.nodesJson = json; field.setAttribute('nodes', json); }
    const byId = Object.fromEntries(v.space.map((p) => [p.id, p]));
    const dms = v.space.filter((p) => p.is_dm);
    side.replaceChildren(
      h('p', { class: 'kicker' }, `${v.space.length} attending${dms.length ? ` · ${dms.length} DM` : ''}`),
      h('ul', { class: 'space-list' }, v.space.map((p) => h('li', {},
        h('span', {}, p.name, p.me ? h('span', { class: 'muted small' }, ' (you)') : null, p.is_dm ? h('span', { class: 'badge' }, 'DM') : null),
        h('span', { class: 'muted small' }, p.mode === 'remote_with' ? `remote with ${byId[p.at]?.name || '—'}` : p.mode === 'in_person' ? `${p.at} · in person` : `${p.city} · home`)))),
      h('div', { class: 'row' }, moveBtn),
      h('p', { class: 'muted small' }, 'Shift-drag (or Move) yourself. Into a city’s halo = in person there · onto a person = remote with them · open space = home.'),
      v.role === 'organizer' ? h('p', { class: 'muted small' }, 'As the organizer you can move anyone.') : null);
  }

  async function load(quiet) {
    try { st.view = await api.meeting(token); draw(); }
    catch (e) { if (!quiet) { toast(e.message, 'error'); app.replaceChildren(h('section', { class: 'page narrow' }, h('h1', {}, 'This link doesn’t work anymore'), h('a', { class: 'btn', href: '/', 'data-link': true }, 'Schedule a meeting'))); } }
  }

  field.addEventListener('nebula-nodedrop', async (e) => {
    const { id, target } = e.detail;
    const v = st.view, person = v.space?.find((p) => p.id === id);
    if (!person) return;
    if (v.role !== 'organizer' && !person.me) { toast('You can only move yourself'); st.nodesJson = ''; draw(); return; }
    try {
      st.view = await api.drop(token, id, target);
      const p = st.view.space.find((x) => x.id === id);
      const where = p.mode === 'remote_with' ? st.view.space.find((x) => x.id === p.at)?.name : p.at;
      note.textContent = `${dropLine(p.name, p.mode, where)} ⓘ`;
      note.title = 'Saved for everyone in the meeting. Drag again to change it.';
      draw();
    } catch (err) { toast(err.message, 'error'); st.nodesJson = ''; draw(); }
  });
  field.addEventListener('nebula-nodeclick', (e) => {
    const n = e.detail;
    if (n.type === 'person') note.textContent = `${n.label} · ${n.sub}`;
  });

  load(false);
  st.poll = setInterval(() => { if (!document.hidden) load(true); }, 5000);
  return () => { clearInterval(st.poll); document.body.classList.remove('in-space'); };
}
