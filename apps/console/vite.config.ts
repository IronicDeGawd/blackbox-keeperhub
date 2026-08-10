import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The console talks to the API over the network, not through a bundler alias —
 * the same build runs against the mock on 4001 and the real server on 4000.
 * `VITE_API_URL` picks which, and defaults to the mock so a fresh clone shows
 * something without a chain, a database, or a key.
 */
export default defineConfig({
  plugins: [react()],
  server: { port: 4100 },
  build: { target: 'es2022', sourcemap: true },
});
