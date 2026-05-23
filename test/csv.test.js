'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseObjects, stringifyObjects, parseRows } = require('../src/csv');

test('parseObjects strips BOM and parses quoted fields', () => {
  const text = '﻿name,note\r\nAlice,"Hello, world"\r\nBob,"Quote: ""hi"""\r\n';
  const rows = parseObjects(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Alice');
  assert.equal(rows[0].note, 'Hello, world');
  assert.equal(rows[1].note, 'Quote: "hi"');
});

test('parseRows handles CRLF and LF terminators', () => {
  const lf = parseRows('a,b\n1,2\n3,4');
  assert.deepEqual(lf, [['a', 'b'], ['1', '2'], ['3', '4']]);
});

test('stringifyObjects quotes commas and newlines', () => {
  const out = stringifyObjects([{ a: 'hello, world', b: 'line\nbreak' }], ['a', 'b'], { bom: false });
  assert.match(out, /"hello, world"/);
  assert.match(out, /"line\nbreak"/);
});

test('stringifyObjects normalizes smart quotes to ASCII', () => {
  const out = stringifyObjects([{ a: 'it’s', b: '“hi”' }], ['a', 'b'], { bom: false });
  assert.match(out, /it's/);
  assert.match(out, /"""hi"""|"\\"hi\\""|"\""hi""/);
});
