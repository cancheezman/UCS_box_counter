'use strict';

// Normalize raw rows from Appstle CSV exports and Shopify/Appstle order
// exports into a stable internal shape. Appstle headers vary by account and
// export version; we accept many synonyms.
//
// Data minimization: we deliberately do NOT retain the full raw input row on
// each normalized record. Only fields used downstream (counting, dedupe,
// delivery, eligibility, warnings, CSV output) are kept. If you need a field
// that isn't here, add it to the picker explicitly rather than re-introducing
// a `raw` passthrough — that is how PII sprawl creeps in.

const { parseDate, formatDate } = require('./dates');
const { parsePlan } = require('./prepaid');
const { matchUcs } = require('./product');

function pick(row, keys) {
  for (const key of keys) {
    if (!row) continue;
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      const v = row[key];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    // Try case-insensitive match too.
    const lower = key.toLowerCase();
    for (const k of Object.keys(row)) {
      if (k.toLowerCase() === lower) {
        const v = row[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      }
    }
  }
  return '';
}

function safeParseDate(s) {
  if (!s) return null;
  try {
    return parseDate(s);
  } catch (_err) {
    return null;
  }
}

function normalizeStatus(s) {
  if (!s) return '';
  const v = String(s).trim().toLowerCase();
  if (!v) return '';
  if (/active/.test(v)) return 'active';
  if (/cancel/.test(v)) return 'cancelled';
  if (/pause/.test(v)) return 'paused';
  if (/expire|complete|finished/.test(v)) return 'completed';
  return v;
}

function normalizeAppstleSubscription(row) {
  const subscription_id = pick(row, [
    'subscription_id', 'Subscription ID', 'Subscription Id', 'subscriptionId', 'id', 'ID',
  ]);
  const customer_name = pick(row, [
    'customer_name', 'Customer Name', 'Customer', 'name',
  ]) || `${pick(row, ['first_name', 'First Name'])} ${pick(row, ['last_name', 'Last Name'])}`.trim();
  const customer_email = pick(row, [
    'customer_email', 'Customer Email', 'email', 'Email',
  ]).toLowerCase();
  const status_raw = pick(row, ['status', 'Status', 'Subscription Status']);
  const status = normalizeStatus(status_raw);
  const product_id = pick(row, [
    'product_id', 'Product ID', 'Product Id', 'productId',
  ]);
  const product_name = pick(row, [
    'product_name', 'Product Name', 'Product', 'product',
  ]);
  const plan_name = pick(row, [
    'plan_name', 'Plan Name', 'Selling Plan', 'Selling Plan Name', 'plan',
  ]);
  const created_date_s = pick(row, [
    'created_date', 'Created Date', 'Created', 'created_at', 'Created At', 'Start Date',
  ]);
  const next_order_date_s = pick(row, [
    'next_order_date', 'Next Order Date', 'Next Charge Date', 'next_charge_date',
  ]);
  const delivery_method = pick(row, [
    'delivery_method', 'Delivery Method', 'Shipping Method', 'shipping_method',
  ]);
  const processed_order_count_s = pick(row, [
    'processed_order_count', 'Processed Order Count', 'Order Count', 'order_count',
  ]);
  const revenue_s = pick(row, ['revenue', 'Revenue', 'total_revenue']);
  const cancellation_date_s = pick(row, [
    'cancellation_date', 'Cancellation Date', 'cancelled_at', 'Cancelled At',
  ]);
  const paused_at_s = pick(row, ['paused_at', 'Paused At', 'pause_date', 'Pause Date']);
  const shipping_name = pick(row, ['shipping_name', 'Shipping Name', 'Ship To Name']);
  const shipping_address_1 = pick(row, ['shipping_address_1', 'Shipping Address 1', 'Address 1']);
  const shipping_address_2 = pick(row, ['shipping_address_2', 'Shipping Address 2', 'Address 2']);
  const city = pick(row, ['city', 'City', 'Shipping City']);
  const province = pick(row, ['province', 'Province', 'State', 'Shipping Province']);
  const postal_code = pick(row, ['postal_code', 'Postal Code', 'Zip', 'Shipping Postal Code']);
  const phone = pick(row, ['phone', 'Phone', 'Shipping Phone']);

  const plan = parsePlan(plan_name);
  const product_match = matchUcs({ productId: product_id, productName: product_name });

  return {
    source: 'appstle_subscription',
    subscription_id,
    customer_name,
    customer_email,
    status,
    status_raw,
    product_id,
    product_name,
    plan_name,
    is_prepaid: plan.isPrepaid,
    plan_length: plan.length,
    created_date: safeParseDate(created_date_s),
    next_order_date: safeParseDate(next_order_date_s),
    cancellation_date: safeParseDate(cancellation_date_s),
    paused_at: safeParseDate(paused_at_s),
    delivery_method,
    processed_order_count: processed_order_count_s ? Number(processed_order_count_s) : null,
    revenue: revenue_s ? Number(revenue_s) : null,
    shipping_name,
    shipping_address_1,
    shipping_address_2,
    city,
    province,
    postal_code,
    phone,
    is_ucs: product_match.match,
    ucs_match_method: product_match.method,
  };
}

function normalizeFinancialStatus(s) {
  if (!s) return '';
  const v = String(s).trim().toLowerCase();
  return v;
}

function normalizeFulfillmentStatus(s) {
  if (!s) return '';
  return String(s).trim().toLowerCase();
}

function normalizeShopifyOrder(row) {
  const order_id = pick(row, ['order_id', 'Order ID', 'id', 'name', 'Name', 'Order Name']);
  const order_date = safeParseDate(pick(row, [
    'order_date', 'Order Date', 'created_at', 'Created At', 'Processed At', 'processed_at',
  ]));
  const customer_name = pick(row, ['customer_name', 'Customer Name', 'Billing Name', 'Shipping Name']);
  const customer_email = pick(row, ['customer_email', 'Customer Email', 'Email', 'email']).toLowerCase();
  const customer_id = pick(row, ['customer_id', 'Customer ID', 'shopify_customer_id']);
  const product_id = pick(row, ['product_id', 'Product ID', 'Lineitem product id']);
  const variant_id = pick(row, ['variant_id', 'Variant ID', 'Lineitem variant id']);
  const product_name = pick(row, ['product_name', 'Product Name', 'Lineitem name', 'lineitem_name']);
  const plan_name = pick(row, [
    'plan_name', 'Plan Name', 'Selling Plan', 'Selling Plan Name', 'subscription_plan',
  ]);
  const financial_status_raw = pick(row, ['financial_status', 'Financial Status']);
  const fulfillment_status_raw = pick(row, ['fulfillment_status', 'Fulfillment Status']);
  const quantity_s = pick(row, ['quantity', 'Quantity', 'Lineitem quantity']);
  const order_source = pick(row, ['order_source', 'Source', 'Source Name', 'source_name']);
  const tags = pick(row, ['tags', 'Tags']);
  const appstle_attribution =
    /appstle/i.test(tags) ||
    /appstle/i.test(order_source) ||
    pick(row, ['appstle_subscription_id', 'Appstle Subscription Id']) !== '';
  const subscription_id = pick(row, [
    'subscription_id', 'Subscription ID', 'appstle_subscription_id', 'Appstle Subscription Id',
  ]);
  const delivery_method = pick(row, ['delivery_method', 'Delivery Method', 'Shipping Method']);
  const shipping_name = pick(row, ['shipping_name', 'Shipping Name']);
  const shipping_address_1 = pick(row, ['shipping_address_1', 'Shipping Address 1', 'Shipping Street']);
  const shipping_address_2 = pick(row, ['shipping_address_2', 'Shipping Address 2']);
  const city = pick(row, ['city', 'Shipping City', 'City']);
  const province = pick(row, ['province', 'Shipping Province', 'Province']);
  const postal_code = pick(row, ['postal_code', 'Shipping Zip', 'Shipping Postal Code']);
  const phone = pick(row, ['phone', 'Shipping Phone', 'Phone']);

  const refunded_amount_s = pick(row, ['refunded_amount', 'Refunded Amount', 'refunds_total']);
  const total_s = pick(row, ['total', 'Total', 'total_price']);
  const refunded_amount = refunded_amount_s ? Number(refunded_amount_s) : 0;
  const total = total_s ? Number(total_s) : null;

  const financial_status = normalizeFinancialStatus(financial_status_raw);
  const fulfillment_status = normalizeFulfillmentStatus(fulfillment_status_raw);
  const cancelled_at = safeParseDate(pick(row, ['cancelled_at', 'Cancelled At']));

  // Fully refunded heuristic: financial_status is "refunded", OR refunded_amount >= total (when both known).
  const fully_refunded =
    financial_status === 'refunded' ||
    (Number.isFinite(refunded_amount) && Number.isFinite(total) && total > 0 && refunded_amount >= total);
  const partially_refunded =
    !fully_refunded && (financial_status === 'partially_refunded' || refunded_amount > 0);
  const is_paid = ['paid', 'partially_refunded'].includes(financial_status);

  const plan = parsePlan(plan_name);
  const product_match = matchUcs({ productId: product_id, productName: product_name });

  return {
    source: 'shopify_order',
    order_id,
    order_date,
    customer_name,
    customer_email,
    customer_id,
    product_id,
    variant_id,
    product_name,
    plan_name,
    subscription_id,
    is_prepaid: plan.isPrepaid,
    plan_length: plan.length,
    financial_status,
    financial_status_raw,
    fulfillment_status,
    fulfillment_status_raw,
    quantity: quantity_s ? Number(quantity_s) : 1,
    order_source,
    tags,
    appstle_attribution,
    delivery_method,
    shipping_name,
    shipping_address_1,
    shipping_address_2,
    city,
    province,
    postal_code,
    phone,
    refunded_amount,
    total,
    fully_refunded,
    partially_refunded,
    is_paid,
    cancelled_at,
    is_ucs: product_match.match,
    ucs_match_method: product_match.method,
  };
}

module.exports = {
  pick,
  safeParseDate,
  normalizeStatus,
  normalizeAppstleSubscription,
  normalizeShopifyOrder,
  formatDate,
};
