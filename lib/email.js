// Resend email (handoff §12). Templates are fixed text filled from data; nothing is generated.
// Without RESEND_API_KEY, emails are logged and reported as not sent, so the app still works
// locally and the organizer can share links by hand.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TEMPLATES = {
  invite: (d) => ({
    subject: `${d.organizer} asked when you're free: ${d.title}`,
    text: `${d.organizer} asked me to find a time for "${d.title}". Paint when you're free:\n\n${d.link}\n\nNo account needed.\n\n— ASAP`,
  }),
  reveal: (d) => ({
    subject: `I found a time for ${d.title}`,
    text: `${d.headline}\n\n${d.slot}\n\nLock it here: ${d.link}\n\n— ASAP`,
  }),
  lock_confirm: (d) => ({
    subject: `Locked: ${d.title} · ${d.slot}`,
    text: `"${d.title}" is locked for ${d.slot}.\n\nDetails: ${d.link}\n\n— ASAP`,
  }),
};

export async function sendEmail(template, to, data) {
  const t = TEMPLATES[template](data);
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) {
    console.log(`[email:${template}] not sent (${!key ? 'no RESEND_API_KEY' : 'no address'}) → ${to || '-'}: ${t.subject}`);
    return { sent: false };
  }
  const html = `<div style="font:15px/1.5 system-ui,sans-serif;white-space:pre-wrap">${esc(t.text)}</div>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM || 'ASAP <hello@asap.tools>', to: [to], subject: t.subject, text: t.text, html }),
  });
  if (!res.ok) {
    console.error(`[email:${template}] Resend ${res.status}: ${await res.text()}`);
    return { sent: false };
  }
  return { sent: true };
}
