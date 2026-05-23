'use strict';

// Prepaid plan parsing and coverage logic.
//
// Plan length is extracted from the plan name. Supported lengths: 2, 3, 4, 6, 12 months.
// Examples we should recognize:
//   "Prepaid: 2 months"
//   "3 Months Prepaid"
//   "Prepaid 6-month plan"
//   "12 month prepaid"
//   "Prepaid: 4 months (Local Delivery)"
//
// A prepaid subscription with first_box_month F and length L months covers
// box months F, F+1, ..., F+(L-1).

const { parseDate, firstOfMonth, addMonths, prepaidFirstBoxMonth, formatMonth, parseMonth } = require('./dates');

const ALLOWED_LENGTHS = new Set([2, 3, 4, 6, 12]);

/**
 * Try to parse a prepaid plan length from a plan name.
 * Returns { isPrepaid, length, raw } where length is null if undeterminable.
 */
function parsePlan(planName) {
  if (!planName || typeof planName !== 'string') {
    return { isPrepaid: false, length: null, raw: planName || '' };
  }
  const name = planName.trim();
  const lower = name.toLowerCase();
  // Require an explicit prepaid signal. We deliberately do NOT treat a bare
  // "<N> month" string as prepaid — a plan literally named "12 month
  // commitment, billed monthly" is recurring, not prepaid, and miscategorizing
  // it would mis-count boxes for an entire year.
  const isPrepaid = /\b(prepaid|prepay|pre-paid)\b/.test(lower);
  if (!isPrepaid) return { isPrepaid: false, length: null, raw: name };

  // Find a "<N> month(s)" or "<N>-month" token to extract the term length.
  const m = lower.match(/(\d{1,2})\s*[-]?\s*month/);
  if (m) {
    const n = Number(m[1]);
    if (ALLOWED_LENGTHS.has(n)) return { isPrepaid: true, length: n, raw: name };
    return { isPrepaid: true, length: null, raw: name };
  }
  return { isPrepaid: true, length: null, raw: name };
}

/** True if a plan name indicates a prepaid (non-recurring) plan. */
function isPrepaidPlan(planName) {
  return parsePlan(planName).isPrepaid;
}

/**
 * Returns the [first, last] box-month dates (UTC, 1st of month) that a
 * prepaid subscription covers, given purchase date and plan length.
 */
function coverageRange(purchaseDate, planLength) {
  if (!ALLOWED_LENGTHS.has(planLength)) {
    throw new Error(`Unsupported prepaid plan length: ${planLength}`);
  }
  const first = prepaidFirstBoxMonth(purchaseDate);
  const last = addMonths(first, planLength - 1);
  return { first: firstOfMonth(first), last: firstOfMonth(last) };
}

/**
 * Returns true if a prepaid subscription covers the given target box month.
 *
 * @param {Object} args
 * @param {string|Date} args.purchaseDate
 * @param {number} args.planLength - 2, 3, 4, 6, or 12.
 * @param {Date} args.targetMonth - UTC date on the 1st of the target month.
 */
function coversTargetMonth({ purchaseDate, planLength, targetMonth }) {
  if (!purchaseDate || !ALLOWED_LENGTHS.has(planLength)) return false;
  const tm = (targetMonth instanceof Date) ? firstOfMonth(targetMonth) : parseMonth(targetMonth);
  const { first, last } = coverageRange(parseDate(purchaseDate), planLength);
  return tm.getTime() >= first.getTime() && tm.getTime() <= last.getTime();
}

module.exports = {
  ALLOWED_LENGTHS,
  parsePlan,
  isPrepaidPlan,
  coverageRange,
  coversTargetMonth,
  formatMonth, // re-export for convenience in reports
};
