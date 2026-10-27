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

import { NO_SECTION, compareTitles, letterGroup, letterIndex } from '../src/pack.js';

test('letter groups use the first character of the pack title: # first, then A to Z, any case', () => {
  assert.equal(letterGroup('1942'), 0);
  assert.equal(letterGroup('~Tilde'), 0);
  assert.equal(letterGroup('Éclair'), 0); // written as "?clair" in the pack
  assert.equal(letterGroup(''), 0);
  assert.equal(letterGroup('alleyway'), 1);
  assert.equal(letterGroup('The Legend of Zelda'), 20); // nothing is ignored: it is a T
  assert.equal(letterGroup('zelda'), 26);
  const titles = ['Zelda', 'Éclair', 'alleyway', '~Tilde', 'Asteroids', '1942', 'The Legend of Zelda', '[Bracket]'];
  const sorted = titles.map((t) => ({ title: t, file: `${t}.gb`, crc: '', favorite: false })).sort(compareTitles).map((g) => g.title);
  assert.deepEqual(sorted, ['1942', '[Bracket]', '~Tilde', 'Éclair', 'alleyway', 'Asteroids', 'The Legend of Zelda', 'Zelda']);
});

test('letter index: counts played and favorites, starts after them, 0xFFFF for missing letters', () => {
  const e = (title: string, extra: { favorite?: boolean; played?: boolean } = {}) => ({ title, romFile: `${title}.gb`, platform: 'gbc', romSize: 1, ...extra });
  const games = [
    e('Wario Land', { played: true }),
    e('Tetris', { favorite: true }), // a favorite T: not the start of the T section
    e('Zelda', { favorite: true }),
    e('1942'),
    e('~Odd'),
    e('alleyway'),
    e('Asteroids'),
    e('Tetris DX'),
    e('The Legend of Zelda'),
    e('Yoshi'),
  ];
  const idx = letterIndex(games);
  assert.equal(idx.playedCount, 1);
  assert.equal(idx.favCount, 2);
  assert.equal(idx.starts[0], 3); // '#'
  assert.equal(idx.starts[1], 5); // A
  assert.equal(idx.starts[20], 7); // T, the first T after the favorites
  assert.equal(idx.starts[25], 9); // Y
  assert.equal(idx.starts[26], NO_SECTION); // Z only as a favorite
  for (const l of 'BCDEFGHIJKLMNOPQRSUVWX') assert.equal(idx.starts[l.charCodeAt(0) - 64], NO_SECTION, l);
  // A favorite after the A to Z part has begun is a bug in the order.
  assert.throws(() => letterIndex([e('Asteroids'), e('Tetris', { favorite: true })]), /must come before/);
});
