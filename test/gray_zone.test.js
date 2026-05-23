'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runCount } = require('../src/count');
const { firstBoxMonthAttribution, formatMonth } = require('../src/dates');
const { normalizeAppstleSubscription, normalizeShopifyOrder } = require('../src/normalize');
const { UCS_PRODUCT_ID } = require('../src/product');

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

function sub(o) {
  return normalizeAppstleSubscription({
    product_id: UCS_PRODUCT_ID,
    product_name: 'The Ultimate Cheese Subscription',
    status: 'active',
    delivery_method: 'shipping',
    ...o,
  });
}

test('Aug 28 purchase defaults to October 2026 first box month', () => {
  const attr = firstBoxMonthAttribution('2026-08-28');
  assert.equal(formatMonth(attr.firstBoxMonth), '2026-10');
  assert.equal(formatMonth(attr.tentativeBoxMonth), '2026-09');
  assert.equal(attr.grayZone, true);
});

test('Aug 28 purchase: flagged gray_zone_late_order when running for September', () => {
  const subscriptions = [];
  const orders = [
    order({
      order_id: 'O1',
      subscription_id: 'S1',
      customer_email: 'late@example.com',
      plan_name: 'Monthly',
      order_date: '2026-08-28',
    }),
  ];
  const report = runCount({
    subscriptions,
    orders,
    targetMonth: '2026-09',
    reportType: 'final',
  });
  assert.equal(report.target_box_month, '2026-09');
  // Default behaviour: the order is NOT in September's final count.
  assert.equal(report.counts.final_box_count, 0);
  // It IS surfaced as a gray-zone candidate.
  assert.equal(report.counts.gray_zone_candidates, 1);
  const candidate = report.gray_zone_candidates[0];
  assert.equal(candidate.shopify_order_id, 'O1');
  assert.equal(candidate.tentative_box_month, '2026-09');
  assert.equal(candidate.default_box_month, '2026-10');
  // A warning is emitted with the gray_zone_late_order code.
  const grayWarnings = report.warnings.filter((w) => w.code === 'gray_zone_late_order');
  assert.equal(grayWarnings.length, 1);
  assert.equal(grayWarnings[0].order_id, 'O1');
  assert.equal(grayWarnings[0].gray_zone_status, 'gray_zone_candidate');
});

test('Aug 28 purchase: shows up in October count by default (gray-zone shifted)', () => {
  const orders = [
    order({
      order_id: 'O1',
      subscription_id: 'S1',
      customer_email: 'late@example.com',
      plan_name: 'Monthly',
      order_date: '2026-08-28',
    }),
  ];
  const report = runCount({
    subscriptions: [],
    orders,
    targetMonth: '2026-10',
    reportType: 'final',
  });
  assert.equal(report.target_box_month, '2026-10');
  assert.equal(report.counts.final_box_count, 1);
  const entry = report.entries[0];
  assert.equal(entry.shopify_order_id, 'O1');
  assert.equal(entry.gray_zone, true);
  assert.equal(entry.default_box_month, '2026-10');
});

test('override include moves an Aug 28 gray-zone record into September', () => {
  const orders = [
    order({
      order_id: 'O1',
      subscription_id: 'S1',
      customer_email: 'late@example.com',
      plan_name: 'Monthly',
      order_date: '2026-08-28',
    }),
  ];
  const overrides = [{
    subscription_id: 'S1',
    shopify_order_id: '',
    customer_email: '',
    target_box_month: '2026-09',
    override_action: 'include',
    reason: 'Customer asked to include in September',
  }];
  const sept = runCount({ subscriptions: [], orders, targetMonth: '2026-09', reportType: 'final', overrides });
  assert.equal(sept.counts.final_box_count, 1);
  assert.equal(sept.entries[0].shopify_order_id, 'O1');
  assert.equal(sept.entries[0].override_action, 'include');
  assert.equal(sept.entries[0].override_target_month, '2026-09');

  const oct = runCount({ subscriptions: [], orders, targetMonth: '2026-10', reportType: 'final', overrides });
  // The include override moved it to September, so October should NOT count it.
  assert.equal(oct.counts.final_box_count, 0);
  assert.equal(oct.counts.gray_zone_deferred, 1);
});

test('override exclude removes a record from the target month and flags it for review', () => {
  const orders = [
    order({
      order_id: 'O1',
      subscription_id: 'S1',
      customer_email: 'foo@example.com',
      plan_name: 'Monthly',
      order_date: '2026-08-28',
    }),
  ];
  const overrides = [{
    subscription_id: 'S1',
    shopify_order_id: '',
    customer_email: '',
    target_box_month: '2026-10',
    override_action: 'exclude',
    reason: 'Refund pending',
  }];
  const report = runCount({ subscriptions: [], orders, targetMonth: '2026-10', reportType: 'final', overrides });
  assert.equal(report.counts.final_box_count, 0);
  assert.equal(report.counts.gray_zone_excluded, 1);
  // It also produces a gray_zone_late_order warning with status override_excluded.
  const w = report.warnings.find((x) => x.code === 'gray_zone_late_order' && x.gray_zone_status === 'override_excluded');
  assert.ok(w);
  assert.equal(w.order_id, 'O1');
});

test('regression: an order on the 26th-24th window stays in next box month (no gray zone)', () => {
  // May 5 -> not in any gray-zone window; in the new-order window for
  // June. Should count for June with NO gray-zone flag.
  const orders = [
    order({
      order_id: 'OR3',
      customer_email: 'norm@example.com',
      plan_name: 'Monthly',
      order_date: '2026-05-05',
    }),
  ];
  const report = runCount({ subscriptions: [], orders, targetMonth: '2026-06', reportType: 'final' });
  assert.equal(report.counts.final_box_count, 1);
  const entry = report.entries[0];
  assert.equal(entry.gray_zone, false);
  // No gray-zone warning is emitted.
  const gz = report.warnings.filter((w) => w.code === 'gray_zone_late_order');
  assert.equal(gz.length, 0);
});

test('regression: existing sample-style cycle still produces the expected count', () => {
  // Mirror the existing test "final count combines recurring + new window +
  // prepaid coverage, dedupes overlaps" to guard against regression.
  const subscriptions = [
    sub({ subscription_id: 'S1', customer_email: 'a@b.com', plan_name: 'Monthly', next_order_date: '2026-05-25', created_date: '2026-01-01' }),
    sub({ subscription_id: 'S2', customer_email: 'b@b.com', plan_name: 'Prepaid: 3 months', created_date: '2026-05-02' }),
    sub({ subscription_id: 'S3', customer_email: 'c@b.com', plan_name: '12 month prepaid', created_date: '2026-01-05' }),
  ];
  const orders = [
    order({ order_id: 'O1', subscription_id: 'S1', customer_email: 'a@b.com', plan_name: 'Monthly', order_date: '2026-05-25' }),
    order({ order_id: 'O2', customer_email: 'd@b.com', plan_name: 'Prepaid: 2 months', order_date: '2026-04-28' }),
    order({ order_id: 'O3', customer_email: 'e@b.com', plan_name: 'Monthly', order_date: '2026-05-05' }),
  ];
  const report = runCount({ subscriptions, orders, targetMonth: '2026-06', reportType: 'final' });
  assert.equal(report.counts.final_box_count, 5);
});

test('gray-zone window for the target month is reported in the result', () => {
  const report = runCount({ subscriptions: [], orders: [], targetMonth: '2026-09', reportType: 'final' });
  assert.equal(report.gray_zone_window_start, '2026-08-25');
  assert.equal(report.gray_zone_window_end, '2026-09-03');
  assert.equal(report.gray_zone_schedule_source, 'schedule');
});

test('warning message masks email and order id (privacy hardening)', () => {
  const orders = [
    order({
      order_id: 'ORD12345',
      subscription_id: '',
      customer_email: 'reveal@example.com',
      plan_name: 'Monthly',
      order_date: '2026-08-28',
    }),
  ];
  const report = runCount({ subscriptions: [], orders, targetMonth: '2026-09', reportType: 'final' });
  const w = report.warnings.find((x) => x.code === 'gray_zone_late_order');
  assert.ok(w);
  assert.ok(!w.message.includes('reveal@example.com'), 'should not include full email in message');
  assert.ok(!w.message.includes('ORD12345'), 'should not include full order id in message');
  // The structured context fields still carry the real values for reconciliation.
  assert.equal(w.customer_email, 'reveal@example.com');
  assert.equal(w.order_id, 'ORD12345');
});
