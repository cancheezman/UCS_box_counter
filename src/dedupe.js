'use strict';

// Deduplicate counted entries across buckets at target-box-month level.
//
// Priority order (per spec): try the most specific identifier first; if
// it's not available, fall back to the next.
//
//   1. subscription_id                                 (strongest)
//   2. shopify_customer_id + target_month
//   3. customer_email + product/plan + target_month
//   4. customer_email + target_month                   (loosest fallback)
//
// IMPORTANT: only ONE bucket of fallback keys is used per entry. If an
// entry carries an email AND a plan/product, we use the plan-aware key
// — never the bare email — so two distinct UCS subscriptions sharing an
// email (e.g. a Monthly recurring and a 12-month prepaid on the same
// household account) do NOT collapse to a single box. The bare email
// key is only emitted when no plan/product disambiguator exists.
//
// Two entries dedupe iff any of their respective keys collide.

const { formatMonth } = require('./dates');

function trimLower(v) {
  return v ? String(v).trim().toLowerCase() : '';
}

/**
 * Build the ordered list of candidate dedupe keys for one entry.
 *
 * - We always include the strongest available identifier (subscription_id).
 * - For the email-based fallback, we pick exactly ONE of:
 *     (a) "email-plan:<email>|<product>|<plan>|<month>" when there is any
 *         plan or product info, OR
 *     (b) "email:<email>|<month>" when neither plan nor product is known.
 *   We do NOT push both, because that would let the bare-email key collide
 *   with a different-plan entry first (the bug this design replaces).
 */
function targetKey(entry, targetMonthKey) {
  const keys = [];
  const tm = targetMonthKey || formatMonth(entry.target_month) || entry.target_box_month || '';
  const sub = entry.subscription_id ? String(entry.subscription_id).trim() : '';
  const cust = entry.shopify_customer_id ? String(entry.shopify_customer_id).trim() : '';
  const email = trimLower(entry.customer_email);
  const product = entry.product_id ? String(entry.product_id).trim() : '';
  const plan = trimLower(entry.plan_name);

  if (sub) keys.push(`sub:${sub}`);
  if (cust && tm) keys.push(`cust:${cust}|${tm}`);
  if (email && tm) {
    const hasPlanInfo = Boolean(product || plan);
    if (hasPlanInfo) {
      keys.push(`email-plan:${email}|${product}|${plan}|${tm}`);
    } else {
      keys.push(`email:${email}|${tm}`);
    }
  }
  return keys;
}

/**
 * Deduplicate a list of count entries. Returns { kept, removed }.
 * Earlier entries (by input order) win; subsequent matches are recorded
 * as duplicates with a `duplicate_of` reference.
 *
 * The caller should sort entries so that authoritative buckets come first
 * (recurring billing > new orders > prepaid coverage). The default order
 * preserved here is input order.
 */
function dedupe(entries, targetMonthKey) {
  const seen = new Map(); // key -> entry
  const kept = [];
  const removed = [];
  for (const entry of entries) {
    const keys = targetKey(entry, targetMonthKey);
    let dupOf = null;
    let hitKey = null;
    for (const k of keys) {
      if (seen.has(k)) {
        dupOf = seen.get(k);
        hitKey = k;
        break;
      }
    }
    if (dupOf) {
      removed.push({ ...entry, duplicate_of: dupOf.id || null, dedupe_key_hit: hitKey });
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
