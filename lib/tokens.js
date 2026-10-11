import { createHmac, randomBytes } from 'node:crypto';

// Guest links carry a random token; only its HMAC is stored, so a database leak doesn't
// leak working links.
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
