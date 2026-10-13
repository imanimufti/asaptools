import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

// Guest links carry a random token. Lookups use its HMAC, so a database leak doesn't leak
// working links by itself; an encrypted copy lets ASAP show or email a link again.
function secret() {
  const s = process.env.TOKEN_SIGNING_SECRET;
  if (s) return s;
  if (process.env.NETLIFY || process.env.NODE_ENV === 'production') {
    throw new Error('TOKEN_SIGNING_SECRET is not set');
  }
  return 'local-dev-only-secret';
}

export const newToken = () => randomBytes(24).toString('base64url');
export const hashToken = (token) => createHmac('sha256', secret()).update(String(token)).digest('hex');

const key = () => createHash('sha256').update(`asap-token-enc:${secret()}`).digest();

export function encryptToken(token) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(token), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

export function decryptToken(enc) {
  if (!enc) return null;
  try {
    const buf = Buffer.from(enc, 'base64url');
    const d = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
