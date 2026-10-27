/** Starts the app on 127.0.0.1. The routes are in app.ts. */
import { serve } from '@hono/node-server';
import { PORT } from './config.js';
import { app } from './app.js';

const isProd = process.env.NODE_ENV === 'production';

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
  const url = `http://localhost:${info.port}`;
  console.log(`\n  GBC Cover Companion is running at ${url}`);
  if (isProd && !process.env.NO_OPEN) {
    import('node:child_process').then(({ spawn }) => spawn('open', [url], { stdio: 'ignore', detached: true }).unref());
  } else if (!isProd) {
    console.log('  (dev) The UI runs on http://localhost:5174\n');
  }
});
