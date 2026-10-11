import { handle } from '../../lib/api.js';

export default (req) => handle(req);

export const config = { path: '/api/*' };
