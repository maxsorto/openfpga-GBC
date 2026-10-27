/** All routes. index.ts serves them; tests call app.fetch directly. */
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE_DIR, DATA_DIR, ensureDirs } from './config.js';
import { artStatus, fittedPreview, saveCustomArt, warmArt, type ArtWarmItem } from './art.js';
import { isArtRef, markMigrationsSeen, updateChoices, type ArtRef, type ChoicePatch } from './choices.js';
import { smallJpeg } from './image.js';
import { buildLibrary } from './library.js';
import { search } from './match.js';
import { run } from './proc.js';
import { getJob, startSync, type SyncEvent } from './sync.js';
import { makePlan } from './plan.js';
import { loadSettings, saveSettings } from './settings.js';
import { getBoxart, loadThumbs, REPOS } from './thumbs.js';
import { ejectVolume, listVolumes } from './volumes.js';
import { loadDats } from './dat.js';

ensureDirs();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.resolve(__dirname, '../../web/dist');
const isProd = process.env.NODE_ENV === 'production';

export const app = new Hono();

function fail(c: Context, e: unknown, status: 400 | 404 | 500 = 400) {
  return c.json({ error: (e as Error)?.message ?? String(e) }, status);
}

app.get('/api/health', (c) => c.json({ ok: true, dataDir: DATA_DIR, cacheDir: CACHE_DIR }));

app.get('/api/volumes', async (c) => c.json({ volumes: await listVolumes() }));

app.get('/api/settings', (c) => c.json(loadSettings()));

app.post('/api/settings', async (c) => {
  try {
    const body = await c.req.json<{ libraryRoot?: string | null }>();
    return c.json(saveSettings({ libraryRoot: body.libraryRoot ? String(body.libraryRoot) : null }));
  } catch (e) {
    return fail(c, e);
  }
});

/** The library (the Mac folder from settings, or the card's ROMs) and what is on the card. */
app.get('/api/library', async (c) => {
  const card = c.req.query('card') || null;
  const library = loadSettings().libraryRoot;
  if (!card && !library) return fail(c, 'Choose a library folder or a card');
  try {
    return c.json(await buildLibrary({ library, card }));
  } catch (e) {
    return fail(c, e);
  }
});

/** Fetch and fit the grid art for many games, a few at a time, in the background. */
app.post('/api/art/warm', async (c) => {
  const body = await c.req.json<{ items?: ArtWarmItem[] }>();
  const items = (Array.isArray(body?.items) ? body.items : [])
    .filter((it) => it && typeof it.title === 'string' && (it.ref === null || isArtRef(it.ref)))
    .slice(0, 20000);
  return c.json(warmArt(items));
});

app.get('/api/art/status', (c) => c.json(artStatus()));

app.get('/api/plan', async (c) => {
  const card = c.req.query('card');
  if (!card) return fail(c, 'Missing card');
  try {
    const { plan } = await makePlan({ library: loadSettings().libraryRoot, card });
    return c.json(plan);
  } catch (e) {
    return fail(c, e);
  }
});

/** Download the DATs and thumbnail lists again. */
app.post('/api/refresh-databases', async (c) => {
  const [d, t] = await Promise.all([loadDats(true), loadThumbs(true)]);
  return c.json({ dats: d.sources, thumbs: t.sources });
});

/** The app showed these "new dump, kept your star" notes. */
app.post('/api/migrations/seen', async (c) => {
  const body = await c.req.json<{ ids?: string[] }>().catch(() => ({ ids: [] as string[] }));
  markMigrationsSeen(Array.isArray(body?.ids) ? body.ids.filter((x) => typeof x === 'string') : []);
  return c.json({ ok: true });
});

app.post('/api/choices', async (c) => {
  try {
    const body = await c.req.json<{ patches: Record<string, ChoicePatch> }>();
    updateChoices(body.patches ?? {});
    return c.json({ ok: true });
  } catch (e) {
    return fail(c, e);
  }
});

app.get('/api/candidates', async (c) => {
  const q = c.req.query('q') ?? '';
  const system = c.req.query('system') === 'gb' ? 'gb' : 'gbc';
  const index = await loadThumbs();
  const results = search(index, q, system, 60).map((r) => ({
    repo: r.thumb.repo,
    name: r.thumb.name,
    label: REPOS.find((x) => x.repo === r.thumb.repo)?.label ?? '',
    score: Math.round(r.score * 100) / 100,
  }));
  return c.json({ results });
});

app.get('/api/boxart', async (c) => {
  const repo = c.req.query('repo') ?? '';
  const name = c.req.query('name') ?? '';
  const w = Number(c.req.query('w'));
  try {
    const png = await getBoxart(repo, name);
    if (w > 0) {
      return new Response(new Uint8Array(await smallJpeg(png, Math.min(512, Math.max(32, w)))), {
        headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=604800' },
      });
    }
    return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' } });
  } catch (e) {
    return fail(c, e, 404);
  }
});

/** The fitted preview, in the colors the Pocket shows. ref is JSON (an ArtRef) or empty for a title card. */
app.get('/api/fitted', async (c) => {
  const size = c.req.query('size') === '80' ? 80 : 128;
  const title = c.req.query('title') ?? '';
  let ref: ArtRef | null = null;
  const raw = c.req.query('ref');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && !isArtRef(parsed)) return fail(c, 'Bad art reference');
      ref = parsed;
    } catch {
      return fail(c, 'Bad art reference');
    }
  }
  try {
    const png = await fittedPreview(ref, title, size);
    return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' } });
  } catch (e) {
    return fail(c, e, 404);
  }
});

app.post('/api/custom-art', async (c) => {
  const crc = c.req.query('crc') ?? '';
  if (!/^[0-9A-F]{8}$/.test(crc)) return fail(c, 'Bad CRC');
  const buf = Buffer.from(await c.req.arrayBuffer());
  if (!buf.length) return fail(c, 'Empty file');
  if (buf.length > 30 * 1024 * 1024) return fail(c, 'File is too large');
  try {
    const ref = await saveCustomArt(crc, buf, c.req.header('content-type') ?? '');
    return c.json({ ref });
  } catch (e) {
    return fail(c, `Could not read that image: ${(e as Error)?.message ?? e}`);
  }
});

/** Native macOS folder picker. */
app.post('/api/choose-folder', async (c) => {
  const body = await c.req.json<{ purpose?: string }>().catch(() => ({ purpose: undefined }));
  const prompt = body?.purpose === 'library' ? 'Choose the folder with your ROMs' : 'Choose your Pocket SD card or a test folder';
  const res = await run('osascript', ['-e', `POSIX path of (choose folder with prompt "${prompt}")`]);
  if (res.code !== 0) return c.json({ cancelled: true });
  return c.json({ path: res.stdout.trim().replace(/\/$/, '') || '/' });
});

app.post('/api/sync', async (c) => {
  const body = await c.req.json<{ card?: string; signature?: string }>();
  if (!body?.card) return fail(c, 'Missing card');
  try {
    return c.json({ jobId: startSync({ library: loadSettings().libraryRoot, card: body.card, signature: body.signature }).id });
  } catch (e) {
    return fail(c, e);
  }
});

app.get('/api/sync/:id/stream', (c) => {
  const job = getJob(c.req.param('id'));
  if (!job) return fail(c, 'Unknown job', 404);
  return streamSSE(c, async (stream) => {
    const sent = new Set<SyncEvent>();
    for (const e of job.events) {
      sent.add(e);
      await stream.writeSSE({ event: 'msg', data: JSON.stringify(e) });
    }
    if (job.status !== 'running') {
      await stream.writeSSE({ event: 'end', data: '{}' });
      return;
    }
    await new Promise<void>((resolve) => {
      const on = async (e: SyncEvent) => {
        if (sent.has(e)) return;
        await stream.writeSSE({ event: 'msg', data: JSON.stringify(e) });
        if (e.type === 'done' || e.type === 'error') {
          job.emitter.off('event', on);
          await stream.writeSSE({ event: 'end', data: '{}' });
          resolve();
        }
      };
      job.emitter.on('event', on);
    });
  });
});

app.post('/api/eject', async (c) => {
  const body = await c.req.json<{ mountPath?: string }>();
  if (!body?.mountPath) return fail(c, 'Missing mountPath');
  return c.json(await ejectVolume(body.mountPath));
});

// Static frontend in production, with an SPA fallback.
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

if (isProd && fs.existsSync(WEB_DIST)) {
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) return c.notFound();
    const rel = decodeURIComponent(c.req.path.replace(/^\/+/, '')) || 'index.html';
    const file = path.resolve(WEB_DIST, rel);
    if (file.startsWith(WEB_DIST + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return new Response(fs.readFileSync(file), {
        headers: { 'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream' },
      });
    }
    return c.html(fs.readFileSync(path.join(WEB_DIST, 'index.html'), 'utf8'));
  });
}

