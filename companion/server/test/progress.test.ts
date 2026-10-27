/**
 * Progress while a slow card works, and no "._" leftovers.
 *
 * A pack-only sync (nothing to copy) must send its phases and byte progress as
 * they happen, not all at the end. The card is made slow with a pause per
 * flushed chunk, and chunks are made small so a small pack spans many of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFakeRom } from './fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '.out', 'progress');
fs.rmSync(OUT, { recursive: true, force: true });
const LIB = path.join(OUT, 'library');
const CARD = path.join(OUT, 'card');
const ROMDIR = path.join(CARD, 'Assets', 'gbc', 'common');

process.env.COMPANION_DATA_DIR = path.join(OUT, 'data');
process.env.COMPANION_CACHE_DIR = path.join(OUT, 'cache');
process.env.COMPANION_OFFLINE = '1';
process.env.COMPANION_TEST_CHUNK_BYTES = String(128 * 1024);
const SLOW = 120;
// The app's own route has no test options, so its slow card comes from here.
process.env.COMPANION_TEST_SLOW_IO_MS = String(SLOW);

const { ensureDirs } = await import('../src/config.js');
ensureDirs();
const { makePlan } = await import('../src/plan.js');
const { runSync } = await import('../src/sync.js');
const { saveSettings } = await import('../src/settings.js');
const { app } = await import('../src/app.js');
type SyncEvent = import('../src/sync.js').SyncEvent;

for (let i = 0; i < 31; i++) writeFakeRom(path.join(LIB, `Game ${String(i).padStart(2, '0')}.gb`), 2048, 70 + i);
fs.mkdirSync(ROMDIR, { recursive: true });
fs.mkdirSync(path.join(CARD, 'Saves', 'gbc', 'common'), { recursive: true });

// First sync copies the ROMs and builds the art cache, quickly.
test('setup: first sync', async () => {
  const { plan } = await makePlan({ library: LIB, card: CARD });
  await runSync({ library: LIB, card: CARD, signature: plan.signature, slowIoMs: 0 });
});

test('a pack-only sync on a slow card reports each phase and its bytes as it goes', async () => {
  // Every ROM is on the card already: only the pack is written.
  fs.rmSync(path.join(ROMDIR, 'covers.bin'));
  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.equal(plan.copy.length, 0);
  const t0 = Date.now();
  const seen: { at: number; e: SyncEvent }[] = [];
  await runSync({ library: LIB, card: CARD, signature: plan.signature, slowIoMs: SLOW }, (e) => seen.push({ at: Date.now() - t0, e }));
  const done = seen.find((x) => x.e.type === 'done')!;
  const phases = seen.filter((x) => x.e.type === 'phase').map((x) => (x.e as { phase: string }).phase);
  assert.deepEqual(phases, ['check', 'pack', 'verify', 'write']);

  const pack = seen.filter((x) => x.e.type === 'bytes' && x.e.phase === 'pack');
  const verify = seen.filter((x) => x.e.type === 'bytes' && x.e.phase === 'verify');
  // About 1.4 MB in 128 KB chunks: many updates, each after a flush.
  assert.ok(pack.length >= 8, `pack updates: ${pack.length}`);
  assert.ok(verify.length >= 8, `verify updates: ${verify.length}`);
  const dones = pack.map((x) => (x.e as { done: number }).done);
  assert.deepEqual(dones, [...dones].sort((a, b) => a - b), 'bytes only go up');
  assert.ok(pack.some((x) => (x.e as { flushing?: boolean }).flushing), 'the final flush is announced');
  // The updates are spread over the run, not bunched at the end.
  assert.ok(pack[1].at < done.at - 8 * SLOW, `first pack update at ${pack[1].at} ms, done at ${done.at} ms`);
  const gaps = pack.slice(1).map((x, i) => x.at - pack[i].at);
  assert.ok(gaps.filter((g) => g >= SLOW * 0.8).length >= 5, `gaps between updates: ${gaps.join(', ')}`);
});

test('through the app: the event stream delivers phases and bytes before done', async () => {
  saveSettings({ libraryRoot: LIB });
  fs.rmSync(path.join(ROMDIR, 'covers.bin'));
  const planRes = await app.fetch(new Request(`http://x/api/plan?card=${encodeURIComponent(CARD)}`));
  const plan = (await planRes.json()) as { signature: string };
  const start = await app.fetch(
    new Request('http://x/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ card: CARD, signature: plan.signature }) }),
  );
  const { jobId } = (await start.json()) as { jobId: string };
  const res = await app.fetch(new Request(`http://x/api/sync/${jobId}/stream`));
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const arrived: { at: number; e: SyncEvent }[] = [];
  const t0 = Date.now();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = block.match(/^event: (.*)$/m)?.[1];
      const data = block.match(/^data: (.*)$/m)?.[1];
      if (ev === 'msg' && data) arrived.push({ at: Date.now() - t0, e: JSON.parse(data) });
    }
  }
  const types = arrived.map((x) => (x.e.type === 'phase' ? `phase:${x.e.phase}` : x.e.type));
  assert.ok(types.indexOf('phase:check') === 0);
  assert.ok(types.includes('phase:pack') && types.includes('phase:verify') && types.includes('phase:write'));
  assert.equal(types[types.length - 1], 'done');
  // Events arrive in more than one batch: the pack phase shows up before the end.
  const packAt = arrived.find((x) => x.e.type === 'phase' && x.e.phase === 'pack')!.at;
  const doneAt = arrived[arrived.length - 1].at;
  const bytesBeforeDone = arrived.filter((x) => x.e.type === 'bytes' && x.at < doneAt).length;
  assert.ok(bytesBeforeDone >= 8, `bytes events before done: ${bytesBeforeDone}`);
  // With a slow card, the pack phase reaches the client long before the end.
  assert.ok(packAt < doneAt - 8 * SLOW, `pack phase arrived at ${packAt} ms, done at ${doneAt} ms`);
});

test('no "._" leftovers from files the app renamed or removed; other "._" files stay', async () => {
  // macOS writes these on exFAT. Make the ones a sync would leave, plus some that are not ours.
  const ours = ['._.covers.bin.part', '._.cover-picker.json.part', '._.Game 05.gb.part', '._Game 30.gb'];
  const notOurs = ['._Handmade.gb', '._covers.bin', '._Game 01.gb'];
  for (const f of [...ours, ...notOurs]) fs.writeFileSync(path.join(ROMDIR, f), 'AppleDouble');
  // Game 30 leaves the library, so its ROM is removed; Game 05 changes, so it is copied again.
  fs.rmSync(path.join(LIB, 'Game 30.gb'));
  writeFakeRom(path.join(LIB, 'Game 05.gb'), 2048, 4242);
  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.deepEqual(plan.remove.map((r) => r.file), ['Game 30.gb']);
  assert.deepEqual(plan.copy.map((c) => c.file), ['Game 05.gb']);
  await runSync({ library: LIB, card: CARD, signature: plan.signature, slowIoMs: 0 });
  const left = fs.readdirSync(ROMDIR).filter((f) => f.startsWith('._'));
  assert.deepEqual(left.sort(), [...notOurs].sort());
  assert.ok(!fs.readdirSync(ROMDIR).some((f) => f.endsWith('.part')));
});
