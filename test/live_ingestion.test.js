'use strict';

// Integration test: live Shopify path via setRunner (no subprocess, no PII).
// Exercises createAdapter({ mode: 'live' }) -> connector.call -> mocked runner
// -> normalizeShopifyOrder -> runCount, and verifies dedupe + counts hold up
// with synthetically generated GraphQL nodes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setRunner, resetRunner } = require('../src/connector');
const { createAdapter, UCS_PRODUCT_ID } = (() => {
  const s = require('../src/shopify');
  const p = require('../src/product');
  return { createAdapter: s.createAdapter, UCS_PRODUCT_ID: p.UCS_PRODUCT_ID };
})();
const { runCount } = require('../src/count');
const { normalizeAppstleSubscription } = require('../src/normalize');

function ucsLineItem(planName = 'Monthly', variantSeq = 1) {
  return {
    quantity: 1,
    currentQuantity: 1,
    refundableQuantity: 1,
    sellingPlan: { name: planName },
    product: { id: `gid://shopify/Product/${UCS_PRODUCT_ID}`, title: 'The Ultimate Cheese Subscription' },
    variant: { id: `gid://shopify/ProductVariant/${9000 + variantSeq}`, title: planName },
    customAttributes: [],
  };
}

function fakeOrder({ id, date, plan = 'Monthly', email, status = 'PAID', cancelledAt = null }) {
  return {
    id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    createdAt: `${date}T12:00:00Z`,
    processedAt: `${date}T12:00:00Z`,
    cancelledAt,
    displayFinancialStatus: status,
    displayFulfillmentStatus: 'FULFILLED',
    tags: ['appstle'],
    email,
    phone: null,
    customer: {
      id: `gid://shopify/Customer/${5000 + id}`,
      displayName: `Synth ${id}`,
      defaultEmailAddress: { emailAddress: email },
    },
    shippingAddress: { name: `Synth ${id}`, address1: `${id} Synth St`, city: 'Testville', provinceCode: 'NY', zip: '00000' },
    lineItems: { nodes: [ucsLineItem(plan, id)] },
  };
}

test('live ingestion: full path produces a final count with dedupe across buckets', async () => {
  // Two pages of synthetic orders.
  const pages = [
    {
      data: {
        orders: {
          pageInfo: { hasNextPage: true, endCursor: 'p1' },
          nodes: [
            fakeOrder({ id: 1, date: '2026-05-25', plan: 'Monthly', email: 'synth-1@example.test' }), // recurring billing
            fakeOrder({ id: 2, date: '2026-05-10', plan: 'Monthly', email: 'synth-2@example.test' }), // new-order window
          ],
        },
      },
    },
    {
      data: {
        orders: {
          pageInfo: { hasNextPage: false, endCursor: 'p2' },
          nodes: [
            fakeOrder({ id: 3, date: '2026-04-28', plan: 'Prepaid: 3 months', email: 'synth-3@example.test' }), // prepaid signup in window
            fakeOrder({ id: 4, date: '2026-03-10', plan: 'Monthly', email: 'synth-4@example.test' }), // outside any bucket
          ],
        },
      },
    },
  ];
  setRunner(async () => pages.shift());
  try {
    const adapter = createAdapter({ mode: 'live', pageSize: 50 });
    const orders = await adapter.fetchOrders({ since: '2026-04-26', until: '2026-05-25' });
    // Subscriptions: one prepaid sub matching order #3 (so the prepaid signup
    // shows in BOTH the new-order window AND prepaid coverage buckets and
    // gets deduped by subscription_id).
    const subscriptions = [
      normalizeAppstleSubscription({
        subscription_id: '', // GraphQL lineitem currently has no subscription_id link;
        customer_email: 'synth-3@example.test',
        status: 'active',
        product_id: UCS_PRODUCT_ID,
        product_name: 'The Ultimate Cheese Subscription',
        plan_name: 'Prepaid: 3 months',
        created_date: '2026-04-28',
        delivery_method: 'shipping',
      }),
    ];
    const report = runCount({
      subscriptions,
      orders,
      targetMonth: '2026-06',
      reportType: 'final',
    });
    assert.equal(report.target_box_month, '2026-06');
    // Order #1 (recurring billing), #2 (new-order recurring), #3 (new-order prepaid + prepaid coverage),
    // #4 outside. Final count after dedupe: 3 unique customers.
    assert.equal(report.counts.final_box_count, 3);
  } finally {
    resetRunner();
  }
});

test('live ingestion: errors from the connector are scrubbed before being thrown', async () => {
  setRunner(async () => {
    throw new Error('upstream 500 for customer synth-1@example.test order 1234567890 token shpat_ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  });
  try {
    const adapter = createAdapter({ mode: 'live' });
    await assert.rejects(
      () => adapter.fetchOrders({ since: '2026-04-26', until: '2026-05-25' }),
      (err) => {
        assert.equal(err.message.includes('synth-1@example.test'), false);
        assert.equal(err.message.includes('shpat_'), false);
        assert.equal(err.message.includes('1234567890'), false);
        return true;
      },
    );
  } finally {
    resetRunner();
  }
});

test('live ingestion: connector empty payload yields a clean error', async () => {
  setRunner(async () => ({}));
  try {
    const adapter = createAdapter({ mode: 'live' });
    await assert.rejects(
      () => adapter.fetchOrders({ since: '2026-04-26', until: '2026-05-25' }),
      /no orders payload|no orders payload|response was not JSON/,
    );
  } finally {
    resetRunner();
  }
});
