'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCsv, buildJson, buildMarkdown, CSV_COLUMNS } = require('../src/report');
const { runCount } = require('../src/count');
const { normalizeShopifyOrder } = require('../src/normalize');
const { UCS_PRODUCT_ID } = require('../src/product');

function fixture() {
  const orders = [
    normalizeShopifyOrder({
      order_id: 'O1', customer_name: 'Alice', customer_email: 'a@b.com',
      product_id: UCS_PRODUCT_ID, product_name: 'The Ultimate Cheese Subscription',
      plan_name: 'Monthly', order_date: '2026-05-25', financial_status: 'paid',
      fulfillment_status: 'fulfilled', delivery_method: 'shipping',
      shipping_name: 'Alice', shipping_address_1: '1 Main', city: 'Brooklyn',
      province: 'NY', postal_code: '11201', phone: '555-0100',
    }),
  ];
  return runCount({ subscriptions: [], orders, targetMonth: '2026-06', reportType: 'final' });
}

test('CSV starts with UTF-8 BOM', () => {
  const csv = buildCsv(fixture());
  assert.equal(csv.charCodeAt(0), 0xfeff);
});

test('CSV header lists the spec columns in order', () => {
  const csv = buildCsv(fixture());
  const stripped = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
  const firstLine = stripped.split(/\r?\n/, 1)[0];
  assert.equal(firstLine, CSV_COLUMNS.join(','));
});

test('CSV has one data row per counted box', () => {
  const csv = buildCsv(fixture());
  const stripped = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
  const lines = stripped.split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 2); // header + 1 row
});

test('CSV row contains expected target_box_month and source_bucket', () => {
  const csv = buildCsv(fixture());
  assert.match(csv, /2026-06/);
  assert.match(csv, /recurring_billing/);
});

test('Markdown summary uses estimate language for estimate report', () => {
  const r = { ...fixture(), report_type: 'estimate' };
  const md = buildMarkdown(r);
  assert.match(md, /This is an estimate/);
});

test('Markdown summary uses final language for final report', () => {
  const md = buildMarkdown(fixture());
  assert.match(md, /final pack count/);
});

test('JSON summary is valid JSON and contains counts', () => {
  const json = JSON.parse(buildJson(fixture()));
  assert.equal(json.report_type, 'final');
  assert.equal(json.target_box_month, '2026-06');
  assert.ok(json.counts && typeof json.counts.final_box_count === 'number');
});
