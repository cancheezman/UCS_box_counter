'use strict';

// Date / cycle logic for UCS billing.
//
// Rules (from the build spec):
// - Recurring UCS billing happens on the 25th of each month.
// - A recurring charge on the 25th pays for the FOLLOWING month's box.
// - A new UCS subscription purchase between the 26th of the previous month
//   and the 24th of the current month already paid for that current month's
//   "upcoming box" at signup; they should NOT also be billed on the 25th.
//
// All dates here are handled as UTC calendar dates. We deliberately avoid
// Date timezone math beyond UTC parts so that "the 25th" means the calendar
// 25th regardless of where the agent is run.

/**
 * Parse a YYYY-MM-DD or ISO date string into a UTC Date at 00:00:00.
 * Throws on invalid input.
 */
function parseDate(input) {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) throw new Error(`Invalid date: ${input}`);
    return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  }
  if (typeof input !== 'string') {
    throw new Error(`Cannot parse date from ${typeof input}: ${input}`);
  }
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Empty date string');
  // Accept YYYY-MM-DD, YYYY/MM/DD, MM/DD/YYYY, and ISO timestamps.
  let y;
  let m;
  let d;
  let match;
  if ((match = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/))) {
    y = Number(match[1]);
    m = Number(match[2]);
    d = Number(match[3]);
  } else if ((match = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/))) {
    m = Number(match[1]);
    d = Number(match[2]);
    y = Number(match[3]);
  } else {
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${trimmed}`);
    return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) throw new Error(`Invalid date: ${trimmed}`);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Format a Date as YYYY-MM-DD (UTC). */
function formatDate(date) {
  if (!(date instanceof Date)) return '';
  if (Number.isNaN(date.getTime())) return '';
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Format a Date as a "box month" key YYYY-MM (UTC). */
function formatMonth(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Parse a YYYY-MM string into a UTC Date on the 1st. */
function parseMonth(input) {
  if (typeof input !== 'string') throw new Error(`Invalid month: ${input}`);
  const match = input.trim().match(/^(\d{4})-(\d{1,2})$/);
  if (!match) throw new Error(`Invalid YYYY-MM month: ${input}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  if (m < 1 || m > 12) throw new Error(`Invalid month: ${input}`);
  return new Date(Date.UTC(y, m - 1, 1));
}

/** Add a (signed) integer number of days to a UTC date. */
function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Add a (signed) integer number of months to a UTC date, preserving day-of-month when possible. */
function addMonths(date, months) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  // Use Date.UTC with a normalized day so we don't roll into the wrong month
  // (e.g. Jan 31 + 1 month -> Feb 28).
  const target = new Date(Date.UTC(y, m + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target;
}

/** Return a UTC Date at the first of the given month/year. */
function firstOfMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/**
 * Compute cycle dates for a given run date.
 *
 * Target box month is the month AFTER the most recent (or current) 25th billing cycle.
 *   - If run date is on or before the 25th of month X, billing cycle is X-25, target = X+1.
 *   - If run date is after the 25th of month X, billing cycle is X-25, target = X+1.
 *   - The 26th of month X also maps to billing X-25, target X+1 (per spec example: May 26 -> June).
 *
 * Examples from the spec:
 *   May 9   -> billing May 25 -> June
 *   May 26  -> billing May 25 -> June
 *   June 9  -> billing June 25 (upcoming) -> July
 *   June 26 -> billing June 25 (just past) -> July
 *
 * So the rule is: billing_cycle_date = the 25th of the run-date month, and
 * target box month = month after that. (For dates on/before the 25th, the
 * 25th is the upcoming billing; for dates from 26th on, it's the most recent
 * billing; either way the target is the next calendar month.)
 *
 * Returns:
 *   {
 *     runDate, targetMonth, targetMonthKey,
 *     billingCycleDate,
 *     newOrderWindowStart, newOrderWindowEnd,
 *   }
 */
function computeCycle(runDate) {
  const run = parseDate(runDate);
  // Billing cycle: 25th of run-date's month.
  const billingCycleDate = new Date(Date.UTC(run.getUTCFullYear(), run.getUTCMonth(), 25));
  // Target month: the month AFTER the billing cycle.
  const targetMonth = firstOfMonth(addMonths(billingCycleDate, 1));
  // New-order window: 26th of two months before target through 24th of month before target.
  // Equivalently: 26th of (target - 2) through 24th of (target - 1).
  const newOrderWindowStart = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() - 2, 26));
  const newOrderWindowEnd = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() - 1, 24));
  return {
    runDate: run,
    targetMonth,
    targetMonthKey: formatMonth(targetMonth),
    billingCycleDate,
    newOrderWindowStart,
    newOrderWindowEnd,
  };
}

/**
 * Compute cycle dates from an explicit target month (YYYY-MM).
 * The billing cycle date is then the 25th of the month before the target.
 */
function computeCycleFromTarget(targetMonthStr) {
  const targetMonth = parseMonth(targetMonthStr);
  const billingCycleDate = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() - 1, 25));
  const newOrderWindowStart = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() - 2, 26));
  const newOrderWindowEnd = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() - 1, 24));
  return {
    runDate: null,
    targetMonth,
    targetMonthKey: formatMonth(targetMonth),
    billingCycleDate,
    newOrderWindowStart,
    newOrderWindowEnd,
  };
}

/**
 * Default live-ingestion date window for a given cycle.
 *
 *   since = start of the new-order window (26th of M-2)
 *   until = billing_cycle_date + 1 day (so Shopify's `created_at:<=YYYY-MM-DD`
 *           inclusive filter actually covers the entire 25th plus any
 *           midnight spillover into the 26th)
 *
 * Returns plain YYYY-MM-DD strings so the result is ready to drop into a
 * Shopify search query.
 */
function defaultLiveIngestionWindow(cycle) {
  return {
    since: formatDate(cycle.newOrderWindowStart),
    until: formatDate(addDays(cycle.billingCycleDate, 1)),
  };
}

/** True if a is the same calendar day as b (UTC). */
function sameDay(a, b) {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/** True if dt is in [start, end] inclusive (UTC date comparison). */
function inRangeInclusive(dt, start, end) {
  return dt.getTime() >= start.getTime() && dt.getTime() <= end.getTime();
}

/**
 * Given a purchase date, return the "first box month" that prepaid purchase covers.
 * Per spec: purchase between the 26th and the 24th maps to the next month's box.
 *   - Purchases on 25th-end of month X -> first box month X+1
 *   - Purchases on 1st-24th of month X -> first box month X (they bought during
 *     the new-order window for X's box).
 *
 * Equivalently: purchases on day >= 25 advance to the next month.
 */
function prepaidFirstBoxMonth(purchaseDate) {
  const pd = parseDate(purchaseDate);
  const day = pd.getUTCDate();
  if (day >= 25) {
    return firstOfMonth(addMonths(pd, 1));
  }
  return firstOfMonth(pd);
}

module.exports = {
  parseDate,
  formatDate,
  parseMonth,
  formatMonth,
  addDays,
  addMonths,
  firstOfMonth,
  computeCycle,
  computeCycleFromTarget,
  sameDay,
  inRangeInclusive,
  prepaidFirstBoxMonth,
  defaultLiveIngestionWindow,
};
