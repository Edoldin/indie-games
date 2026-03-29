/**
 * Unit tests for js/utils.js
 * Pure functions only — no Firebase, no DOM.
 * Run: node --test tests/utils.test.js
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('vm');
const fs     = require('fs');
const path   = require('path');

// Load all utils.js function declarations into the global scope.
// Function declarations (function foo(){}) become globals via vm.runInThisContext.
vm.runInThisContext(
  fs.readFileSync(path.join(__dirname, '../js/utils.js'), 'utf8')
);

// ── generateRoomCode ──────────────────────────────────────

describe('generateRoomCode', () => {
  const VALID = new Set('ABCDEFGHJKLMNPQRSTUVWXYZ23456789');
  const AMBIGUOUS = /[01OIL]/;

  test('returns a 4-character string', () => {
    assert.strictEqual(typeof generateRoomCode(), 'string');
    assert.strictEqual(generateRoomCode().length, 4);
  });

  test('uses only valid characters (no 0, O, 1, I)', () => {
    // ROOM_CHARS excludes 0/O (look alike) and 1/I (look alike). L is kept.
    const EXCLUDED = /[01OI]/;
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode();
      assert.ok(!EXCLUDED.test(code), `Excluded char in: ${code}`);
      assert.ok([...code].every(c => VALID.has(c)), `Invalid char in: ${code}`);
    }
  });

  test('produces different codes across calls (probabilistic)', () => {
    const codes = new Set(Array.from({ length: 20 }, generateRoomCode));
    assert.ok(codes.size > 1, 'All 20 codes were identical — RNG broken?');
  });
});

// ── shuffle ───────────────────────────────────────────────

describe('shuffle', () => {
  test('returns a new array of the same length', () => {
    const arr = [1, 2, 3, 4, 5];
    const result = shuffle(arr);
    assert.notStrictEqual(result, arr);
    assert.strictEqual(result.length, arr.length);
  });

  test('contains every original element exactly once', () => {
    const arr = [1, 2, 3, 4, 5];
    const result = shuffle(arr);
    assert.deepStrictEqual(
      [...result].sort((a, b) => a - b),
      [...arr].sort((a, b) => a - b)
    );
  });

  test('does not mutate the input', () => {
    const arr = ['a', 'b', 'c'];
    const snapshot = [...arr];
    shuffle(arr);
    assert.deepStrictEqual(arr, snapshot);
  });

  test('handles empty and single-element arrays', () => {
    assert.deepStrictEqual(shuffle([]), []);
    assert.deepStrictEqual(shuffle([42]), [42]);
  });
});

// ── opposite ─────────────────────────────────────────────

describe('opposite', () => {
  test('red → blue', () => assert.strictEqual(opposite('red'), 'blue'));
  test('blue → red', () => assert.strictEqual(opposite('blue'), 'red'));
});

// ── teamLabel ─────────────────────────────────────────────

describe('teamLabel', () => {
  test('red → RED', () => assert.strictEqual(teamLabel('red'), 'RED'));
  test('blue → BLUE', () => assert.strictEqual(teamLabel('blue'), 'BLUE'));
});

// ── generateKeyCard ───────────────────────────────────────

describe('generateKeyCard', () => {
  function counts(card) {
    return card.reduce((acc, v) => { acc[v] = (acc[v] || 0) + 1; return acc; }, {});
  }

  test('returns exactly 25 entries', () => {
    assert.strictEqual(generateKeyCard('red').length, 25);
    assert.strictEqual(generateKeyCard('blue').length, 25);
  });

  test('red start: 9 red, 8 blue, 7 bystander, 1 assassin', () => {
    const c = counts(generateKeyCard('red'));
    assert.strictEqual(c.red,       9);
    assert.strictEqual(c.blue,      8);
    assert.strictEqual(c.bystander, 7);
    assert.strictEqual(c.assassin,  1);
  });

  test('blue start: 9 blue, 8 red, 7 bystander, 1 assassin', () => {
    const c = counts(generateKeyCard('blue'));
    assert.strictEqual(c.blue,      9);
    assert.strictEqual(c.red,       8);
    assert.strictEqual(c.bystander, 7);
    assert.strictEqual(c.assassin,  1);
  });

  test('is shuffled — not always in the same order (probabilistic)', () => {
    const cards = new Set(
      Array.from({ length: 10 }, () => generateKeyCard('red').join(','))
    );
    assert.ok(cards.size > 1, 'All 10 key cards were identical — shuffle broken?');
  });
});

// ── pickWords ─────────────────────────────────────────────

describe('pickWords', () => {
  const WORD_LIST = Array.from({ length: 400 }, (_, i) => `word${i}`);

  test('returns exactly 25 words', () => {
    assert.strictEqual(pickWords(WORD_LIST).length, 25);
  });

  test('all returned words exist in the source list', () => {
    const set = new Set(WORD_LIST);
    for (const w of pickWords(WORD_LIST)) {
      assert.ok(set.has(w), `"${w}" is not in the word list`);
    }
  });

  test('returns no duplicates', () => {
    const picked = pickWords(WORD_LIST);
    assert.strictEqual(new Set(picked).size, 25);
  });

  test('does not mutate the input list', () => {
    const snapshot = [...WORD_LIST];
    pickWords(WORD_LIST);
    assert.deepStrictEqual(WORD_LIST, snapshot);
  });
});
