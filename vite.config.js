import { defineConfig } from 'vite';

export default defineConfig({
  root: 'app',
  build: { outDir: 'dist', emptyOutDir: true },
  // the app imports shared code from ../lib
  server: { fs: { allow: ['..'] } },
});
