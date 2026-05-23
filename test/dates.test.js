'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDate,
  formatDate,
  formatMonth,
  parseMonth,
  addMonths,
  computeCycle,
  computeCycleFromTarget,
  prepaidFirstBoxMonth,
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

test('prepaidFirstBoxMonth: 26th-end advances; 1st-24th stays', () => {
  assert.equal(formatMonth(prepaidFirstBoxMonth('2026-05-09')), '2026-05');
  assert.equal(formatMonth(prepaidFirstBoxMonth('2026-05-24')), '2026-05');
  // The spec says "between the 26th and the 24th maps to next month's box".
  // Our boundary: day >= 25 advances. This matches the spec example that
  // someone signing up on the 25th has paid for the upcoming billing's box.
  assert.equal(formatMonth(prepaidFirstBoxMonth('2026-05-25')), '2026-06');
  assert.equal(formatMonth(prepaidFirstBoxMonth('2026-05-26')), '2026-06');
  assert.equal(formatMonth(prepaidFirstBoxMonth('2026-05-31')), '2026-06');
});
