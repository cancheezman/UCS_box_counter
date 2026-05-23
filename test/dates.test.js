'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDate,
  formatDate,
  formatMonth,
  parseMonth,
  addDays,
  addMonths,
  computeCycle,
  computeCycleFromTarget,
  prepaidFirstBoxMonth,
  defaultLiveIngestionWindow,
} = require('../src/dates');

test('parseDate accepts YYYY-MM-DD and ISO timestamps', () => {
  assert.equal(formatDate(parseDate('2026-05-09')), '2026-05-09');
  assert.equal(formatDate(parseDate('2026-05-09T13:45:00Z')), '2026-05-09');
  assert.equal(formatDate(parseDate('05/26/2026')), '2026-05-26');
});

test('parseMonth round-trips formatMonth', () => {
  const m = parseMonth('2026-06');
  assert.equal(formatMonth(m), '2026-06');
});

test('addMonths preserves day-of-month and clamps to last day when needed', () => {
  assert.equal(formatDate(addMonths(parseDate('2026-01-31'), 1)), '2026-02-28');
  assert.equal(formatDate(addMonths(parseDate('2026-05-25'), 1)), '2026-06-25');
  assert.equal(formatDate(addMonths(parseDate('2026-05-25'), -1)), '2026-04-25');
});

test('computeCycle: May 9 -> billing May 25, target June', () => {
  const cycle = computeCycle('2026-05-09');
  assert.equal(formatDate(cycle.billingCycleDate), '2026-05-25');
  assert.equal(cycle.targetMonthKey, '2026-06');
  assert.equal(formatDate(cycle.newOrderWindowStart), '2026-04-26');
  assert.equal(formatDate(cycle.newOrderWindowEnd), '2026-05-24');
});

test('computeCycle: May 26 -> billing May 25, target June', () => {
  const cycle = computeCycle('2026-05-26');
  assert.equal(formatDate(cycle.billingCycleDate), '2026-05-25');
  assert.equal(cycle.targetMonthKey, '2026-06');
});

test('computeCycle: June 9 -> billing June 25, target July', () => {
  const cycle = computeCycle('2026-06-09');
  assert.equal(formatDate(cycle.billingCycleDate), '2026-06-25');
  assert.equal(cycle.targetMonthKey, '2026-07');
});

test('computeCycle: June 26 -> billing June 25, target July', () => {
  const cycle = computeCycle('2026-06-26');
  assert.equal(formatDate(cycle.billingCycleDate), '2026-06-25');
  assert.equal(cycle.targetMonthKey, '2026-07');
});

test('computeCycleFromTarget: target June -> billing May 25, window Apr 26 - May 24', () => {
  const cycle = computeCycleFromTarget('2026-06');
  assert.equal(formatDate(cycle.billingCycleDate), '2026-05-25');
  assert.equal(formatDate(cycle.newOrderWindowStart), '2026-04-26');
  assert.equal(formatDate(cycle.newOrderWindowEnd), '2026-05-24');
});

test('addDays: simple positive/negative additions cross month boundaries', () => {
  assert.equal(formatDate(addDays(parseDate('2026-05-25'), 1)), '2026-05-26');
  assert.equal(formatDate(addDays(parseDate('2026-05-31'), 1)), '2026-06-01');
  assert.equal(formatDate(addDays(parseDate('2026-03-01'), -1)), '2026-02-28');
  assert.equal(formatDate(addDays(parseDate('2026-05-25'), 0)), '2026-05-25');
});

test('defaultLiveIngestionWindow for target June: until is May 26 (billing + 1), not May 25', () => {
  const cycle = computeCycleFromTarget('2026-06');
  const w = defaultLiveIngestionWindow(cycle);
  assert.equal(w.since, '2026-04-26');
  assert.equal(w.until, '2026-05-26');
  // Sanity: the billing cycle date itself is still the 25th.
  assert.equal(formatDate(cycle.billingCycleDate), '2026-05-25');
});

test('defaultLiveIngestionWindow round-trip matches CLI docs (May 9 -> covers May 25 billing)', () => {
  const cycle = computeCycle('2026-05-09');
  const w = defaultLiveIngestionWindow(cycle);
  // window.until should be >= billing cycle date.
  assert.equal(w.until, '2026-05-26');
  // The 25th billing date is within [since, until).
  assert.equal(formatDate(cycle.billingCycleDate), '2026-05-25');
  assert.ok(w.since <= '2026-05-25' && '2026-05-25' < w.until);
});

test('prepaidFirstBoxMonth: schedule-aware first box month under the gray-zone rule', () => {
  // May 9 -> not in any gray-zone window (gray May = Apr 25-Apr 30, gray
  // June = May 25-Jun 4). day=9 <= 24 -> first box = June.
  assert.equal(formatMonth(prepaidFirstBoxMonth('2026-05-09')), '2026-06');
  // May 24 -> no gray zone; day=24 <= 24 -> first box = June.
  assert.equal(formatMonth(prepaidFirstBoxMonth('2026-05-24')), '2026-06');
  // May 25-31 fall in the gray-zone window for June ([May 25, Jun 4]);
  // they default to July.
  assert.equal(formatMonth(prepaidFirstBoxMonth('2026-05-25')), '2026-07');
  assert.equal(formatMonth(prepaidFirstBoxMonth('2026-05-26')), '2026-07');
  assert.equal(formatMonth(prepaidFirstBoxMonth('2026-05-31')), '2026-07');
  // Spec example: Aug 28 -> gray zone for September -> defaults to October.
  assert.equal(formatMonth(prepaidFirstBoxMonth('2026-08-28')), '2026-10');
});

test('prepaidFirstBoxMonth: order placed AFTER the first pickup is no longer gray-zone', () => {
  // First pickup for June is 2026-06-04. June 5 is past it -> not gray
  // zone -> day=5 <= 24 -> first box = July.
  assert.equal(formatMonth(prepaidFirstBoxMonth('2026-06-05')), '2026-07');
});
