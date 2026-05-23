'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseOverrides,
  loadOverridesFromFile,
  indexOverrides,
  findOverride,
} = require('../src/overrides');

const SAMPLE_CSV = `customer_email,subscription_id,shopify_order_id,target_box_month,override_action,reason
alice@example.com,S100,,2026-09,include,Pulled into September pack per customer
,S200,,2026-10,exclude,Customer requested skip
bob@example.com,,O500,2026-09,include,Late order, accept
,,,2026-09,include,Missing identifier — should be dropped
carol@example.com,,,2026-09,bogus,Invalid action
carol@example.com,,,not-a-date,include,Invalid month
`;

test('parseOverrides accepts include + exclude rows with reasons', () => {
  const { overrides, warnings } = parseOverrides(SAMPLE_CSV);
  assert.equal(overrides.length, 3, 'should accept the three valid rows');
  // Warnings for the bad rows (missing identifier, invalid action, invalid month).
  const codes = warnings.map((w) => w.code).sort();
  assert.deepEqual(codes.sort(), [
    'override_invalid_action',
    'override_invalid_target_box_month',
    'override_missing_identifier',
  ].sort());
});

test('indexOverrides keys by subscription_id, order_id, and email+month', () => {
  const { overrides } = parseOverrides(SAMPLE_CSV);
  const idx = indexOverrides(overrides);
  assert.ok(idx.bySubscription.has('S100'));
  assert.ok(idx.bySubscription.has('S200'));
  assert.ok(idx.byOrder.has('O500'));
  assert.ok(idx.byEmailAndMonth.has('alice@example.com|2026-09'));
});

test('findOverride prefers subscription_id over order_id', () => {
  const { overrides } = parseOverrides(SAMPLE_CSV);
  const idx = indexOverrides(overrides);
  const m = findOverride(
    { subscription_id: 'S100', shopify_order_id: 'O500', customer_email: 'bob@example.com', target_box_month: '2026-09' },
    idx
  );
  assert.equal(m.subscription_id, 'S100');
});

test('findOverride falls back to order_id, then email+month', () => {
  const { overrides } = parseOverrides(SAMPLE_CSV);
  const idx = indexOverrides(overrides);
  // Order match (no sub_id provided).
  const byOrder = findOverride(
    { subscription_id: '', shopify_order_id: 'O500', customer_email: '', target_box_month: '2026-09' },
    idx
  );
  assert.equal(byOrder.shopify_order_id, 'O500');
  // Email+month match (no sub_id, no order_id).
  const byEmail = findOverride(
    { subscription_id: '', shopify_order_id: '', customer_email: 'alice@example.com', target_box_month: '2026-09' },
    idx
  );
  assert.equal(byEmail.subscription_id, 'S100');
});

test('findOverride returns null when nothing matches', () => {
  const { overrides } = parseOverrides(SAMPLE_CSV);
  const idx = indexOverrides(overrides);
  const m = findOverride(
    { subscription_id: 'NOPE', shopify_order_id: 'NOPE', customer_email: 'nope@example.com', target_box_month: '2026-09' },
    idx
  );
  assert.equal(m, null);
});

test('loadOverridesFromFile reads a file from disk', () => {
  const tmp = path.join(os.tmpdir(), `ucs-overrides-${Date.now()}.csv`);
  fs.writeFileSync(tmp, SAMPLE_CSV, 'utf8');
  try {
    const { overrides } = loadOverridesFromFile(tmp);
    assert.equal(overrides.length, 3);
  } finally {
    fs.unlinkSync(tmp);
  }
});
