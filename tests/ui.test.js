/**
 * Unit tests for js/ui.js — pure helper functions only.
 * DOM-dependent helpers (showScreen, showLoading, showToast, playerChip)
 * are not tested here; they require a real browser or a DOM emulator.
 * Run: node --test tests/ui.test.js
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('vm');
const fs     = require('fs');
const path   = require('path');

// Minimal stub so ui.js loads without errors in Node.
// The functions under test (esc) don't touch the DOM.
if (typeof global.document === 'undefined') {
  global.document = { getElementById: () => null };
}

vm.runInThisContext(
  fs.readFileSync(path.join(__dirname, '../js/ui.js'), 'utf8')
);

// ── esc ───────────────────────────────────────────────────

describe('esc', () => {
  test('escapes <', () => assert.strictEqual(esc('<'), '&lt;'));
  test('escapes >', () => assert.strictEqual(esc('>'), '&gt;'));
  test('escapes &', () => assert.strictEqual(esc('&'), '&amp;'));
  test('escapes double quotes', () => assert.strictEqual(esc('"'), '&quot;'));

  test('leaves safe strings unchanged', () => {
    assert.strictEqual(esc('hello world'), 'hello world');
    assert.strictEqual(esc('Código Secreto'), 'Código Secreto');
  });

  test('converts numbers and null via String()', () => {
    assert.strictEqual(esc(42),   '42');
    assert.strictEqual(esc(null), 'null');
  });

  test('escapes a full XSS payload', () => {
    assert.strictEqual(
      esc('<script>alert("xss")</script>'),
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  test('escapes multiple instances of the same character', () => {
    assert.strictEqual(esc('a & b & c'), 'a &amp; b &amp; c');
    assert.strictEqual(esc('<<>>'),      '&lt;&lt;&gt;&gt;');
  });

  test('handles empty string', () => {
    assert.strictEqual(esc(''), '');
  });
});
