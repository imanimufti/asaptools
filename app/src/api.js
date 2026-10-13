async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body && JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error('Can’t reach ASAP. Check your connection.'), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

export const api = {
  createMeeting: (body) => req('POST', '/api/meetings', { body }),
  meeting: (token) => req('GET', '/api/meeting', { token }),
  savePaints: (token, paints, tz) => req('POST', '/api/paints', { token, body: { paints, tz } }),
  compute: (token) => req('POST', '/api/compute', { token }),
  lock: (token, proposalId) => req('POST', '/api/lock', { token, body: { proposal_id: proposalId } }),
  link: (token, participantId, rotate = false) => req('POST', `/api/participants/${participantId}/link`, { token, body: { rotate } }),
  addPerson: (token, person) => req('POST', '/api/participants', { token, body: person }),
  decline: (token) => req('POST', '/api/decline', { token }),
  repair: (token, action) => req('POST', '/api/repair', { token, body: { action } }),
  flex: (token, participantId) => req('POST', '/api/flex', { token, body: { participant_id: participantId } }),
  answerFlex: (token, answer) => req('POST', '/api/flex/answer', { token, body: { answer } }),
  widen: (token) => req('POST', '/api/widen', { token }),
  drop: (token, participantId, target) => req('POST', '/api/graph/drop', { token, body: { participant_id: participantId, target } }),
};
