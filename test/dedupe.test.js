'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dedupe } = require('../src/dedupe');

test('dedupes by subscription_id across buckets', () => {
  const entries = [
    { id: 'order:O1', subscription_id: 'S1', customer_email: 'a@b.com', source_bucket: 'recurring_billing' },
    { id: 'sub:S1', subscription_id: 'S1', customer_email: 'a@b.com', source_bucket: 'prepaid_coverage' },
  ];
  const { kept, removed } = dedupe(entries, '2026-06');
  assert.equal(kept.length, 1);
  assert.equal(removed.length, 1);
  assert.equal(kept[0].source_bucket, 'recurring_billing');
});

test('dedupes by shopify_customer_id + target_month when no subscription_id', () => {
  const entries = [
    { id: 'order:O1', shopify_customer_id: 'C1', customer_email: 'a@b.com', source_bucket: 'new_order_window' },
    { id: 'order:O2', shopify_customer_id: 'C1', customer_email: 'a@b.com', source_bucket: 'prepaid_coverage' },
  ];
  const { kept, removed } = dedupe(entries, '2026-06');
  assert.equal(kept.length, 1);
  assert.equal(removed.length, 1);
});

test('dedupes by email + target_month when no customer or subscription IDs', () => {
  const entries = [
    { id: 'order:O1', customer_email: 'a@b.com', source_bucket: 'new_order_window' },
    { id: 'order:O2', customer_email: 'a@b.com', source_bucket: 'prepaid_coverage' },
  ];
  const { kept, removed } = dedupe(entries, '2026-06');
  assert.equal(kept.length, 1);
  assert.equal(removed.length, 1);
});

test('does not collapse different customers in the same month', () => {
  const entries = [
    { id: 'order:O1', customer_email: 'a@b.com', source_bucket: 'recurring_billing' },
    { id: 'order:O2', customer_email: 'b@b.com', source_bucket: 'recurring_billing' },
  ];
  const { kept, removed } = dedupe(entries, '2026-06');
  assert.equal(kept.length, 2);
  assert.equal(removed.length, 0);
});
