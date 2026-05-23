'use strict';

// UCS pickup / delivery schedule data.
//
// For each box month, the schedule records the earliest pickup or
// delivery date for that month's box. This is used by the gray-zone
// rule: an order placed from the 25th of M-1 through the earliest
// pickup/delivery date for M is "late" — the pack may already be
// committed when the order comes in, so we default to the NEXT box
// month and surface the order for case-by-case review.
//
// Data source: TOMME 2026 UCS schedule (Plate of the Union blog).
//
// Schedule entries are absolute dates and intentionally hard-coded
// rather than computed; this module is the single source of truth that
// tests and runtime logic share.

const { parseDate, formatMonth, firstOfMonth, addMonths, parseMonth } = require('./dates');

// Map of YYYY-MM box month -> earliest pickup/delivery date (YYYY-MM-DD).
const SCHEDULE = {
  '2026-01': '2026-01-07',
  '2026-02': '2026-02-05',
  '2026-03': '2026-03-05',
  '2026-04': '2026-04-02',
  '2026-05': '2026-04-30',
  '2026-06': '2026-06-04',
  '2026-07': '2026-07-03',
  '2026-08': '2026-08-06',
  '2026-09': '2026-09-03',
  '2026-10': '2026-10-01',
  '2026-11': '2026-10-28',
  '2026-12': '2026-12-03',
};

/**
 * Return the earliest pickup/delivery Date for a given box month, or
 * null if not in the schedule.
 *
 * @param {string|Date} boxMonth - YYYY-MM string or Date.
 * @returns {Date|null}
 */
function firstPickupForMonth(boxMonth) {
  let key;
  if (typeof boxMonth === 'string') {
    key = boxMonth.length === 7 ? boxMonth : formatMonth(parseDate(boxMonth));
  } else if (boxMonth instanceof Date) {
    key = formatMonth(boxMonth);
  } else {
    return null;
  }
  const iso = SCHEDULE[key];
  return iso ? parseDate(iso) : null;
}

/**
 * Default gray-zone end fallback when a box month is not in the
 * schedule. We use the 5th of the box month as a conservative proxy
 * for "first pickup/delivery" — typical UCS pickup falls in the first
 * week of the month. The function returns a YYYY-MM-DD-grade Date.
 *
 * @param {Date|string} boxMonth
 * @returns {Date}
 */
function fallbackGrayZoneEnd(boxMonth) {
  const tm = typeof boxMonth === 'string' ? parseMonth(boxMonth) : firstOfMonth(boxMonth);
  return new Date(Date.UTC(tm.getUTCFullYear(), tm.getUTCMonth(), 5));
}

/**
 * Get the gray-zone end date for a given upcoming box month — the
 * latest date on which an order placed for an unscheduled-into-the-
 * pack month should be flagged as gray_zone_late_order.
 *
 * Uses schedule data when available; otherwise falls back to the 5th
 * of the box month.
 */
function grayZoneEndForBoxMonth(boxMonth) {
  return firstPickupForMonth(boxMonth) || fallbackGrayZoneEnd(boxMonth);
}

/**
 * Compute the gray-zone window for the "upcoming box month" M:
 *   start = 25th of (M - 1)
 *   end   = first pickup/delivery date for M (inclusive), or fallback.
 *
 * Orders placed within [start, end] are gray-zone-late candidates for
 * box month M.
 *
 * @param {string|Date} upcomingBoxMonth - YYYY-MM or Date on the 1st.
 * @returns {{ start: Date, end: Date, source: 'schedule'|'fallback' }}
 */
function grayZoneWindow(upcomingBoxMonth) {
  const tm = typeof upcomingBoxMonth === 'string' ? parseMonth(upcomingBoxMonth) : firstOfMonth(upcomingBoxMonth);
  const start = new Date(Date.UTC(tm.getUTCFullYear(), tm.getUTCMonth() - 1, 25));
  const scheduled = firstPickupForMonth(tm);
  const end = scheduled || fallbackGrayZoneEnd(tm);
  return { start, end, source: scheduled ? 'schedule' : 'fallback' };
}

module.exports = {
  SCHEDULE,
  firstPickupForMonth,
  fallbackGrayZoneEnd,
  grayZoneEndForBoxMonth,
  grayZoneWindow,
};
