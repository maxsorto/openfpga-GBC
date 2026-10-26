/** Menu order on the Pocket and in the v6 pack. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuOrder } from '../src/pack.js';

const g = (title: string, favorite = false, crc = title.slice(0, 8).padEnd(8, '0')) => ({ title, file: `${title}.gb`, crc, favorite });

test('favorites A to Z first, then everything else A to Z', () => {
  const games = [g('Zelda'), g('alleyway'), g('Tetris', true), g('Metroid II'), g('Balloon Kid', true)];
  assert.deepEqual(
    menuOrder(games).map((x) => x.title),
    ['Balloon Kid', 'Tetris', 'alleyway', 'Metroid II', 'Zelda'],
  );
});

test('played games come first, most recent first, even when they are favorites', () => {
  const games = [g('Zelda', false, 'AAAAAAAA'), g('Tetris', true, 'BBBBBBBB'), g('Alleyway', false, 'CCCCCCCC'), g('Mole Mania', true, 'DDDDDDDD')];
  const played = new Map([
    ['AAAAAAAA', 1000],
    ['BBBBBBBB', 3000],
  ]);
  assert.deepEqual(
    menuOrder(games, played).map((x) => x.title),
    ['Tetris', 'Zelda', 'Mole Mania', 'Alleyway'],
  );
});
