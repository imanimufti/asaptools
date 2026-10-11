// Human time labels, shared by the browser and emails.

export function formatSlot(iso, tz, durationMin) {
  const start = new Date(iso), end = new Date(Date.parse(iso) + durationMin * 60000);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(start);
  const t = (d) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
  return `${day} · ${t(start)}–${t(end)}`;
}

export function shortSlot(iso, tz) {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d).replace(':00', '');
  return `${day} ${time}`;
}
