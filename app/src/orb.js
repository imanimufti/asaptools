// The corner orb: a <nebula-field> driven only by meeting state and response counts
// (handoff §7). Motion is derived here on the client; nothing animation-related comes
// from the server.
import './nebula.js';

const wrap = document.getElementById('orb');
const field = wrap.querySelector('nebula-field');
const count = wrap.querySelector('.orb-count');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

function applyMotion() { field.setAttribute('motion', reduced.matches ? '0.12' : '1'); }
applyMotion();
reduced.addEventListener?.('change', applyMotion);

const PALETTE = {
  OPEN: 'open', COMPUTING: 'open', PROPOSED: 'locked', LOCKED: 'locked', CLOSED: 'locked',
  DESTABILIZED: 'resched', RECOMPUTING: 'resched', NO_SLOT: 'resched',
};

let last = null;

// state: meeting state (or 'NO_SLOT' for a failed compute); responses/total drive density + calm.
export function setOrb({ state = 'OPEN', responses = 0, total = 0 }) {
  const ratio = total ? responses / total : 0;
  let certainty = ratio, density = 0.15 + 0.85 * ratio;
  if (state === 'PROPOSED') { certainty = 0.8; density = 1; }
  if (state === 'LOCKED' || state === 'CLOSED') { certainty = 1; density = 1; }
  if (state === 'NO_SLOT') { certainty = 0; density = 0.6 + 0.4 * ratio; } // visibly won't settle
  field.setAttribute('state', PALETTE[state] || 'open');
  field.setAttribute('certainty', String(certainty));
  field.setAttribute('density', String(density));
  wrap.dataset.state = state;
  count.textContent = total ? `${responses}/${total}` : '';
  count.hidden = !total;
  last = state;
}

export const orbState = () => last;

// The reveal beat (2b): the orb swells to centre while "thinking", then docks on the winning
// cell before settling back in its corner. Skipped for reduced motion.
export async function revealBeat(targetEl) {
  if (reduced.matches || !targetEl || !wrap.animate) return;
  const from = wrap.getBoundingClientRect();
  const to = targetEl.getBoundingClientRect();
  const cx = window.innerWidth / 2 - (from.left + from.width / 2);
  const cy = window.innerHeight / 2 - (from.top + from.height / 2);
  const tx = to.left + to.width / 2 - (from.left + from.width / 2);
  const ty = to.top + to.height / 2 - (from.top + from.height / 2);
  field.setAttribute('state', 'open');
  field.setAttribute('certainty', '0');
  field.setAttribute('density', '1');
  await wrap.animate([
    { transform: 'translate(0,0) scale(1)' },
    { transform: `translate(${cx}px,${cy}px) scale(3.2)`, offset: 0.25 },
    { transform: `translate(${cx}px,${cy}px) scale(3.4)`, offset: 0.6 },
    { transform: `translate(${tx}px,${ty}px) scale(0.5)`, opacity: 1, offset: 0.9 },
    { transform: `translate(${tx}px,${ty}px) scale(0.3)`, opacity: 0 },
  ], { duration: 2400, easing: 'cubic-bezier(.5,0,.3,1)' }).finished.catch(() => {});
  field.setAttribute('state', 'locked');
  wrap.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500 });
}
