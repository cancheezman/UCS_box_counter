'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAppstleSubscription, normalizeShopifyOrder } = require('../src/normalize');
const { checkSubscriptions, checkOrders, WARNING_CODES } = require('../src/warnings');
const { computeCycle } = require('../src/dates');
const { UCS_PRODUCT_ID } = require('../src/product');

const cycle = computeCycle('2026-05-09'); // target June

function codes(warnings) {
  return warnings.map((w) => w.code);
}

test('prepaid with next_order_date is flagged', () => {
  const sub = normalizeAppstleSubscription({
    subscription_id: 'S1',
    customer_email: 'a@b.com',
    status: 'active',
    product_id: UCS_PRODUCT_ID,
    plan_name: 'Prepaid: 3 months',
    next_order_date: '2026-07-25',
    created_date: '2026-04-10',
    delivery_method: 'shipping',
  });
  const w = checkSubscriptions([sub], cycle, []);
  assert.ok(codes(w).includes(WARNING_CODES.PREPAID_HAS_NEXT_ORDER));
});

test('prepaid with undeterminable length is flagged', () => {
  const sub = normalizeAppstleSubscription({
    subscription_id: 'S2',
    customer_email: 'a@b.com',
    status: 'active',
    product_id: UCS_PRODUCT_ID,
    plan_name: 'Prepaid plan',
    created_date: '2026-04-10',
    delivery_method: 'shipping',
  });
  const w = checkSubscriptions([sub], cycle, []);
  assert.ok(codes(w).includes(WARNING_CODES.PLAN_LENGTH_UNKNOWN));
});

test('active with no next charge and no prepaid is flagged', () => {
  const sub = normalizeAppstleSubscription({
    subscription_id: 'S3',
    customer_email: 'a@b.com',
    status: 'active',
    product_id: UCS_PRODUCT_ID,
    plan_name: 'Monthly',
    created_date: '2026-01-10',
    delivery_method: 'shipping',
  });
  const w = checkSubscriptions([sub], cycle, []);
  assert.ok(codes(w).includes(WARNING_CODES.ACTIVE_NO_FUTURE_CHARGE_NO_PREPAID));
});

test('missing email flagged', () => {
  const sub = normalizeAppstleSubscription({
    subscription_id: 'S4',
    status: 'active',
    product_id: UCS_PRODUCT_ID,
    plan_name: 'Monthly',
    next_order_date: '2026-05-25',
    created_date: '2026-01-10',
    delivery_method: 'shipping',
  });
  const w = checkSubscriptions([sub], cycle, []);
  assert.ok(codes(w).includes(WARNING_CODES.EMAIL_MISSING));
});

test('multiple subscriptions for same email flagged', () => {
  const s1 = normalizeAppstleSubscription({
    subscription_id: 'S5', customer_email: 'a@b.com', status: 'active',
    product_id: UCS_PRODUCT_ID, plan_name: 'Monthly', next_order_date: '2026-05-25',
    created_date: '2026-01-10', delivery_method: 'shipping',
  });
  const s2 = normalizeAppstleSubscription({
    subscription_id: 'S6', customer_email: 'a@b.com', status: 'active',
    product_id: UCS_PRODUCT_ID, plan_name: 'Prepaid: 3 months',
    created_date: '2026-04-10', delivery_method: 'shipping',
  });
  const w = checkSubscriptions([s1, s2], cycle, []);
  assert.ok(codes(w).includes(WARNING_CODES.MULTI_SUBS_SAME_EMAIL));
});

test('partial refund on order flagged', () => {
  const o = normalizeShopifyOrder({
    order_id: 'O1', customer_email: 'a@b.com', product_id: UCS_PRODUCT_ID,
    product_name: 'UCS', plan_name: 'Monthly', order_date: '2026-05-25',
    financial_status: 'partially_refunded', refunded_amount: '5', total: '50',
    delivery_method: 'shipping',
  });
  const w = checkOrders([o], [], cycle, []);
  assert.ok(codes(w).includes(WARNING_CODES.ORDER_PARTIALLY_REFUNDED));
});

test('product id mismatch but name looks UCS is flagged', () => {
  const sub = normalizeAppstleSubscription({
    subscription_id: 'S7', customer_email: 'a@b.com', status: 'active',
    product_id: '999', product_name: 'Ultimate Cheese Subscription Sampler',
    plan_name: 'Monthly', next_order_date: '2026-05-25',
    created_date: '2026-01-10', delivery_method: 'shipping',
  });
  const w = checkSubscriptions([sub], cycle, []);
  assert.ok(codes(w).includes(WARNING_CODES.PRODUCT_ID_MISMATCH_NAME_LOOKS_UCS));
});

test('paused subscription with paid order in window flagged', () => {
  const s = normalizeAppstleSubscription({
    subscription_id: 'S8', customer_email: 'a@b.com', status: 'paused',
    product_id: UCS_PRODUCT_ID, plan_name: 'Monthly',
    created_date: '2026-01-10', delivery_method: 'shipping',
  });
  const o = normalizeShopifyOrder({
    order_id: 'O8', customer_email: 'a@b.com', product_id: UCS_PRODUCT_ID,
    product_name: 'UCS', plan_name: 'Monthly', order_date: '2026-05-25',
    financial_status: 'paid', subscription_id: 'S8', delivery_method: 'shipping',
  });
  const w = checkOrders([o], [s], cycle, []);
  assert.ok(codes(w).includes(WARNING_CODES.PAUSED_BUT_PAID_FOR_TARGET));
});

test('warning messages do not embed full email addresses', () => {
  const subs = [
    normalizeAppstleSubscription({
      subscription_id: 'S10', customer_email: 'leak-me@example.com', status: 'active',
      product_id: UCS_PRODUCT_ID, plan_name: 'Monthly', next_order_date: '2026-05-25',
      created_date: '2026-01-10', delivery_method: 'shipping',
    }),
    normalizeAppstleSubscription({
      subscription_id: 'S11', customer_email: 'leak-me@example.com', status: 'active',
      product_id: UCS_PRODUCT_ID, plan_name: 'Monthly', next_order_date: '2026-05-25',
      created_date: '2026-01-12', delivery_method: 'shipping',
    }),
  ];
  const w = checkSubscriptions(subs, cycle, []);
  for (const warning of w) {
    assert.equal(
      warning.message.includes('leak-me@example.com'),
      false,
      `warning ${warning.code} message leaked full email: ${warning.message}`,
    );
  }
  // But the structured context should still have the real value for ops use.
  const multi = w.find((x) => x.code === WARNING_CODES.MULTI_SUBS_SAME_EMAIL);
  assert.ok(multi);
  assert.equal(multi.customer_email, 'leak-me@example.com');
});

test('warning messages mask subscription/order IDs', () => {
  const sub = normalizeAppstleSubscription({
    subscription_id: 'APP-9001-very-long-id', customer_email: 'x@example.com', status: 'active',
    product_id: UCS_PRODUCT_ID, plan_name: 'Prepaid plan', created_date: '2026-04-10',
    delivery_method: 'shipping',
  });
  const w = checkSubscriptions([sub], cycle, []);
  for (const warning of w) {
    assert.equal(
      warning.message.includes('APP-9001-very-long-id'),
      false,
      `warning ${warning.code} message leaked full subscription_id: ${warning.message}`,
    );
  }
});

test('delivery method missing flagged', () => {
  const s = normalizeAppstleSubscription({
    subscription_id: 'S9', customer_email: 'a@b.com', status: 'active',
    product_id: UCS_PRODUCT_ID, plan_name: 'Monthly', next_order_date: '2026-05-25',
    created_date: '2026-01-10',
  });
  const w = checkSubscriptions([s], cycle, []);
  assert.ok(codes(w).includes(WARNING_CODES.DELIVERY_METHOD_MISSING));
});
