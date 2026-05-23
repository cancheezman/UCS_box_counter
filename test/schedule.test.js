'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEDULE,
  firstPickupForMonth,
  grayZoneWindow,
  fallbackGrayZoneEnd,
} = require('../src/schedule');
const { formatDate } = require('../src/dates');

test('schedule contains all 12 months of 2026', () => {
  for (let m = 1; m <= 12; m += 1) {
    const key = `2026-${String(m).padStart(2, '0')}`;
    assert.ok(SCHEDULE[key], `missing schedule entry for ${key}`);
  }
});

test('firstPickupForMonth returns September 3 for Sept 2026', () => {
  const d = firstPickupForMonth('2026-09');
  assert.equal(formatDate(d), '2026-09-03');
});

test('firstPickupForMonth returns October 1 for Oct 2026', () => {
  const d = firstPickupForMonth('2026-10');
  assert.equal(formatDate(d), '2026-10-01');
});

test('grayZoneWindow for September 2026 = [Aug 25, Sept 3]', () => {
  const w = grayZoneWindow('2026-09');
  assert.equal(formatDate(w.start), '2026-08-25');
  assert.equal(formatDate(w.end), '2026-09-03');
  assert.equal(w.source, 'schedule');
});

test('grayZoneWindow for an out-of-table month falls back to day 5 of the box month', () => {
  const w = grayZoneWindow('2027-03');
  assert.equal(formatDate(w.start), '2027-02-25');
  assert.equal(formatDate(w.end), '2027-03-05');
  assert.equal(w.source, 'fallback');
});

test('fallbackGrayZoneEnd uses 5th of the box month', () => {
  const d = fallbackGrayZoneEnd('2027-03');
  assert.equal(formatDate(d), '2027-03-05');
});
