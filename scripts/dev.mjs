// Local dev: Vite serves the app, /api/* goes to the same handler Netlify runs.
import http from 'node:http';
import { createServer } from 'vite';
import { handle } from '../lib/api.js';

const port = Number(process.env.PORT || 8888);
const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });

http.createServer(async (req, res) => {
  if (!req.url.startsWith('/api/')) return vite.middlewares(req, res);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await handle(new Request(`http://localhost:${port}${req.url}`, {
    method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
  }));
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log(`ASAP dev server: http://localhost:${port}`));
