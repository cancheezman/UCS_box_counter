'use strict';

// Shopify order adapter.
//
// Two backends are supported:
//   - "fixture": load orders from a CSV or JSON file path. Used in tests and
//     for offline / manual-export runs.
//   - "live":    call the host's `external-tool` CLI against the connector
//                source_id "shopify", using the `graphql_query` tool. This
//                is the production ingestion path.
//
// Privacy / security contract for the live adapter:
//   - READ-ONLY. We only call `graphql_query` with a hand-written read-only
//     GraphQL document. We never call write APIs.
//   - NO TOKENS STORED OR HANDLED HERE. Authentication is performed by the
//     `external-tool` connector layer outside this process. This repo never
//     sees, prints, or persists Shopify access tokens.
//   - The required scopes for the connector to satisfy the query are:
//       read_orders, read_marketplace_orders, read_quick_sale,
//       read_customers, read_products.
//     They are documented on the adapter via `requiredScopes` so an operator
//     can verify least privilege. The agent emphasizes least privilege but
//     does not enforce scope checks — that is the connector's responsibility.
//   - Connector errors and timeouts are surfaced with the `source_id` /
//     `tool_name` and exit code only; response bodies (which may contain
//     customer rows on partial successes) are never re-emitted.
//   - Logs at adapter level are page/order counts only — never names,
//     emails, addresses, phone numbers, or full rows.

const fs = require('fs');
const path = require('path');
const { parseObjects } = require('./csv');
const { normalizeShopifyOrder } = require('./normalize');
const connector = require('./connector');

const SHOPIFY_SOURCE_ID = 'shopify';

// Read-only ingestion query. Validated by Shopify; required scopes listed in
// REQUIRED_SCOPES. Keep this in sync with both.
const ORDERS_QUERY = `
query UcsOrders($first: Int!, $query: String!, $after: String) {
  orders(first: $first, query: $query, after: $after, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      createdAt
      processedAt
      cancelledAt
      displayFinancialStatus
      displayFulfillmentStatus
      tags
      email
      phone
      customer {
        id
        displayName
        defaultEmailAddress { emailAddress }
        defaultPhoneNumber { phoneNumber }
      }
      shippingAddress {
        name
        address1
        address2
        city
        provinceCode
        zip
        phone
      }
      lineItems(first: 50) {
        nodes {
          id
          title
          name
          quantity
          currentQuantity
          refundableQuantity
          sku
          variantTitle
          sellingPlan { name }
          product { id title }
          variant { id title sku }
          customAttributes { key value }
        }
      }
    }
  }
}
`.trim();

const REQUIRED_SCOPES = [
  'read_orders',
  'read_marketplace_orders',
  'read_quick_sale',
  'read_customers',
  'read_products',
];

const MAX_PAGE_SIZE = 50;

function loadFixtureFile(filePath) {
  if (!filePath) return [];
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(abs, 'utf8');
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.json') {
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : (parsed.orders || []);
    return rows;
  }
  return parseObjects(raw);
}

function createFixtureAdapter(filePath) {
  return {
    type: 'fixture',
    source: filePath,
    readOnly: true,
    async fetchOrders(/* { since, until } */) {
      const rows = loadFixtureFile(filePath);
      return rows.map(normalizeShopifyOrder);
    },
  };
}

/**
 * Extract a numeric ID from a Shopify GID like
 *   "gid://shopify/Product/7890199412991" -> "7890199412991".
 * Returns '' if the input is not a string or has no trailing digits.
 */
function gidToNumericId(gid) {
  if (typeof gid !== 'string' || !gid) return '';
  const m = gid.match(/\/(\d+)(?:\?.*)?$/);
  return m ? m[1] : '';
}

/** Format a date as the YYYY-MM-DD prefix that Shopify's `created_at:` filter accepts. */
function dateOnly(d) {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

/**
 * Build the Shopify search query filter for a date window. We do NOT filter
 * by financial_status server-side, because the spec explicitly wants us to
 * include partially-refunded orders for the review flag — that filtering
 * happens in src/eligibility.js. We do filter by date range to bound result
 * size.
 */
function buildOrdersQuery({ since, until }) {
  const parts = [];
  if (since) parts.push(`created_at:>=${dateOnly(since)}`);
  if (until) parts.push(`created_at:<=${dateOnly(until)}`);
  return parts.join(' ');
}

/**
 * Normalize one GraphQL `orders.nodes[]` entry into the row shape the
 * existing `normalizeShopifyOrder` understands (it accepts both
 * "Title Case" CSV headers and lower_snake_case keys). We emit one row
 * per UCS-looking line item, because the legacy CSV ingest is 1 row per
 * line item — that matches how Shopify export CSVs look.
 *
 * If an order has multiple UCS line items we emit one row per line item;
 * if it has no line items at all we emit a single row with empty
 * product/variant fields, so the eligibility filter can still reject it
 * cleanly.
 */
function normalizeGraphqlOrder(node) {
  if (!node || typeof node !== 'object') return [];
  const orderId = gidToNumericId(node.id) || (node.name || '');
  const orderDate = node.processedAt || node.createdAt || '';
  const cancelledAt = node.cancelledAt || '';
  const financialStatus = (node.displayFinancialStatus || '').toLowerCase();
  const fulfillmentStatus = (node.displayFulfillmentStatus || '').toLowerCase();
  const tags = Array.isArray(node.tags) ? node.tags.join(',') : (node.tags || '');

  const customer = node.customer || {};
  const customerId = gidToNumericId(customer.id) || '';
  const customerName = customer.displayName || (node.shippingAddress && node.shippingAddress.name) || '';
  const customerEmail = (
    (customer.defaultEmailAddress && customer.defaultEmailAddress.emailAddress) ||
    node.email ||
    ''
  );
  const customerPhone = (
    (customer.defaultPhoneNumber && customer.defaultPhoneNumber.phoneNumber) ||
    node.phone ||
    (node.shippingAddress && node.shippingAddress.phone) ||
    ''
  );

  const ship = node.shippingAddress || {};
  const baseAddress = {
    shipping_name: ship.name || customerName || '',
    shipping_address_1: ship.address1 || '',
    shipping_address_2: ship.address2 || '',
    city: ship.city || '',
    province: ship.provinceCode || '',
    postal_code: ship.zip || '',
    phone: ship.phone || customerPhone || '',
  };
  // delivery_method is not provided directly by the connector; the warnings
  // engine flags missing delivery_method, which is the correct behavior.
  const baseRow = {
    order_id: orderId,
    order_date: dateOnly(orderDate),
    cancelled_at: dateOnly(cancelledAt),
    customer_name: customerName,
    customer_email: customerEmail,
    customer_id: customerId,
    financial_status: financialStatus,
    fulfillment_status: fulfillmentStatus,
    tags,
    order_source: 'shopify_admin_api',
    delivery_method: '',
    ...baseAddress,
  };

  const lineItems = (node.lineItems && Array.isArray(node.lineItems.nodes)) ? node.lineItems.nodes : [];
  if (lineItems.length === 0) {
    return [baseRow];
  }
  return lineItems.map((li) => {
    const productId = li.product ? gidToNumericId(li.product.id) : '';
    const variantId = li.variant ? gidToNumericId(li.variant.id) : '';
    const productName = (li.product && li.product.title) || li.title || li.name || '';
    const planName = (li.sellingPlan && li.sellingPlan.name) || '';
    // Quantity preference: currentQuantity (after refunds) -> quantity.
    const currentQuantity = (li.currentQuantity !== undefined && li.currentQuantity !== null)
      ? Number(li.currentQuantity)
      : null;
    const quantity = (li.quantity !== undefined && li.quantity !== null) ? Number(li.quantity) : null;
    const refundableQuantity = (li.refundableQuantity !== undefined && li.refundableQuantity !== null)
      ? Number(li.refundableQuantity)
      : null;
    // Refund signal heuristic: if currentQuantity < quantity, treat as a
    // partial refund. (The financialStatus also carries refunded /
    // partially_refunded, which the normalizer already handles.)
    const refunded_amount = (
      Number.isFinite(currentQuantity) &&
      Number.isFinite(quantity) &&
      currentQuantity < quantity
    ) ? 1 : 0;
    // customAttributes: serialize compactly without quoting customer text.
    const attrs = Array.isArray(li.customAttributes) ? li.customAttributes : [];
    const customAttrSummary = attrs
      .map((a) => (a && a.key ? String(a.key) : ''))
      .filter(Boolean)
      .join(',');
    return {
      ...baseRow,
      product_id: productId,
      product_name: productName,
      variant_id: variantId,
      plan_name: planName,
      quantity: Number.isFinite(currentQuantity) ? currentQuantity : (Number.isFinite(quantity) ? quantity : 1),
      // Keep an attribution note if the line carries a sellingPlan (Appstle
      // subscriptions in Shopify materialize as sellingPlan'd line items).
      // We do NOT echo customAttribute values, only their keys, since values
      // may contain customer-entered text.
      tags: [baseRow.tags, customAttrSummary].filter(Boolean).join(','),
      refunded_amount,
      total: null,
    };
  });
}

/**
 * Create the live Shopify adapter. Uses src/connector.js to talk to the
 * external-tool CLI. No tokens are read or stored here.
 *
 * @param {Object} [opts]
 * @param {number} [opts.pageSize=50] - Page size, capped at 50.
 * @param {number} [opts.maxPages=50] - Safety cap for total pages per fetch.
 * @param {(payload: object, opts?: object) => Promise<any>} [opts.connectorCall]
 *   Inject a custom connector function for tests. Defaults to connector.call.
 * @param {(msg: string) => void} [opts.log] - Optional progress logger. Receives
 *   strings like "shopify live: page 3, 42 orders so far". NEVER receives PII.
 */
function createLiveAdapter(opts = {}) {
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(opts.pageSize) || MAX_PAGE_SIZE));
  const maxPages = Math.max(1, Number(opts.maxPages) || 50);
  const callFn = typeof opts.connectorCall === 'function' ? opts.connectorCall : connector.call;
  const log = typeof opts.log === 'function' ? opts.log : null;
  return {
    type: 'live',
    source: SHOPIFY_SOURCE_ID,
    readOnly: true,
    requiredScopes: REQUIRED_SCOPES.slice(),
    /**
     * @param {Object} window
     * @param {string|Date} window.since - inclusive
     * @param {string|Date} window.until - inclusive
     */
    async fetchOrders(window = {}) {
      const queryFilter = buildOrdersQuery(window);
      const allRows = [];
      let after = null;
      let pages = 0;
      while (pages < maxPages) {
        const payload = {
          source_id: SHOPIFY_SOURCE_ID,
          tool_name: 'graphql_query',
          arguments: {
            query: ORDERS_QUERY,
            variables: { first: pageSize, query: queryFilter, after },
          },
        };
        let response;
        try {
          response = await callFn(payload);
        } catch (err) {
          throw scrubConnectorError(err);
        }
        const orders = response && response.data && response.data.orders;
        if (!orders) {
          throw new Error('shopify live: connector returned no orders payload');
        }
        const nodes = Array.isArray(orders.nodes) ? orders.nodes : [];
        for (const node of nodes) {
          for (const row of normalizeGraphqlOrder(node)) {
            allRows.push(row);
          }
        }
        pages += 1;
        if (log) log(`shopify live: page ${pages}, ${allRows.length} line items so far`);
        const info = orders.pageInfo || {};
        if (!info.hasNextPage) break;
        if (!info.endCursor) break;
        after = info.endCursor;
      }
      if (pages >= maxPages && allRows.length === 0) {
        throw new Error(`shopify live: hit max page cap (${maxPages}) with no results — check date window`);
      }
      return allRows.map(normalizeShopifyOrder);
    },
  };
}

/**
 * Strip any Shopify access-token-shaped substring or known PII shapes from
 * an error before re-raising. We never echo back response bodies.
 */
function scrubConnectorError(err) {
  const raw = String((err && (err.message || err)) || 'unknown connector error');
  let scrubbed = raw
    .replace(/shp[a-z]{2,4}_[A-Za-z0-9]{20,}/g, '[redacted-token]')
    .replace(/[\w.+-]+@[\w.-]+/g, '[email]')
    .replace(/\b\d{7,}\b/g, '[id]');
  return new Error(scrubbed);
}

/**
 * Factory.
 *
 * @param {Object} opts
 * @param {string} [opts.fixturePath] - Path to a CSV/JSON fixture.
 * @param {'fixture'|'live'} [opts.mode]
 * @param {number} [opts.pageSize]
 * @param {function} [opts.connectorCall] - Inject a fake for tests.
 * @param {function} [opts.log]
 */
function createAdapter(opts = {}) {
  const mode = opts.mode || (opts.fixturePath ? 'fixture' : 'live');
  if (mode === 'fixture') return createFixtureAdapter(opts.fixturePath);
  return createLiveAdapter(opts);
}

module.exports = {
  SHOPIFY_SOURCE_ID,
  ORDERS_QUERY,
  REQUIRED_SCOPES,
  MAX_PAGE_SIZE,
  createAdapter,
  createFixtureAdapter,
  createLiveAdapter,
  loadFixtureFile,
  gidToNumericId,
  buildOrdersQuery,
  normalizeGraphqlOrder,
  scrubConnectorError,
};
