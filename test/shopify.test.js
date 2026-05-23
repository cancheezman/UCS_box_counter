'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createAdapter, createLiveAdapter, gidToNumericId, buildOrdersQuery,
  normalizeGraphqlOrder, scrubConnectorError, REQUIRED_SCOPES, ORDERS_QUERY,
  MAX_PAGE_SIZE, extractSubscriptionIdFromAttrs,
} = require('../src/shopify');

test('fixture adapter is read-only and resolves locally', async () => {
  const adapter = createAdapter({ fixturePath: 'samples/shopify_orders.csv' });
  assert.equal(adapter.type, 'fixture');
  assert.equal(adapter.readOnly, true);
  const orders = await adapter.fetchOrders({});
  assert.ok(orders.length > 0);
});

test('live adapter advertises read-only intent and required scopes', () => {
  const adapter = createLiveAdapter({ connectorCall: async () => ({ data: { orders: { pageInfo: {}, nodes: [] } } }) });
  assert.equal(adapter.type, 'live');
  assert.equal(adapter.source, 'shopify');
  assert.equal(adapter.readOnly, true);
  // All required scopes are read-only.
  assert.deepEqual(adapter.requiredScopes, REQUIRED_SCOPES);
  for (const scope of adapter.requiredScopes) {
    assert.match(scope, /^read_/, `non-read scope listed: ${scope}`);
  }
});

test('live adapter does not store or expose any auth token', () => {
  // No auth argument is accepted at all — tokens live in the connector
  // layer, not in this adapter. Sanity-check by serializing.
  const adapter = createLiveAdapter({ connectorCall: async () => ({ data: { orders: { pageInfo: {}, nodes: [] } } }) });
  const serialized = JSON.stringify(adapter);
  assert.equal(serialized.includes('token'), false);
  assert.equal(serialized.includes('shpat_'), false);
});

test('gidToNumericId extracts trailing digits from GIDs', () => {
  assert.equal(gidToNumericId('gid://shopify/Product/7890199412991'), '7890199412991');
  assert.equal(gidToNumericId('gid://shopify/Order/5555555'), '5555555');
  assert.equal(gidToNumericId('not-a-gid'), '');
  assert.equal(gidToNumericId(''), '');
  assert.equal(gidToNumericId(null), '');
});

test('buildOrdersQuery composes Shopify search filter from a date window', () => {
  assert.equal(
    buildOrdersQuery({ since: '2026-04-26', until: '2026-05-25' }),
    'created_at:>=2026-04-26 created_at:<=2026-05-25',
  );
  assert.equal(buildOrdersQuery({}), '');
  assert.equal(buildOrdersQuery({ since: new Date(Date.UTC(2026, 4, 1)) }), 'created_at:>=2026-05-01');
});

test('normalizeGraphqlOrder: one node with one UCS line item -> one row', () => {
  const node = {
    id: 'gid://shopify/Order/100100',
    name: '#1001',
    createdAt: '2026-05-25T15:00:00Z',
    processedAt: '2026-05-25T15:00:01Z',
    cancelledAt: null,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'FULFILLED',
    tags: ['appstle', 'subscription'],
    email: 'syntho-1@example.test',
    phone: '+1 555-0100',
    customer: {
      id: 'gid://shopify/Customer/5001',
      displayName: 'Synthetic One',
      defaultEmailAddress: { emailAddress: 'syntho-1@example.test' },
      defaultPhoneNumber: { phoneNumber: '+1 555-0100' },
    },
    shippingAddress: {
      name: 'Synthetic One',
      address1: '100 Test Ave',
      address2: '',
      city: 'Testville',
      provinceCode: 'NY',
      zip: '00000',
      phone: '+1 555-0100',
    },
    lineItems: {
      nodes: [
        {
          id: 'gid://shopify/LineItem/77001',
          title: 'The Ultimate Cheese Subscription',
          name: 'The Ultimate Cheese Subscription - Monthly',
          quantity: 1,
          currentQuantity: 1,
          refundableQuantity: 1,
          sku: 'UCS-MO',
          variantTitle: 'Monthly',
          sellingPlan: { name: 'Monthly' },
          product: { id: 'gid://shopify/Product/7890199412991', title: 'The Ultimate Cheese Subscription' },
          variant: { id: 'gid://shopify/ProductVariant/9001', title: 'Monthly', sku: 'UCS-MO' },
          customAttributes: [{ key: 'note', value: 'do not echo me' }],
        },
      ],
    },
  };
  const rows = normalizeGraphqlOrder(node);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.order_id, '100100');
  assert.equal(r.order_date, '2026-05-25');
  assert.equal(r.product_id, '7890199412991');
  assert.equal(r.variant_id, '9001');
  assert.equal(r.product_name, 'The Ultimate Cheese Subscription');
  assert.equal(r.plan_name, 'Monthly');
  assert.equal(r.customer_id, '5001');
  assert.equal(r.financial_status, 'paid');
  assert.equal(r.fulfillment_status, 'fulfilled');
  assert.equal(r.customer_email, 'syntho-1@example.test');
  assert.equal(r.shipping_name, 'Synthetic One');
  assert.equal(r.city, 'Testville');
  assert.equal(r.province, 'NY');
  // customAttributes values are NOT echoed; only keys are summarized.
  assert.equal(r.tags.includes('do not echo me'), false);
  assert.match(r.tags, /note/);
});

test('extractSubscriptionIdFromAttrs: recognized keys are extracted, others ignored', () => {
  assert.equal(
    extractSubscriptionIdFromAttrs([{ key: 'subscription_id', value: 'APP-1001' }]),
    'APP-1001',
  );
  assert.equal(
    extractSubscriptionIdFromAttrs([{ key: 'Subscription ID', value: 'APP-1002' }]),
    'APP-1002',
  );
  assert.equal(
    extractSubscriptionIdFromAttrs([{ key: 'appstle_subscription_id', value: 'APP-1003' }]),
    'APP-1003',
  );
  assert.equal(
    extractSubscriptionIdFromAttrs([{ key: '_appstle_subscription_id', value: 'APP-1004' }]),
    'APP-1004',
  );
  assert.equal(
    extractSubscriptionIdFromAttrs([{ key: 'gift_note', value: 'happy birthday' }]),
    '',
  );
  // Mixed: pick the matching one, leave gift_note alone.
  assert.equal(
    extractSubscriptionIdFromAttrs([
      { key: 'gift_note', value: 'happy birthday' },
      { key: 'subscription_id', value: 'APP-1005' },
    ]),
    'APP-1005',
  );
});

test('extractSubscriptionIdFromAttrs: non-array / empty input is safe', () => {
  assert.equal(extractSubscriptionIdFromAttrs(null), '');
  assert.equal(extractSubscriptionIdFromAttrs(undefined), '');
  assert.equal(extractSubscriptionIdFromAttrs([]), '');
  assert.equal(extractSubscriptionIdFromAttrs([{ key: 'subscription_id', value: '' }]), '');
});

test('normalizeGraphqlOrder: subscription_id is recovered from customAttributes when present', () => {
  const node = {
    id: 'gid://shopify/Order/100400',
    createdAt: '2026-05-25T12:00:00Z',
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'FULFILLED',
    customer: { id: 'gid://shopify/Customer/5004' },
    shippingAddress: {},
    lineItems: {
      nodes: [
        {
          quantity: 1, currentQuantity: 1,
          sellingPlan: { name: 'Monthly' },
          product: { id: 'gid://shopify/Product/7890199412991', title: 'UCS' },
          variant: { id: 'gid://shopify/ProductVariant/9050' },
          customAttributes: [
            { key: 'gift_note', value: 'should-not-be-echoed' },
            { key: 'appstle_subscription_id', value: 'APP-7777' },
          ],
        },
      ],
    },
  };
  const rows = normalizeGraphqlOrder(node);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subscription_id, 'APP-7777');
  // Values must not be echoed in the tags summary.
  assert.equal(rows[0].tags.includes('should-not-be-echoed'), false);
  // Recognized subscription-id keys are stripped from the tags summary
  // so internal Appstle metadata doesn't sit next to operator-visible text.
  assert.equal(rows[0].tags.includes('appstle_subscription_id'), false);
  // Unknown keys are still summarized (key only, no value).
  assert.match(rows[0].tags, /gift_note/);
});

test('normalizeGraphqlOrder: subscription_id is empty when no recognized key is present', () => {
  const node = {
    id: 'gid://shopify/Order/100500',
    createdAt: '2026-05-25T12:00:00Z',
    displayFinancialStatus: 'PAID',
    customer: { id: 'gid://shopify/Customer/5005' },
    shippingAddress: {},
    lineItems: {
      nodes: [
        {
          quantity: 1, currentQuantity: 1,
          sellingPlan: { name: 'Monthly' },
          product: { id: 'gid://shopify/Product/7890199412991', title: 'UCS' },
          variant: { id: 'gid://shopify/ProductVariant/9060' },
          customAttributes: [{ key: 'note', value: 'just a note' }],
        },
      ],
    },
  };
  const rows = normalizeGraphqlOrder(node);
  assert.equal(rows[0].subscription_id, '');
});

test('normalizeGraphqlOrder: order with multiple line items emits one row per line item', () => {
  const node = {
    id: 'gid://shopify/Order/100200',
    createdAt: '2026-05-10T12:00:00Z',
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'FULFILLED',
    customer: { id: 'gid://shopify/Customer/5002' },
    shippingAddress: { provinceCode: 'NY' },
    lineItems: {
      nodes: [
        {
          quantity: 1, currentQuantity: 1,
          sellingPlan: { name: 'Prepaid: 3 months' },
          product: { id: 'gid://shopify/Product/7890199412991', title: 'UCS' },
          variant: { id: 'gid://shopify/ProductVariant/9002' },
        },
        {
          quantity: 1, currentQuantity: 1,
          product: { id: 'gid://shopify/Product/999', title: 'Cheese Knife' },
          variant: { id: 'gid://shopify/ProductVariant/9003' },
        },
      ],
    },
  };
  const rows = normalizeGraphqlOrder(node);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].plan_name, 'Prepaid: 3 months');
  assert.equal(rows[0].product_id, '7890199412991');
  assert.equal(rows[1].product_id, '999');
});

test('normalizeGraphqlOrder: refunded quantity flips refunded_amount heuristic', () => {
  const node = {
    id: 'gid://shopify/Order/100300',
    createdAt: '2026-05-10T12:00:00Z',
    displayFinancialStatus: 'PARTIALLY_REFUNDED',
    customer: {},
    shippingAddress: {},
    lineItems: {
      nodes: [
        {
          quantity: 2, currentQuantity: 1, refundableQuantity: 1,
          product: { id: 'gid://shopify/Product/7890199412991', title: 'UCS' },
          variant: { id: 'gid://shopify/ProductVariant/9004' },
        },
      ],
    },
  };
  const rows = normalizeGraphqlOrder(node);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 1);
  assert.equal(rows[0].refunded_amount, 1); // heuristic: currentQty < qty
});

test('live adapter: hitting maxPages while Shopify still has more results throws (no silent truncation)', async () => {
  // Connector always claims hasNextPage=true with a fresh cursor. The
  // adapter should bail out instead of returning the partial set it has.
  let cursor = 0;
  const fakeRunner = async () => ({
    data: {
      orders: {
        pageInfo: { hasNextPage: true, endCursor: `cursor-${++cursor}` },
        nodes: [makeFakeOrder(cursor)],
      },
    },
  });
  const adapter = createLiveAdapter({ connectorCall: fakeRunner, pageSize: 1, maxPages: 3 });
  await assert.rejects(
    () => adapter.fetchOrders({ since: '2026-04-26', until: '2026-05-26' }),
    (err) => {
      assert.match(err.message, /hit max page cap/);
      assert.match(err.message, /still has more results/);
      assert.match(err.message, /Refusing to return partial data/);
      return true;
    },
  );
});

test('live adapter: paginates using endCursor until hasNextPage=false', async () => {
  const pages = [
    {
      data: {
        orders: {
          pageInfo: { hasNextPage: true, endCursor: 'c1' },
          nodes: [makeFakeOrder(1)],
        },
      },
    },
    {
      data: {
        orders: {
          pageInfo: { hasNextPage: true, endCursor: 'c2' },
          nodes: [makeFakeOrder(2), makeFakeOrder(3)],
        },
      },
    },
    {
      data: {
        orders: {
          pageInfo: { hasNextPage: false, endCursor: 'c3' },
          nodes: [makeFakeOrder(4)],
        },
      },
    },
  ];
  const calls = [];
  const fakeRunner = async (payload) => {
    calls.push(payload);
    return pages.shift();
  };
  const adapter = createLiveAdapter({ connectorCall: fakeRunner, pageSize: 2 });
  const orders = await adapter.fetchOrders({ since: '2026-04-26', until: '2026-05-25' });
  assert.equal(orders.length, 4);
  assert.equal(calls.length, 3);
  // First page: after=null. Subsequent pages: after=<previous endCursor>.
  assert.equal(calls[0].arguments.variables.after, null);
  assert.equal(calls[1].arguments.variables.after, 'c1');
  assert.equal(calls[2].arguments.variables.after, 'c2');
  // Page size respected and capped.
  assert.equal(calls[0].arguments.variables.first, 2);
});

test('live adapter: passes the read-only GraphQL document through', async () => {
  let captured;
  const fakeRunner = async (payload) => {
    captured = payload;
    return { data: { orders: { pageInfo: { hasNextPage: false }, nodes: [] } } };
  };
  const adapter = createLiveAdapter({ connectorCall: fakeRunner });
  await adapter.fetchOrders({ since: '2026-04-26', until: '2026-05-25' });
  assert.equal(captured.source_id, 'shopify');
  assert.equal(captured.tool_name, 'graphql_query');
  assert.equal(captured.arguments.query, ORDERS_QUERY);
  assert.equal(
    captured.arguments.variables.query,
    'created_at:>=2026-04-26 created_at:<=2026-05-25',
  );
  assert.equal(captured.arguments.variables.first <= MAX_PAGE_SIZE, true);
});

test('live adapter: connector error is scrubbed (no tokens, no emails, no long IDs)', async () => {
  const fakeRunner = async () => {
    throw new Error(
      'connector failed for user alice@example.com with token shpat_ABCDEFGHIJKLMNOPQRSTUVWXYZ on order 1234567890',
    );
  };
  const adapter = createLiveAdapter({ connectorCall: fakeRunner });
  await assert.rejects(
    () => adapter.fetchOrders({ since: '2026-04-26', until: '2026-05-25' }),
    (err) => {
      assert.equal(err.message.includes('alice@example.com'), false);
      assert.equal(err.message.includes('shpat_'), false);
      assert.equal(err.message.includes('1234567890'), false);
      assert.match(err.message, /\[email\]/);
      assert.match(err.message, /\[redacted-token\]/);
      assert.match(err.message, /\[id\]/);
      return true;
    },
  );
});

test('live adapter: missing orders payload throws a clean error', async () => {
  const fakeRunner = async () => ({ data: {} });
  const adapter = createLiveAdapter({ connectorCall: fakeRunner });
  await assert.rejects(() => adapter.fetchOrders({ since: '2026-04-26', until: '2026-05-25' }), /no orders payload/);
});

test('scrubConnectorError removes shopify token shapes', () => {
  const e = new Error('Request failed: token=shpat_ABCDEFGHIJKLMNOPQRSTUVWX rejected');
  const scrubbed = scrubConnectorError(e);
  assert.equal(scrubbed.message.includes('shpat_'), false);
  assert.match(scrubbed.message, /\[redacted-token\]/);
});

function makeFakeOrder(i) {
  return {
    id: `gid://shopify/Order/${1000 + i}`,
    name: `#${1000 + i}`,
    createdAt: '2026-05-10T12:00:00Z',
    processedAt: '2026-05-10T12:00:00Z',
    cancelledAt: null,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'FULFILLED',
    tags: ['appstle'],
    email: `syntho-${i}@example.test`,
    phone: null,
    customer: {
      id: `gid://shopify/Customer/${5000 + i}`,
      displayName: `Synthetic ${i}`,
      defaultEmailAddress: { emailAddress: `syntho-${i}@example.test` },
    },
    shippingAddress: { name: `Synthetic ${i}`, address1: `${i} Test St`, city: 'Testville', provinceCode: 'NY', zip: '00000' },
    lineItems: {
      nodes: [
        {
          quantity: 1, currentQuantity: 1,
          sellingPlan: { name: 'Monthly' },
          product: { id: 'gid://shopify/Product/7890199412991', title: 'UCS' },
          variant: { id: `gid://shopify/ProductVariant/${9000 + i}` },
        },
      ],
    },
  };
}
