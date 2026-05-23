'use strict';

// Main counting engine. Combines the three data sources into bucketed entries,
// applies eligibility filters, deduplicates at target-box-month level, and
// produces the final box count.

const {
  formatDate,
  formatMonth,
  computeCycle,
  computeCycleFromTarget,
  prepaidFirstBoxMonth,
  addMonths,
  firstBoxMonthAttribution,
  parseDate,
  parseMonth,
  inRangeInclusive,
} = require('./dates');
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
const { grayZoneWindow } = require('./schedule');
const { indexOverrides, findOverride } = require('./overrides');

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

function attachAttribution(entry) {
  if (!entry.purchase_date) {
    entry.tentative_box_month = '';
    entry.default_box_month = '';
    entry.gray_zone = false;
    entry.gray_zone_window_start = '';
    entry.gray_zone_window_end = '';
    entry.gray_zone_source = '';
    return entry;
  }
  let attr;
  try {
    attr = firstBoxMonthAttribution(entry.purchase_date);
  } catch (_err) {
    return entry;
  }
  entry.tentative_box_month = formatMonth(attr.tentativeBoxMonth);
  entry.default_box_month = formatMonth(attr.firstBoxMonth);
  entry.gray_zone = attr.grayZone;
  entry.gray_zone_window_start = attr.grayZoneWindowStart ? formatDate(attr.grayZoneWindowStart) : '';
  entry.gray_zone_window_end = attr.grayZoneWindowEnd ? formatDate(attr.grayZoneWindowEnd) : '';
  entry.gray_zone_source = attr.grayZoneSource || '';
  return entry;
}

function applyOverride(entry, overrideIndex) {
  if (!overrideIndex) {
    entry.override_action = '';
    entry.override_target_month = '';
    entry.override_reason = '';
    return entry;
  }
  const match = findOverride({
    subscription_id: entry.subscription_id,
    shopify_order_id: entry.shopify_order_id,
    customer_email: entry.customer_email,
    // For email-based matching we try the entry's *attributed* (default or
    // override target) month — the operator names the box month in the
    // override row, so first try the entry's default box month then the
    // tentative.
    target_box_month: entry.default_box_month || entry.tentative_box_month,
  }, overrideIndex);
  if (!match) {
    // Try again with the tentative box month, in case the override row was
    // written against the upcoming (tentative) box month rather than the
    // default-attributed one.
    const second = findOverride({
      subscription_id: entry.subscription_id,
      shopify_order_id: entry.shopify_order_id,
      customer_email: entry.customer_email,
      target_box_month: entry.tentative_box_month,
    }, overrideIndex);
    if (!second) {
      entry.override_action = '';
      entry.override_target_month = '';
      entry.override_reason = '';
      return entry;
    }
    entry.override_action = second.override_action;
    entry.override_target_month = second.target_box_month;
    entry.override_reason = second.reason || '';
    return entry;
  }
  entry.override_action = match.override_action;
  entry.override_target_month = match.target_box_month;
  entry.override_reason = match.reason || '';
  return entry;
}

/**
 * Decide the attributed box month for an entry after applying any matched
 * override. Returns YYYY-MM (string) or '' if unknown.
 *
 * - `include` overrides: attributed_month = override.target_box_month.
 * - `exclude` overrides: attributed_month stays at default; the entry is
 *   marked as excluded by the caller using `override_action === 'exclude'`.
 * - No override: attributed_month = default_box_month.
 */
function attributedMonth(entry) {
  if (entry.override_action === 'include' && entry.override_target_month) {
    return entry.override_target_month;
  }
  return entry.default_box_month || '';
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
 * @param {Array} [opts.overrides] - manual override rows (see src/overrides.js)
 * @returns {Object} report
 */
function runCount({
  subscriptions = [],
  orders = [],
  runDate = null,
  targetMonth = null,
  reportType = 'estimate',
  overrides = [],
}) {
  if (!['estimate', 'final'].includes(reportType)) {
    throw new Error(`reportType must be 'estimate' or 'final'`);
  }
  const cycle = targetMonth ? computeCycleFromTarget(targetMonth) : computeCycle(runDate || new Date());
  const targetKey = cycle.targetMonthKey;
  const targetGrayZone = grayZoneWindow(cycle.targetMonth);

  const subs = subscriptions || [];
  const ords = orders || [];
  const overrideIndex = indexOverrides(overrides || []);

  // Warnings.
  const warnings = [];
  checkSubscriptions(subs, cycle, warnings);
  checkOrders(ords, subs, cycle, warnings);

  // Bucket A: recurring billing orders (final mode primarily).
  const recurringBilling = ords
    .filter((o) => isRecurringBillingOrder(o, cycle))
    .map((o) => entryFromOrder(o, 'recurring_billing', cycle));

  // Bucket B: new orders in the window.
  const newOrders = ords
    .filter((o) => isNewOrderWindowOrder(o, cycle))
    .map((o) => entryFromOrder(o, 'new_order_window', cycle));

  // Bucket C: prepaid coverage from subscription export.
  const prepaidSubs = subs
    .filter((s) => isPrepaidSubscriptionCovering(s, cycle))
    .map((s) => entryFromSubscription(s, 'prepaid_coverage', cycle));

  // Bucket C': prepaid coverage derived from past orders.
  const prepaidFromOrders = ords
    .filter((o) => isPrepaidOrderCovering(o, cycle))
    .map((o) => entryFromOrder(o, 'prepaid_coverage', cycle));

  // Bucket D (estimate only): expected recurring billing from active subs.
  const expectedRecurring = (reportType === 'estimate')
    ? subs.filter((s) => isExpectedRecurringSubscription(s, cycle))
        .map((s) => entryFromSubscription(s, 'expected_recurring', cycle))
    : [];

  const ordered = [
    ...recurringBilling,
    ...newOrders,
    ...prepaidFromOrders,
    ...prepaidSubs,
    ...expectedRecurring,
  ];

  // Attach attribution + override metadata to every entry.
  for (const e of ordered) {
    attachAttribution(e);
    applyOverride(e, overrideIndex);
  }

  const gross = {
    recurring_billing: recurringBilling.length,
    new_order_window: newOrders.length,
    prepaid_coverage: prepaidSubs.length + prepaidFromOrders.length,
    expected_recurring: expectedRecurring.length,
  };

  const { kept: dedupedKept, removed } = dedupe(ordered, cycle.targetMonthKey);

  // Gray-zone late-order candidates: orders whose tentative box month equals
  // the current target month AND whose order date falls inside the gray-zone
  // window for the target. These default to T+1 (so they should NOT be in
  // T's pack count), but we still surface them for review and allow an
  // operator override to pull them in.
  const grayZoneCandidates = [];
  const seenIds = new Set(dedupedKept.map((e) => e.id));
  for (const o of ords) {
    if (!o.is_ucs || !o.is_paid || o.fully_refunded || o.cancelled_at) continue;
    if (!o.order_date) continue;
    if (!inRangeInclusive(o.order_date, targetGrayZone.start, targetGrayZone.end)) continue;
    const tentMonth = formatMonth(o.order_date);
    // We only want orders whose TENTATIVE box month (under the 26-24 rule)
    // equals the current target. Compute attribution from purchase date.
    let attr;
    try { attr = firstBoxMonthAttribution(o.order_date); } catch (_err) { continue; }
    if (formatMonth(attr.tentativeBoxMonth) !== targetKey) continue;
    if (!attr.grayZone) continue;
    // Build a candidate entry (use new_order_window bucket as the closest
    // semantic match — these are signups in the late portion of the window).
    const entry = entryFromOrder(o, 'gray_zone_late_order', cycle);
    attachAttribution(entry);
    applyOverride(entry, overrideIndex);
    if (seenIds.has(entry.id)) continue;
    grayZoneCandidates.push(entry);
    seenIds.add(entry.id);
  }
  // Also surface gray-zone candidates from the Appstle subscription export.
  for (const s of subs) {
    if (!s.is_ucs) continue;
    if (!s.created_date) continue;
    if (!inRangeInclusive(s.created_date, targetGrayZone.start, targetGrayZone.end)) continue;
    let attr;
    try { attr = firstBoxMonthAttribution(s.created_date); } catch (_err) { continue; }
    if (formatMonth(attr.tentativeBoxMonth) !== targetKey) continue;
    if (!attr.grayZone) continue;
    const entry = entryFromSubscription(s, 'gray_zone_late_order', cycle);
    attachAttribution(entry);
    applyOverride(entry, overrideIndex);
    if (seenIds.has(entry.id)) continue;
    grayZoneCandidates.push(entry);
    seenIds.add(entry.id);
  }

  // Split kept entries by attribution into:
  //   - counted: belong to the target month (after override)
  //   - excluded: had `override_action === 'exclude'` for the target month
  //   - deferred: would have been counted by buckets but their attribution
  //     (default or override) moved them out of the target month
  const counted = [];
  const excluded = [];
  const deferred = [];
  for (const e of dedupedKept) {
    const attMonth = attributedMonth(e);
    const isExclude =
      e.override_action === 'exclude' &&
      e.override_target_month === targetKey;
    if (isExclude) {
      e.exclusion_reason = 'override_exclude';
      excluded.push(e);
      continue;
    }
    // If override `include` redirected to a different target, drop from this run.
    if (e.override_action === 'include' && e.override_target_month && e.override_target_month !== targetKey) {
      e.exclusion_reason = `override_included_in_${e.override_target_month}`;
      deferred.push(e);
      continue;
    }
    // No override-driven move; check default attribution.
    //
    // Recurring billing / expected-recurring are date-cycle anchored to the
    // target billing day and always belong to T. Prepaid coverage entries
    // come from explicit coverage-range math (see src/prepaid.js) that
    // already encodes which target months the plan covers — we should not
    // re-attribute them via the first-box-month rule. The gray-zone shift
    // only governs which target month should treat a brand-new signup as
    // "their first box", i.e. the `new_order_window` bucket.
    const trustBucket =
      e.source_bucket === 'recurring_billing' ||
      e.source_bucket === 'expected_recurring' ||
      e.source_bucket === 'prepaid_coverage';
    if (!trustBucket && attMonth && attMonth !== targetKey) {
      e.exclusion_reason = `default_attribution_${attMonth}`;
      deferred.push(e);
      continue;
    }
    counted.push(e);
  }

  // Pull in gray-zone candidates whose override action is 'include' for the
  // current target.
  for (const e of grayZoneCandidates) {
    const isIncludeHere =
      e.override_action === 'include' &&
      e.override_target_month === targetKey;
    if (isIncludeHere) {
      e.source_bucket = 'gray_zone_late_order_included';
      counted.push(e);
    }
  }

  // Recount post-attribution by bucket.
  const net = { recurring_billing: 0, new_order_window: 0, prepaid_coverage: 0, expected_recurring: 0, gray_zone_late_order_included: 0 };
  for (const e of counted) net[e.source_bucket] = (net[e.source_bucket] || 0) + 1;

  // Emit warnings for gray-zone records (counted, excluded, deferred, and
  // candidate-only). These are surfaced separately so operators can decide
  // case by case.
  const { maskEmail, maskId } = require('./privacy');
  function emitGrayZoneWarning(e, status) {
    const ref = e.shopify_order_id
      ? `order ${maskId(e.shopify_order_id)}`
      : e.subscription_id
      ? `subscription ${maskId(e.subscription_id)}`
      : `customer ${maskEmail(e.customer_email)}`;
    const window = `${e.gray_zone_window_start || '?'} to ${e.gray_zone_window_end || '?'}`;
    warnings.push({
      code: 'gray_zone_late_order',
      message: `${ref}: purchase ${e.purchase_date} falls in the gray-zone window (${window}) for box ${e.tentative_box_month || '?'} — status: ${status}.`,
      gray_zone_status: status,
      tentative_box_month: e.tentative_box_month,
      default_box_month: e.default_box_month,
      override_action: e.override_action || '',
      override_target_month: e.override_target_month || '',
      override_reason: e.override_reason || '',
      subscription_id: e.subscription_id || '',
      order_id: e.shopify_order_id || '',
      customer_email: e.customer_email || '',
      purchase_date: e.purchase_date,
      schedule_source: e.gray_zone_source || '',
    });
  }
  // Gray-zone warnings: only meaningful for new-signup buckets. The
  // gray-zone rule governs late NEW orders, not recurring billing or
  // longstanding prepaid coverage from earlier months.
  function isNewSignupBucket(e) {
    return (
      e.source_bucket === 'new_order_window' ||
      e.source_bucket === 'gray_zone_late_order' ||
      e.source_bucket === 'gray_zone_late_order_included'
    );
  }
  for (const e of counted) {
    if (e.gray_zone && isNewSignupBucket(e)) emitGrayZoneWarning(e, 'counted_for_target');
  }
  for (const e of excluded) emitGrayZoneWarning(e, 'override_excluded');
  for (const e of deferred) {
    if ((e.gray_zone || e.override_action) && isNewSignupBucket(e)) {
      emitGrayZoneWarning(e, 'deferred');
    }
  }
  for (const e of grayZoneCandidates) {
    if (e.override_action === 'include' && e.override_target_month === targetKey) continue;
    emitGrayZoneWarning(e, 'gray_zone_candidate');
  }

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
    gray_zone_window_start: formatDate(targetGrayZone.start),
    gray_zone_window_end: formatDate(targetGrayZone.end),
    gray_zone_schedule_source: targetGrayZone.source,
    run_date: cycle.runDate ? formatDate(cycle.runDate) : null,
    counts: {
      gross_by_bucket: gross,
      net_by_bucket: net,
      duplicates_removed: removed.length,
      final_box_count: counted.length,
      gray_zone_excluded: excluded.length,
      gray_zone_deferred: deferred.length,
      gray_zone_candidates: grayZoneCandidates.length,
    },
    entries: counted.map(stripPrivate),
    duplicates: removed.map(stripPrivate),
    gray_zone_excluded: excluded.map(stripPrivate),
    gray_zone_deferred: deferred.map(stripPrivate),
    gray_zone_candidates: grayZoneCandidates.map(stripPrivate),
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
