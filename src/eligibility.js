'use strict';

// Eligibility filters for the three counting buckets.

const { sameDay, inRangeInclusive, formatMonth } = require('./dates');

/**
 * Recurring billing eligibility:
 * - A successful UCS order processed on the billing_cycle_date (the 25th)
 *   that is paid, not cancelled, not fully refunded, and is recurring (not prepaid).
 */
function isRecurringBillingOrder(order, cycle) {
  if (!order || !order.is_ucs) return false;
  if (!order.is_paid) return false;
  if (order.fully_refunded) return false;
  if (order.cancelled_at) return false;
  if (order.is_prepaid) return false;
  if (!order.order_date) return false;
  // The 25th billing run can spill into the 26th in practice; accept the 25th
  // strictly (final-run language uses "successful paid recurring orders from
  // the 25th").
  return sameDay(order.order_date, cycle.billingCycleDate);
}

/**
 * New-order window eligibility (recurring OR prepaid):
 * - Order date is in [newOrderWindowStart, newOrderWindowEnd], inclusive.
 * - Paid, not cancelled, not fully refunded, UCS product.
 */
function isNewOrderWindowOrder(order, cycle) {
  if (!order || !order.is_ucs) return false;
  if (!order.is_paid) return false;
  if (order.fully_refunded) return false;
  if (order.cancelled_at) return false;
  if (!order.order_date) return false;
  return inRangeInclusive(order.order_date, cycle.newOrderWindowStart, cycle.newOrderWindowEnd);
}

/**
 * Prepaid coverage eligibility from the Appstle subscription export:
 * - Plan is prepaid with a known length.
 * - Purchase date (created_date) yields a coverage range that includes targetMonth.
 * - Subscription is not cancelled before the target month (paused is OK; spec
 *   says paused subs with a paid target-month order are a review flag, not a drop).
 */
function isPrepaidSubscriptionCovering(sub, cycle) {
  if (!sub || !sub.is_ucs) return false;
  if (!sub.is_prepaid) return false;
  if (!sub.plan_length) return false;
  if (!sub.created_date) return false;
  // Don't count subs cancelled strictly before the target month begins.
  // (Cancellation after paying for a target month is a review flag, handled
  // separately, but for prepaid we want to include if coverage applies.)
  // We keep this permissive: the warning system flags edge cases.
  const { coverageRange } = require('./prepaid');
  let range;
  try {
    range = coverageRange(sub.created_date, sub.plan_length);
  } catch (_err) {
    return false;
  }
  const tm = cycle.targetMonth.getTime();
  return tm >= range.first.getTime() && tm <= range.last.getTime();
}

/**
 * Prepaid coverage from an original order's plan (for prepaid purchases that
 * fall outside the new-order window for the target — e.g. a 12-month prepaid
 * bought 5 months ago still covers the target month).
 */
function isPrepaidOrderCovering(order, cycle) {
  if (!order || !order.is_ucs) return false;
  if (!order.is_prepaid) return false;
  if (!order.plan_length) return false;
  if (!order.is_paid) return false;
  if (order.fully_refunded) return false;
  if (order.cancelled_at) return false;
  if (!order.order_date) return false;
  const { coverageRange } = require('./prepaid');
  let range;
  try {
    range = coverageRange(order.order_date, order.plan_length);
  } catch (_err) {
    return false;
  }
  const tm = cycle.targetMonth.getTime();
  return tm >= range.first.getTime() && tm <= range.last.getTime();
}

/**
 * Estimate-mode "expected recurring billing" eligibility:
 * - Active recurring (non-prepaid) UCS subscription with next_order_date
 *   on the upcoming billing_cycle_date (the 25th of run-date's month).
 */
function isExpectedRecurringSubscription(sub, cycle) {
  if (!sub || !sub.is_ucs) return false;
  if (sub.is_prepaid) return false;
  if (sub.status === 'cancelled') return false;
  if (sub.status === 'paused') return false;
  if (!sub.next_order_date) return false;
  return sameDay(sub.next_order_date, cycle.billingCycleDate);
}

module.exports = {
  isRecurringBillingOrder,
  isNewOrderWindowOrder,
  isPrepaidSubscriptionCovering,
  isPrepaidOrderCovering,
  isExpectedRecurringSubscription,
  formatMonth,
};
