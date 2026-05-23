'use strict';

// Main counting engine. Combines the three data sources into bucketed entries,
// applies eligibility filters, deduplicates at target-box-month level, and
// produces the final box count.

const { formatDate, formatMonth, computeCycle, computeCycleFromTarget, prepaidFirstBoxMonth, addMonths } = require('./dates');
const { coverageRange } = require('./prepaid');
const {
  isRecurringBillingOrder,
  isNewOrderWindowOrder,
  isPrepaidSubscriptionCovering,
  isPrepaidOrderCovering,
  isExpectedRecurringSubscription,
} = require('./eligibility');
const { dedupe } = require('./dedupe');
const { checkSubscriptions, checkOrders } = require('./warnings');

const BUCKET_PRIORITY = {
  recurring_billing: 1,
  new_order_window: 2,
  prepaid_coverage: 3,
  expected_recurring: 4, // estimate-mode only
};

function entryFromOrder(order, bucket, cycle) {
  const purchaseDate = order.order_date ? formatDate(order.order_date) : '';
  let prepaidFirst = '';
  let prepaidLast = '';
  if (order.is_prepaid && order.plan_length && order.order_date) {
    try {
      const range = coverageRange(order.order_date, order.plan_length);
      prepaidFirst = formatMonth(range.first);
      prepaidLast = formatMonth(range.last);
    } catch (_err) { /* ignore */ }
  }
  return {
    id: `order:${order.order_id}`,
    source_bucket: bucket,
    subscription_type: order.is_prepaid ? 'prepaid' : 'recurring',
    customer_name: order.customer_name,
    customer_email: order.customer_email,
    shopify_customer_id: order.customer_id,
    subscription_id: order.subscription_id,
    shopify_order_id: order.order_id,
    product_id: order.product_id,
    product_name: order.product_name,
    plan_name: order.plan_name,
    purchase_date: purchaseDate,
    prepaid_first_box_month: prepaidFirst,
    prepaid_last_box_month: prepaidLast,
    delivery_method: order.delivery_method,
    shipping_name: order.shipping_name,
    shipping_address_1: order.shipping_address_1,
    shipping_address_2: order.shipping_address_2,
    city: order.city,
    province: order.province,
    postal_code: order.postal_code,
    phone: order.phone,
    status: order.financial_status,
    notes: order.appstle_attribution ? 'Appstle-attributed order' : '',
    needs_review: order.partially_refunded ? 'yes' : '',
    target_month: cycle.targetMonth,
    billing_cycle_date: formatDate(cycle.billingCycleDate),
    _priority: BUCKET_PRIORITY[bucket] || 99,
  };
}

function entryFromSubscription(sub, bucket, cycle) {
  let prepaidFirst = '';
  let prepaidLast = '';
  if (sub.is_prepaid && sub.plan_length && sub.created_date) {
    try {
      const range = coverageRange(sub.created_date, sub.plan_length);
      prepaidFirst = formatMonth(range.first);
      prepaidLast = formatMonth(range.last);
    } catch (_err) { /* ignore */ }
  }
  return {
    id: `sub:${sub.subscription_id}`,
    source_bucket: bucket,
    subscription_type: sub.is_prepaid ? 'prepaid' : 'recurring',
    customer_name: sub.customer_name,
    customer_email: sub.customer_email,
    shopify_customer_id: '',
    subscription_id: sub.subscription_id,
    shopify_order_id: '',
    product_id: sub.product_id,
    product_name: sub.product_name,
    plan_name: sub.plan_name,
    purchase_date: sub.created_date ? formatDate(sub.created_date) : '',
    prepaid_first_box_month: prepaidFirst,
    prepaid_last_box_month: prepaidLast,
    delivery_method: sub.delivery_method,
    shipping_name: sub.shipping_name,
    shipping_address_1: sub.shipping_address_1,
    shipping_address_2: sub.shipping_address_2,
    city: sub.city,
    province: sub.province,
    postal_code: sub.postal_code,
    phone: sub.phone,
    status: sub.status,
    notes: '',
    needs_review: '',
    target_month: cycle.targetMonth,
    billing_cycle_date: formatDate(cycle.billingCycleDate),
    _priority: BUCKET_PRIORITY[bucket] || 99,
  };
}

/**
 * Run the counter.
 *
 * @param {Object} opts
 * @param {Array} opts.subscriptions - normalized Appstle rows
 * @param {Array} opts.orders - normalized Shopify orders
 * @param {string|Date|null} [opts.runDate]
 * @param {string|null} [opts.targetMonth] - YYYY-MM. Overrides runDate.
 * @param {'estimate'|'final'} [opts.reportType='estimate']
 * @returns {Object} report
 */
function runCount({ subscriptions = [], orders = [], runDate = null, targetMonth = null, reportType = 'estimate' }) {
  if (!['estimate', 'final'].includes(reportType)) {
    throw new Error(`reportType must be 'estimate' or 'final'`);
  }
  const cycle = targetMonth ? computeCycleFromTarget(targetMonth) : computeCycle(runDate || new Date());

  const subs = subscriptions || [];
  const ords = orders || [];

  // Warnings.
  const warnings = [];
  checkSubscriptions(subs, cycle, warnings);
  checkOrders(ords, subs, cycle, warnings);

  // Bucket A: recurring billing orders (final mode primarily; estimate may have empty here).
  const recurringBilling = ords
    .filter((o) => isRecurringBillingOrder(o, cycle))
    .map((o) => entryFromOrder(o, 'recurring_billing', cycle));

  // Bucket B: new orders in the window (both recurring and prepaid signups).
  const newOrders = ords
    .filter((o) => isNewOrderWindowOrder(o, cycle))
    .map((o) => entryFromOrder(o, 'new_order_window', cycle));

  // Bucket C: prepaid coverage from subscription export.
  const prepaidSubs = subs
    .filter((s) => isPrepaidSubscriptionCovering(s, cycle))
    .map((s) => entryFromSubscription(s, 'prepaid_coverage', cycle));

  // Bucket C': prepaid coverage derived from past orders (covers cases where
  // the subscription export is missing/outdated).
  const prepaidFromOrders = ords
    .filter((o) => isPrepaidOrderCovering(o, cycle))
    .map((o) => entryFromOrder(o, 'prepaid_coverage', cycle));

  // Bucket D (estimate only): expected recurring billing from active subs.
  const expectedRecurring = (reportType === 'estimate')
    ? subs.filter((s) => isExpectedRecurringSubscription(s, cycle))
        .map((s) => entryFromSubscription(s, 'expected_recurring', cycle))
    : [];

  // Sort buckets by priority (recurring billing wins over expected recurring,
  // confirmed orders win over subscription-derived prepaid).
  const ordered = [
    ...recurringBilling,
    ...newOrders,
    ...prepaidFromOrders,
    ...prepaidSubs,
    ...expectedRecurring,
  ];

  const gross = {
    recurring_billing: recurringBilling.length,
    new_order_window: newOrders.length,
    prepaid_coverage: prepaidSubs.length + prepaidFromOrders.length,
    expected_recurring: expectedRecurring.length,
  };

  const { kept, removed } = dedupe(ordered, cycle.targetMonthKey);
  // Recount post-dedupe by bucket (for transparency).
  const net = { recurring_billing: 0, new_order_window: 0, prepaid_coverage: 0, expected_recurring: 0 };
  for (const e of kept) net[e.source_bucket] = (net[e.source_bucket] || 0) + 1;

  // Warning counts by code.
  const warningCounts = {};
  for (const w of warnings) {
    warningCounts[w.code] = (warningCounts[w.code] || 0) + 1;
  }

  return {
    report_type: reportType,
    target_box_month: cycle.targetMonthKey,
    billing_cycle_date: formatDate(cycle.billingCycleDate),
    new_order_window_start: formatDate(cycle.newOrderWindowStart),
    new_order_window_end: formatDate(cycle.newOrderWindowEnd),
    run_date: cycle.runDate ? formatDate(cycle.runDate) : null,
    counts: {
      gross_by_bucket: gross,
      net_by_bucket: net,
      duplicates_removed: removed.length,
      final_box_count: kept.length,
    },
    entries: kept.map(stripPrivate),
    duplicates: removed.map(stripPrivate),
    warnings,
    warning_counts: warningCounts,
    cycle,
  };
}

function stripPrivate(entry) {
  const out = { ...entry };
  delete out._priority;
  // Convert target_month Date to string for serializability.
  if (out.target_month instanceof Date) out.target_month = formatMonth(out.target_month);
  return out;
}

module.exports = { runCount };
