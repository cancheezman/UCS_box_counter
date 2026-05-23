'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runCount } = require('../src/count');
const { normalizeAppstleSubscription, normalizeShopifyOrder } = require('../src/normalize');
const { UCS_PRODUCT_ID } = require('../src/product');

function sub(o) {
  return normalizeAppstleSubscription({
    product_id: UCS_PRODUCT_ID,
    product_name: 'The Ultimate Cheese Subscription',
    status: 'active',
    delivery_method: 'shipping',
    ...o,
  });
}

function order(o) {
  return normalizeShopifyOrder({
    product_id: UCS_PRODUCT_ID,
    product_name: 'The Ultimate Cheese Subscription',
    financial_status: 'paid',
    fulfillment_status: 'fulfilled',
    delivery_method: 'shipping',
    quantity: '1',
    ...o,
  });
}

test('final count combines recurring + new window + prepaid coverage, dedupes overlaps', () => {
  const subscriptions = [
    sub({ subscription_id: 'S1', customer_email: 'a@b.com', plan_name: 'Monthly', next_order_date: '2026-05-25', created_date: '2026-01-01' }),
    // Prepaid sub, 3 months bought May 2 -> covers May, June, July.
    sub({ subscription_id: 'S2', customer_email: 'b@b.com', plan_name: 'Prepaid: 3 months', created_date: '2026-05-02' }),
    // Prepaid sub, 12 months bought Jan 5 -> covers Jan..Dec; targets June.
    sub({ subscription_id: 'S3', customer_email: 'c@b.com', plan_name: '12 month prepaid', created_date: '2026-01-05' }),
  ];
  const orders = [
    // Recurring billing order on May 25 for S1.
    order({ order_id: 'O1', subscription_id: 'S1', customer_email: 'a@b.com', plan_name: 'Monthly', order_date: '2026-05-25' }),
    // New-order window prepaid signup on Apr 28 -> covers May+June (2 months).
    order({ order_id: 'O2', customer_email: 'd@b.com', plan_name: 'Prepaid: 2 months', order_date: '2026-04-28' }),
    // New-order window recurring signup on May 5.
    order({ order_id: 'O3', customer_email: 'e@b.com', plan_name: 'Monthly', order_date: '2026-05-05' }),
    // Out of window: order on Mar 10 (recurring, not in window, not the 25th).
    order({ order_id: 'O4', customer_email: 'f@b.com', plan_name: 'Monthly', order_date: '2026-03-10' }),
    // Refunded order in window — excluded.
    order({ order_id: 'O5', customer_email: 'g@b.com', plan_name: 'Monthly', order_date: '2026-05-10', financial_status: 'refunded' }),
  ];
  const report = runCount({
    subscriptions,
    orders,
    runDate: '2026-06-09',  // not used because we pass targetMonth-ish via runDate
    targetMonth: '2026-06',
    reportType: 'final',
  });
  assert.equal(report.report_type, 'final');
  assert.equal(report.target_box_month, '2026-06');
  assert.equal(report.counts.gross_by_bucket.recurring_billing, 1); // O1
  assert.equal(report.counts.gross_by_bucket.new_order_window, 2); // O2 + O3
  // prepaid coverage gross: S2 + S3 from subs (2) + O2 covering via order (1).
  // O2 appears in both new_order_window AND prepaid_coverage buckets at the gross
  // level; dedupe collapses it to one final entry.
  assert.equal(report.counts.gross_by_bucket.prepaid_coverage, 3);
  // Final count after dedupe: 5 unique customers (Alice/S1, Bob/S2, Carol/S3, Ivy/O2, recurring O3 customer).
  assert.equal(report.counts.final_box_count, 5);
});

test('estimate count includes expected recurring from subscription Next Order Date', () => {
  const subscriptions = [
    sub({ subscription_id: 'S1', customer_email: 'a@b.com', plan_name: 'Monthly', next_order_date: '2026-05-25', created_date: '2026-01-01' }),
    sub({ subscription_id: 'S2', customer_email: 'b@b.com', plan_name: 'Monthly', next_order_date: '2026-05-25', created_date: '2026-01-01' }),
  ];
  const report = runCount({
    subscriptions,
    orders: [],
    runDate: '2026-05-09',
    reportType: 'estimate',
  });
  assert.equal(report.target_box_month, '2026-06');
  assert.equal(report.counts.gross_by_bucket.expected_recurring, 2);
  assert.equal(report.counts.final_box_count, 2);
});

test('dedupes subscription-derived prepaid against order-derived prepaid for same customer', () => {
  const subscriptions = [
    sub({ subscription_id: 'S1', customer_email: 'a@b.com', plan_name: 'Prepaid: 3 months', created_date: '2026-04-28' }),
  ];
  const orders = [
    // The original prepaid signup order for S1 (in the new-order window).
    order({ order_id: 'O1', subscription_id: 'S1', customer_email: 'a@b.com', plan_name: 'Prepaid: 3 months', order_date: '2026-04-28' }),
  ];
  const report = runCount({ subscriptions, orders, targetMonth: '2026-06', reportType: 'final' });
  assert.equal(report.counts.final_box_count, 1);
  // The single underlying customer/subscription appears in three buckets
  // (new_order_window via O1, prepaid_coverage via O1, prepaid_coverage via S1);
  // dedupe by subscription_id collapses them down to one.
  assert.equal(report.counts.duplicates_removed, 2);
});
