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

test('same-email distinct plans stay separate (household with Monthly + 12-month prepaid)', () => {
  const entries = [
    { id: 'a', subscription_id: '', customer_email: 'shared@example.com', plan_name: 'Monthly',          product_id: '7890199412991', source_bucket: 'recurring_billing' },
    { id: 'b', subscription_id: '', customer_email: 'shared@example.com', plan_name: 'Prepaid: 3 months', product_id: '7890199412991', source_bucket: 'prepaid_coverage' },
  ];
  const { kept, removed } = dedupe(entries, '2026-06');
  assert.equal(kept.length, 2);
  assert.equal(removed.length, 0);
});

test('same-email same-plan still dedupes (one subscription appearing in two buckets)', () => {
  const entries = [
    { id: 'a', subscription_id: '', customer_email: 'one@example.com', plan_name: 'Monthly', product_id: '7890199412991', source_bucket: 'recurring_billing' },
    { id: 'b', subscription_id: '', customer_email: 'one@example.com', plan_name: 'Monthly', product_id: '7890199412991', source_bucket: 'prepaid_coverage' },
  ];
  const { kept, removed } = dedupe(entries, '2026-06');
  assert.equal(kept.length, 1);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].dedupe_key_hit && removed[0].dedupe_key_hit.startsWith('email-plan:'), true);
});

test('subscription_id always wins over email keys', () => {
  // Two entries with the SAME subscription_id but different emails (unusual
  // but possible if an email was updated mid-month): they MUST dedupe.
  const entries = [
    { id: 'a', subscription_id: 'S1', customer_email: 'old@example.com', plan_name: 'Monthly', source_bucket: 'recurring_billing' },
    { id: 'b', subscription_id: 'S1', customer_email: 'new@example.com', plan_name: 'Monthly', source_bucket: 'prepaid_coverage' },
  ];
  const { kept, removed } = dedupe(entries, '2026-06');
  assert.equal(kept.length, 1);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].dedupe_key_hit, 'sub:S1');
});

test('bare email key is used only when neither plan nor product is known', () => {
  // Two rows with same email and no plan/product info: should collapse.
  const entries = [
    { id: 'a', customer_email: 'noinfo@example.com', source_bucket: 'recurring_billing' },
    { id: 'b', customer_email: 'noinfo@example.com', source_bucket: 'prepaid_coverage' },
  ];
  const { kept, removed } = dedupe(entries, '2026-06');
  assert.equal(kept.length, 1);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].dedupe_key_hit, 'email:noinfo@example.com|2026-06');
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
