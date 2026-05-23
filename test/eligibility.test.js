'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isRecurringBillingOrder,
  isNewOrderWindowOrder,
  isPrepaidSubscriptionCovering,
  isExpectedRecurringSubscription,
} = require('../src/eligibility');
const { computeCycle } = require('../src/dates');
const { normalizeShopifyOrder, normalizeAppstleSubscription } = require('../src/normalize');
const { UCS_PRODUCT_ID } = require('../src/product');

const cycle = computeCycle('2026-05-09'); // target June

function order(overrides = {}) {
  return normalizeShopifyOrder({
    order_id: 'O1',
    order_date: '2026-05-25',
    customer_email: 'a@b.com',
    product_id: UCS_PRODUCT_ID,
    product_name: 'The Ultimate Cheese Subscription',
    plan_name: 'Monthly',
    financial_status: 'paid',
    fulfillment_status: 'fulfilled',
    quantity: '1',
    ...overrides,
  });
}

function sub(overrides = {}) {
  return normalizeAppstleSubscription({
    subscription_id: 'S1',
    customer_email: 'a@b.com',
    status: 'active',
    product_id: UCS_PRODUCT_ID,
    product_name: 'The Ultimate Cheese Subscription',
    plan_name: 'Monthly',
    created_date: '2026-01-15',
    next_order_date: '2026-05-25',
    delivery_method: 'shipping',
    ...overrides,
  });
}

test('recurring billing order on the 25th counts', () => {
  assert.equal(isRecurringBillingOrder(order(), cycle), true);
});

test('recurring billing order: prepaid plan does not count as recurring', () => {
  const o = order({ plan_name: 'Prepaid: 3 months' });
  assert.equal(isRecurringBillingOrder(o, cycle), false);
});

test('recurring billing order: refunded order excluded', () => {
  const o = order({ financial_status: 'refunded' });
  assert.equal(isRecurringBillingOrder(o, cycle), false);
});

test('recurring billing order: non-UCS product excluded', () => {
  const o = order({ product_id: '111', product_name: 'Some cheese' });
  assert.equal(isRecurringBillingOrder(o, cycle), false);
});

test('new-order window: order on Apr 26 (start) included for target June', () => {
  const o = order({ order_date: '2026-04-26', plan_name: 'Prepaid: 2 months' });
  assert.equal(isNewOrderWindowOrder(o, cycle), true);
});

test('new-order window: order on May 24 (end) included for target June', () => {
  const o = order({ order_date: '2026-05-24' });
  assert.equal(isNewOrderWindowOrder(o, cycle), true);
});

test('new-order window: order on May 25 NOT in the new-order window', () => {
  const o = order({ order_date: '2026-05-25' });
  assert.equal(isNewOrderWindowOrder(o, cycle), false);
});

test('new-order window: order on Apr 25 NOT in window', () => {
  const o = order({ order_date: '2026-04-25' });
  assert.equal(isNewOrderWindowOrder(o, cycle), false);
});

test('prepaid subscription bought in May before gray zone covers target June', () => {
  // May 2 is past May's gray zone (Apr 25-Apr 30); day <= 24 -> first
  // box = June -> 3-month plan covers June, July, August.
  const s = sub({ plan_name: 'Prepaid: 3 months', created_date: '2026-05-02' });
  assert.equal(isPrepaidSubscriptionCovering(s, cycle), true);
});

test('prepaid subscription bought in gray-zone for June does NOT cover target June', () => {
  // May 26 in June's gray zone -> first box defaults to July ->
  // coverage = July + August + September, missing June.
  const s = sub({ plan_name: 'Prepaid: 3 months', created_date: '2026-05-26' });
  assert.equal(isPrepaidSubscriptionCovering(s, cycle), false);
});

test('prepaid subscription with unknown plan length is not counted', () => {
  const s = sub({ plan_name: 'Prepaid', created_date: '2026-05-10' });
  assert.equal(isPrepaidSubscriptionCovering(s, cycle), false);
});

test('expected recurring: active sub with next_order_date on 25th counted (estimate)', () => {
  const s = sub();
  assert.equal(isExpectedRecurringSubscription(s, cycle), true);
});

test('expected recurring: paused sub excluded', () => {
  const s = sub({ status: 'paused' });
  assert.equal(isExpectedRecurringSubscription(s, cycle), false);
});

test('expected recurring: prepaid sub excluded even if next_order_date is set', () => {
  const s = sub({ plan_name: 'Prepaid: 3 months' });
  assert.equal(isExpectedRecurringSubscription(s, cycle), false);
});
