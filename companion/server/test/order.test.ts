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

import { NO_SECTION, compareTitles, letterGroup, letterIndex, menuList } from '../src/pack.js';

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

test('letter index: counts the played and favorites sections, starts in the A to Z list, 0xFFFF for missing letters', () => {
  type Sec = 'played' | 'favorite' | 'az';
  const e = (title: string, section: Sec = 'az', favorite = false) => ({ title, romFile: `${title}.gb`, platform: 'gbc', romSize: 1, section, favorite });
  const games = [
    e('Wario Land', 'played'),
    e('Tetris', 'favorite', true),
    e('Zelda', 'favorite', true),
    e('1942'),
    e('~Odd'),
    e('alleyway'),
    e('Asteroids'),
    e('Tetris', 'az', true), // the favorite again, under T
    e('Tetris DX'),
    e('The Legend of Zelda'),
    e('Wario Land'),
    e('Yoshi'),
    e('Zelda', 'az', true),
  ];
  const idx = letterIndex(games);
  assert.equal(idx.playedCount, 1);
  assert.equal(idx.favCount, 2);
  assert.equal(idx.starts[0], 3); // '#'
  assert.equal(idx.starts[1], 5); // A
  assert.equal(idx.starts[20], 7); // T: the favorite's second entry
  assert.equal(idx.starts[23], 10); // W
  assert.equal(idx.starts[25], 11); // Y
  assert.equal(idx.starts[26], 12); // Z
  for (const l of 'BCDEFGHIJKLMNOPQRSUVX') assert.equal(idx.starts[l.charCodeAt(0) - 64], NO_SECTION, l);
  // A top section after the A to Z list has begun is a bug in the order.
  assert.throws(() => letterIndex([e('Asteroids'), e('Tetris', 'favorite', true)]), /must come before/);
});

test('menu list: v6 lists each game once, v7 lists favorites again under their letter', () => {
  const g = (title: string, favorite = false) => ({ title, file: `${title}.gb`, crc: title.padEnd(8, '0').slice(0, 8), favorite });
  const games = [g('Zelda', true), g('Alleyway'), g('Tetris', true), g('Mole Mania')];
  const v6 = menuList(games, new Map(), false);
  assert.deepEqual(v6.map((x) => `${x.section}:${x.game.title}`), ['favorite:Tetris', 'favorite:Zelda', 'az:Alleyway', 'az:Mole Mania']);
  const v7 = menuList(games, new Map(), true);
  assert.deepEqual(v7.map((x) => `${x.section}:${x.game.title}`), [
    'favorite:Tetris',
    'favorite:Zelda',
    'az:Alleyway',
    'az:Mole Mania',
    'az:Tetris',
    'az:Zelda',
  ]);
});
