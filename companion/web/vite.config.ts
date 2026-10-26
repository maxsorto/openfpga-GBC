import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies /api to the Hono backend on :4390.
// The production build is served by the backend from web/dist.
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:4390';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true, ws: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
