'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePlan, coverageRange, coversTargetMonth } = require('../src/prepaid');
const { parseDate, formatMonth, parseMonth } = require('../src/dates');

test('parsePlan recognizes "Prepaid: 2 months"', () => {
  const p = parsePlan('Prepaid: 2 months');
  assert.equal(p.isPrepaid, true);
  assert.equal(p.length, 2);
});

test('parsePlan recognizes "3 Months Prepaid"', () => {
  const p = parsePlan('3 Months Prepaid');
  assert.equal(p.isPrepaid, true);
  assert.equal(p.length, 3);
});

test('parsePlan recognizes "Prepaid 6-month plan"', () => {
  const p = parsePlan('Prepaid 6-month plan');
  assert.equal(p.isPrepaid, true);
  assert.equal(p.length, 6);
});

test('parsePlan recognizes "12 month prepaid"', () => {
  const p = parsePlan('12 month prepaid');
  assert.equal(p.isPrepaid, true);
  assert.equal(p.length, 12);
});

test('parsePlan: unsupported length returns isPrepaid true, length null', () => {
  const p = parsePlan('Prepaid: 5 months');
  assert.equal(p.isPrepaid, true);
  assert.equal(p.length, null);
});

test('parsePlan: recurring plan returns isPrepaid false', () => {
  const p = parsePlan('Monthly');
  assert.equal(p.isPrepaid, false);
});

test('parsePlan: "12 month commitment" recurring plan is NOT flagged as prepaid', () => {
  const p = parsePlan('12 month commitment, billed monthly');
  assert.equal(p.isPrepaid, false);
  assert.equal(p.length, null);
});

test('parsePlan: "2 month minimum recurring" is NOT prepaid', () => {
  const p = parsePlan('2 month minimum recurring');
  assert.equal(p.isPrepaid, false);
});

test('parsePlan: explicit prepaid phrasing wins even when amongst extra words', () => {
  const p = parsePlan('UCS Prepaid 6-month plan (Local Delivery)');
  assert.equal(p.isPrepaid, true);
  assert.equal(p.length, 6);
});

test('coverageRange: 3-month plan bought May 10 covers June, July, August', () => {
  // May 10 is past May's gray zone but before June's gray zone -> first
  // box = June -> 3-month coverage = June + July + August.
  const r = coverageRange(parseDate('2026-05-10'), 3);
  assert.equal(formatMonth(r.first), '2026-06');
  assert.equal(formatMonth(r.last), '2026-08');
});

test('coverageRange: 3-month plan bought May 26 covers July, August, September', () => {
  // May 26 falls in June's gray-zone window -> first box defaults to
  // July -> coverage = July + August + September.
  const r = coverageRange(parseDate('2026-05-26'), 3);
  assert.equal(formatMonth(r.first), '2026-07');
  assert.equal(formatMonth(r.last), '2026-09');
});

test('coversTargetMonth: 12-month plan bought Jan 5 covers December (gray zone shifts start to Feb)', () => {
  // Jan 5 in Jan gray-zone window -> first box = Feb -> 12-month
  // coverage = Feb 2026 - Jan 2027. December 2026 IS in that range.
  const ok = coversTargetMonth({
    purchaseDate: '2026-01-05',
    planLength: 12,
    targetMonth: parseMonth('2026-12'),
  });
  assert.equal(ok, true);
});

test('coversTargetMonth: 2-month plan bought May 10 does NOT cover August', () => {
  // first box = June -> covers June + July only.
  const ok = coversTargetMonth({
    purchaseDate: '2026-05-10',
    planLength: 2,
    targetMonth: parseMonth('2026-08'),
  });
  assert.equal(ok, false);
});
