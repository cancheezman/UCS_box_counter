'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdapter, createLiveAdapter, scrubAuthFromError } = require('../src/shopify');

test('fixture adapter is read-only and resolves locally', async () => {
  const adapter = createAdapter({ fixturePath: 'samples/shopify_orders.csv' });
  assert.equal(adapter.type, 'fixture');
  assert.equal(adapter.readOnly, true);
  const orders = await adapter.fetchOrders({});
  assert.ok(orders.length > 0);
});

test('live adapter without credentials throws a clear error', async () => {
  const adapter = createLiveAdapter({});
  assert.equal(adapter.type, 'live');
  assert.equal(adapter.readOnly, true);
  assert.deepEqual(adapter.requiredScopes, ['read_orders', 'read_products']);
  assert.equal(adapter.hasAuth, false);
  await assert.rejects(() => adapter.fetchOrders({}), /not configured/);
});

test('live adapter never exposes the auth token on the returned object', () => {
  const adapter = createLiveAdapter({ accessToken: 'shpat_supersecrettokenvalue1234567890' });
  // hasAuth is the only signal; the token itself must not be enumerable.
  assert.equal(adapter.hasAuth, true);
  const serialized = JSON.stringify(adapter);
  assert.equal(serialized.includes('shpat_'), false);
  assert.equal(serialized.includes('supersecret'), false);
  // No property should be the token, regardless of name.
  for (const key of Object.keys(adapter)) {
    const v = adapter[key];
    if (typeof v === 'string') {
      assert.equal(v.includes('supersecret'), false, `token leaked via property ${key}`);
    }
  }
});

test('live adapter scrubs auth-shaped substrings from errors', async () => {
  const adapter = createLiveAdapter({ accessToken: 'shpat_supersecrettokenvalue1234567890' });
  await assert.rejects(
    () => adapter.fetchOrders({}),
    (err) => {
      assert.equal(err.message.includes('supersecret'), false);
      assert.equal(err.message.includes('shpat_'), false);
      assert.match(err.message, /not yet implemented|redacted-token/);
      return true;
    },
  );
});

test('scrubAuthFromError removes shopify token shapes even when not handed the literal value', () => {
  const e = new Error('Request failed: token=shpat_ABCDEFGHIJKLMNOPQRSTUVWX rejected');
  const scrubbed = scrubAuthFromError(e, '');
  assert.equal(scrubbed.message.includes('shpat_'), false);
  assert.match(scrubbed.message, /\[redacted-token\]/);
});
