// Publishes the PRD pages at /prd alongside the app.
import { cp } from 'node:fs/promises';

await cp(new URL('../prd-site/', import.meta.url), new URL('../app/dist/prd/', import.meta.url), { recursive: true });
console.log('copied prd-site → app/dist/prd');
