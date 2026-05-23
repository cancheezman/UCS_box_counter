'use strict';

// Review flags / warnings emitted alongside the count. We never silently
// drop an edge case; the warning system is the audit trail.
//
// Privacy contract:
//   - Each warning has a `message` (human-readable) and a structured
//     `context` (subscription_id, order_id, customer_email, …).
//   - `message` is mask-safe: identifiers and emails are obfuscated using
//     src/privacy.js. The `message` is safe to log to the console, paste
//     into chat, or screenshot.
//   - `context` keeps full values so the operator can reconcile against
//     Appstle / Shopify when working from the JSON summary file. The
//     JSON file lives next to the CSV — both are sensitive outputs and
//     should be handled per PRIVACY.md retention guidance.

const { maskEmail, maskId } = require('./privacy');

const WARNING_CODES = {
  PLAN_LENGTH_UNKNOWN: 'plan_length_unknown',
  PREPAID_HAS_NEXT_ORDER: 'prepaid_has_next_order_date',
  ACTIVE_NO_FUTURE_CHARGE_NO_PREPAID: 'active_no_future_charge_no_prepaid',
  EMAIL_MISSING: 'customer_email_missing',
  MULTI_SUBS_SAME_EMAIL: 'multiple_subscriptions_same_email',
  ORDER_PARTIALLY_REFUNDED: 'order_partially_refunded',
  PAUSED_BUT_PAID_FOR_TARGET: 'paused_but_paid_for_target_month',
  CANCELLED_AFTER_PAYING_TARGET: 'cancelled_after_paying_for_target',
  PRODUCT_ID_MISMATCH_NAME_LOOKS_UCS: 'product_id_mismatch_name_looks_ucs',
  DELIVERY_METHOD_MISSING: 'delivery_method_missing',
};

function warn(list, code, message, context = {}) {
  list.push({ code, message, ...context });
}

function subRef(sub) {
  return `subscription ${maskId(sub.subscription_id)}`;
}

function orderRef(o) {
  return `order ${maskId(o.order_id)}`;
}

/**
 * Run subscription-level checks against the normalized Appstle export.
 * Mutates `warnings` and returns it.
 */
function checkSubscriptions(subscriptions, cycle, warnings = []) {
  const byEmail = new Map();
  for (const sub of subscriptions) {
    if (!sub) continue;
    if (sub.ucs_match_method === 'name' && /UCS|Ultimate Cheese/i.test(sub.product_name || '')) {
      warn(warnings, WARNING_CODES.PRODUCT_ID_MISMATCH_NAME_LOOKS_UCS,
        `${subRef(sub)}: product_id ${maskId(sub.product_id)} does not match expected UCS product_id, but product name looks UCS-like.`,
        { subscription_id: sub.subscription_id, customer_email: sub.customer_email, product_id: sub.product_id, product_name: sub.product_name });
    } else if (!sub.is_ucs && /UCS|Ultimate Cheese/i.test(sub.product_name || '')) {
      warn(warnings, WARNING_CODES.PRODUCT_ID_MISMATCH_NAME_LOOKS_UCS,
        `${subRef(sub)}: product_id ${maskId(sub.product_id)} does not match UCS but product name looks UCS-like.`,
        { subscription_id: sub.subscription_id, customer_email: sub.customer_email, product_id: sub.product_id, product_name: sub.product_name });
    }
    if (!sub.is_ucs) continue; // only flag UCS rows beyond here

    if (!sub.customer_email) {
      warn(warnings, WARNING_CODES.EMAIL_MISSING,
        `${subRef(sub)}: customer email missing.`,
        { subscription_id: sub.subscription_id });
    } else {
      const list = byEmail.get(sub.customer_email) || [];
      list.push(sub.subscription_id);
      byEmail.set(sub.customer_email, list);
    }

    if (sub.is_prepaid && sub.next_order_date) {
      warn(warnings, WARNING_CODES.PREPAID_HAS_NEXT_ORDER,
        `${subRef(sub)}: prepaid plan has a Next Order Date (${sub.next_order_date.toISOString().slice(0, 10)}).`,
        { subscription_id: sub.subscription_id, next_order_date: sub.next_order_date.toISOString().slice(0, 10) });
    }

    if (sub.is_prepaid && !sub.plan_length) {
      warn(warnings, WARNING_CODES.PLAN_LENGTH_UNKNOWN,
        `${subRef(sub)}: prepaid plan length could not be determined.`,
        { subscription_id: sub.subscription_id, plan_name: sub.plan_name });
    }

    if (sub.status === 'active' && !sub.next_order_date && !sub.is_prepaid) {
      warn(warnings, WARNING_CODES.ACTIVE_NO_FUTURE_CHARGE_NO_PREPAID,
        `${subRef(sub)}: active with no next order date and no prepaid entitlement.`,
        { subscription_id: sub.subscription_id });
    }

    if (sub.is_ucs && !sub.delivery_method) {
      warn(warnings, WARNING_CODES.DELIVERY_METHOD_MISSING,
        `${subRef(sub)}: delivery method missing.`,
        { subscription_id: sub.subscription_id });
    }
  }
  for (const [email, ids] of byEmail.entries()) {
    if (ids.length > 1) {
      warn(warnings, WARNING_CODES.MULTI_SUBS_SAME_EMAIL,
        `Customer ${maskEmail(email)} has ${ids.length} UCS subscriptions: ${ids.map(maskId).join(', ')}.`,
        { customer_email: email, subscription_ids: ids });
    }
  }
  return warnings;
}

/**
 * Run order-level checks. Cross-references subscription pause/cancel state
 * for paused-but-paid and cancelled-after-paying flags.
 */
function checkOrders(orders, subscriptions, cycle, warnings = []) {
  const subById = new Map();
  for (const s of subscriptions || []) {
    if (s && s.subscription_id) subById.set(String(s.subscription_id), s);
  }
  for (const o of orders) {
    if (!o) continue;
    if (o.ucs_match_method === 'name' && /UCS|Ultimate Cheese/i.test(o.product_name || '')) {
      warn(warnings, WARNING_CODES.PRODUCT_ID_MISMATCH_NAME_LOOKS_UCS,
        `${orderRef(o)}: product_id ${maskId(o.product_id)} does not match expected UCS product_id, but product name looks UCS-like.`,
        { order_id: o.order_id, customer_email: o.customer_email, product_id: o.product_id, product_name: o.product_name });
    } else if (!o.is_ucs && /UCS|Ultimate Cheese/i.test(o.product_name || '')) {
      warn(warnings, WARNING_CODES.PRODUCT_ID_MISMATCH_NAME_LOOKS_UCS,
        `${orderRef(o)}: product_id ${maskId(o.product_id)} does not match UCS but product name looks UCS-like.`,
        { order_id: o.order_id, customer_email: o.customer_email, product_id: o.product_id, product_name: o.product_name });
    }
    if (!o.is_ucs) continue;
    if (!o.customer_email) {
      warn(warnings, WARNING_CODES.EMAIL_MISSING,
        `${orderRef(o)}: customer email missing.`,
        { order_id: o.order_id });
    }
    if (o.partially_refunded) {
      warn(warnings, WARNING_CODES.ORDER_PARTIALLY_REFUNDED,
        `${orderRef(o)}: partially refunded.`,
        { order_id: o.order_id, customer_email: o.customer_email, refunded_amount: o.refunded_amount, total: o.total });
    }
    if (!o.delivery_method) {
      warn(warnings, WARNING_CODES.DELIVERY_METHOD_MISSING,
        `${orderRef(o)}: delivery method missing.`,
        { order_id: o.order_id });
    }
    const sub = o.subscription_id ? subById.get(String(o.subscription_id)) : null;
    if (sub) {
      if (sub.status === 'paused' && o.is_paid && !o.fully_refunded) {
        warn(warnings, WARNING_CODES.PAUSED_BUT_PAID_FOR_TARGET,
          `${subRef(sub)} is paused but has paid ${orderRef(o)}.`,
          { subscription_id: sub.subscription_id, order_id: o.order_id });
      }
      if (
        sub.status === 'cancelled' &&
        sub.cancellation_date &&
        o.order_date &&
        sub.cancellation_date.getTime() > o.order_date.getTime() &&
        o.is_paid && !o.fully_refunded
      ) {
        warn(warnings, WARNING_CODES.CANCELLED_AFTER_PAYING_TARGET,
          `${subRef(sub)} cancelled after paying for ${orderRef(o)}.`,
          { subscription_id: sub.subscription_id, order_id: o.order_id });
      }
    }
  }
  return warnings;
}

module.exports = {
  WARNING_CODES,
  checkSubscriptions,
  checkOrders,
};
