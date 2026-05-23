'use strict';

// Manual overrides for first-box-month attribution.
//
// CSV columns (header names accepted in either snake_case or Title Case):
//
//   customer_email
//   subscription_id
//   shopify_order_id
//   target_box_month     YYYY-MM
//   override_action      'include' | 'exclude'
//   reason               free-text, optional
//
// Match priority (per spec):
//   1. subscription_id
//   2. shopify_order_id
//   3. customer_email + target_box_month
//
// Semantics:
//   - `include`: attribute the matched record to `target_box_month`, even
//     if the schedule-aware gray-zone rule would otherwise default it to
//     a later month.
//   - `exclude`: drop the matched record from `target_box_month` (e.g.
//     because it has been confirmed to belong elsewhere, was a duplicate
//     paper order, or the customer asked to skip). The dropped record is
//     still surfaced for review.

const fs = require('fs');
const { parseObjects } = require('./csv');
const { pick } = require('./normalize');

const VALID_ACTIONS = new Set(['include', 'exclude']);

function normalizeRow(row) {
  const customer_email = pick(row, ['customer_email', 'Customer Email', 'email', 'Email']).toLowerCase();
  const subscription_id = pick(row, ['subscription_id', 'Subscription ID', 'Subscription Id']);
  const shopify_order_id = pick(row, ['shopify_order_id', 'Shopify Order ID', 'order_id', 'Order ID']);
  const target_box_month = pick(row, ['target_box_month', 'Target Box Month', 'box_month', 'Box Month']);
  const override_action = pick(row, ['override_action', 'Override Action', 'action', 'Action']).toLowerCase();
  const reason = pick(row, ['reason', 'Reason', 'notes', 'Notes']);
  return { customer_email, subscription_id, shopify_order_id, target_box_month, override_action, reason };
}

/**
 * Load overrides from a CSV file path. Returns an array of override
 * records and a parallel array of parse-time warnings (rows that were
 * malformed in some way are skipped, with a warning entry).
 *
 * @param {string} path
 * @returns {{ overrides: Array, warnings: Array }}
 */
function loadOverridesFromFile(path) {
  const text = fs.readFileSync(path, 'utf8');
  return parseOverrides(text);
}

function parseOverrides(text) {
  const rows = parseObjects(text || '');
  const overrides = [];
  const warnings = [];
  for (let i = 0; i < rows.length; i += 1) {
    const raw = rows[i];
    const normalized = normalizeRow(raw);
    if (!normalized.override_action) {
      warnings.push({ code: 'override_missing_action', row_index: i + 2 });
      continue;
    }
    if (!VALID_ACTIONS.has(normalized.override_action)) {
      warnings.push({
        code: 'override_invalid_action',
        row_index: i + 2,
        override_action: normalized.override_action,
      });
      continue;
    }
    if (!normalized.target_box_month || !/^\d{4}-\d{2}$/.test(normalized.target_box_month)) {
      warnings.push({ code: 'override_invalid_target_box_month', row_index: i + 2 });
      continue;
    }
    if (!normalized.subscription_id && !normalized.shopify_order_id && !normalized.customer_email) {
      warnings.push({ code: 'override_missing_identifier', row_index: i + 2 });
      continue;
    }
    overrides.push(normalized);
  }
  return { overrides, warnings };
}

/**
 * Build an index of overrides keyed by (subscription_id), (shopify_order_id),
 * and (email + target_box_month). Each value is the underlying override
 * record. Later overrides with the same key replace earlier ones (last write
 * wins) so operators can patch a previous override by appending a new row.
 */
function indexOverrides(overrides) {
  const bySubscription = new Map();
  const byOrder = new Map();
  const byEmailAndMonth = new Map();
  for (const o of overrides || []) {
    if (o.subscription_id) bySubscription.set(String(o.subscription_id), o);
    if (o.shopify_order_id) byOrder.set(String(o.shopify_order_id), o);
    if (o.customer_email && o.target_box_month) {
      byEmailAndMonth.set(`${o.customer_email}|${o.target_box_month}`, o);
    }
  }
  return { bySubscription, byOrder, byEmailAndMonth };
}

/**
 * Look up the override that matches a given attribution record, if any.
 *
 * @param {Object} attribution - { subscription_id, shopify_order_id,
 *                                 customer_email, target_box_month }
 * @param {ReturnType<typeof indexOverrides>} index
 * @returns {Object|null} the matched override row, or null.
 */
function findOverride(attribution, index) {
  if (!attribution || !index) return null;
  const sub = attribution.subscription_id ? String(attribution.subscription_id) : '';
  if (sub && index.bySubscription.has(sub)) return index.bySubscription.get(sub);
  const ord = attribution.shopify_order_id ? String(attribution.shopify_order_id) : '';
  if (ord && index.byOrder.has(ord)) return index.byOrder.get(ord);
  const email = attribution.customer_email ? String(attribution.customer_email).toLowerCase() : '';
  const month = attribution.target_box_month ? String(attribution.target_box_month) : '';
  if (email && month) {
    const k = `${email}|${month}`;
    if (index.byEmailAndMonth.has(k)) return index.byEmailAndMonth.get(k);
  }
  return null;
}

module.exports = {
  parseOverrides,
  loadOverridesFromFile,
  indexOverrides,
  findOverride,
  VALID_ACTIONS,
};
