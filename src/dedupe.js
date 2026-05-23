'use strict';

// Deduplicate counted entries across buckets at target-box-month level.
//
// Priority order (per spec):
//   1. subscription_id
//   2. shopify_customer_id + target_month
//   3. customer_email + target_month
//   4. customer_email + product/plan + target_month

const { formatMonth } = require('./dates');

function targetKey(entry, targetMonthKey) {
  // Return an array of candidate keys in priority order.
  const keys = [];
  const tm = targetMonthKey || formatMonth(entry.target_month) || entry.target_box_month || '';
  const sub = entry.subscription_id ? String(entry.subscription_id).trim() : '';
  const cust = entry.shopify_customer_id ? String(entry.shopify_customer_id).trim() : '';
  const email = entry.customer_email ? String(entry.customer_email).trim().toLowerCase() : '';
  const product = entry.product_id ? String(entry.product_id).trim() : '';
  const plan = entry.plan_name ? String(entry.plan_name).trim().toLowerCase() : '';
  if (sub) keys.push(`sub:${sub}`);
  if (cust && tm) keys.push(`cust:${cust}|${tm}`);
  if (email && tm) keys.push(`email:${email}|${tm}`);
  if (email && tm) keys.push(`email-plan:${email}|${product}|${plan}|${tm}`);
  return keys;
}

/**
 * Deduplicate a list of count entries. Returns { kept, removed }.
 * Earlier entries (by input order) win; subsequent matches are recorded
 * as duplicates with a `duplicate_of` reference.
 *
 * Bucket priority for which entry "wins" (when input order is mixed): caller
 * should sort entries so that final-trumping buckets come first (e.g.
 * recurring billing > new orders > prepaid coverage). The default order
 * preserved here is input order.
 */
function dedupe(entries, targetMonthKey) {
  const seen = new Map(); // key -> entry
  const kept = [];
  const removed = [];
  for (const entry of entries) {
    const keys = targetKey(entry, targetMonthKey);
    let dupOf = null;
    for (const k of keys) {
      if (seen.has(k)) {
        dupOf = seen.get(k);
        break;
      }
    }
    if (dupOf) {
      removed.push({ ...entry, duplicate_of: dupOf.id || null, dedupe_key_hit: keys[0] || null });
      continue;
    }
    for (const k of keys) {
      if (!seen.has(k)) seen.set(k, entry);
    }
    kept.push(entry);
  }
  return { kept, removed };
}

module.exports = { dedupe, targetKey };
