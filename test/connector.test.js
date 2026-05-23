'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { call, setRunner, resetRunner, unwrapResult } = require('../src/connector');

test('connector.call delegates to the injected runner', async () => {
  let seen;
  setRunner(async (payload) => {
    seen = payload;
    return { structure: JSON.stringify({ ok: true, value: 42 }) };
  });
  try {
    const r = await call({ source_id: 'shopify', tool_name: 'get-shop-info', arguments: {} });
    assert.deepEqual(r, { ok: true, value: 42 });
    assert.equal(seen.source_id, 'shopify');
  } finally {
    resetRunner();
  }
});

test('connector.call unwraps JSON string under wrapper keys', () => {
  const payload = { source_id: 'shopify', tool_name: 'graphql_query' };
  assert.deepEqual(unwrapResult({ structure: '{"data":{"orders":{}}}' }, payload), { data: { orders: {} } });
  assert.deepEqual(unwrapResult({ result: '{"a":1}' }, payload), { a: 1 });
  assert.deepEqual(unwrapResult({ output: '{"b":2}' }, payload), { b: 2 });
});

test('connector.call does NOT auto-unwrap a top-level `data` key (GraphQL passthrough)', () => {
  const payload = { source_id: 'shopify', tool_name: 'graphql_query' };
  // GraphQL responses look like { data: { orders: {...} }, errors: [...] }.
  // The caller needs the whole envelope, so we must not strip `data`.
  assert.deepEqual(unwrapResult({ data: { orders: { nodes: [] } } }, payload), { data: { orders: { nodes: [] } } });
});

test('connector.call rejects on empty / unparseable response', async () => {
  setRunner(async () => null);
  try {
    await assert.rejects(() => call({ source_id: 'shopify', tool_name: 'x' }), /empty response/);
  } finally {
    resetRunner();
  }
  setRunner(async () => ({ structure: 'not json' }));
  try {
    await assert.rejects(() => call({ source_id: 'shopify', tool_name: 'x' }), /not JSON/);
  } finally {
    resetRunner();
  }
});

test('connector.call surfaces error field without echoing PII body', async () => {
  setRunner(async () => ({ error: 'permission denied for shop' }));
  try {
    await assert.rejects(() => call({ source_id: 'shopify', tool_name: 'x' }), /permission denied/);
  } finally {
    resetRunner();
  }
});

test('connector.call validates payload shape', async () => {
  await assert.rejects(() => call(null), /payload must be an object/);
  await assert.rejects(() => call({ tool_name: 'x' }), /source_id is required/);
  await assert.rejects(() => call({ source_id: 'shopify' }), /tool_name is required/);
});
