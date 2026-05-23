'use strict';

// Shopify order adapter.
//
// Two backends are supported:
//   - "fixture": load orders from a CSV or JSON file path. Used in tests and
//     in the first production run, where the operator exports orders manually.
//   - "live": placeholder for a future Shopify Admin API integration. The shape
//     is defined here so the rest of the agent can be wired up; the live call
//     intentionally throws if credentials aren't supplied, so tests never make
//     network calls.
//
// Privacy / security contract for the live adapter:
//   - READ-ONLY in intent. The adapter only fetches orders/products. It must
//     never call write-scoped APIs (PUT/POST/DELETE on customers, orders,
//     refunds, etc.). When implementing the live backend, request a Shopify
//     access token scoped to `read_orders` and `read_products` only.
//   - Auth tokens are never logged, printed, embedded in error messages, or
//     written to disk. Errors must surface the *kind* of failure without
//     revealing the token. The adapter strips a few common token-shaped
//     substrings from any error it re-throws.
//   - Environment variables (e.g. SHOPIFY_ACCESS_TOKEN) must not be enumerated
//     or printed by this module.
//   - In scheduled / automation contexts the recommended pattern is to pass
//     api_credentials=['external-tools'] at the harness level and let the
//     external connector inject the token; do not hardcode credentials in
//     source or commit them to .env files.

const fs = require('fs');
const path = require('path');
const { parseObjects } = require('./csv');
const { normalizeShopifyOrder } = require('./normalize');

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
  // Default: CSV.
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

// Strip likely auth-token substrings from an error message before surfacing.
function scrubAuthFromError(err, token) {
  const msg = String(err && (err.message || err));
  let scrubbed = msg;
  if (token) {
    // Replace the exact token, then any token-shaped sequence.
    const escaped = String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    scrubbed = scrubbed.replace(new RegExp(escaped, 'g'), '[redacted-token]');
  }
  // Shopify admin tokens look like `shpat_<hex>` / `shpca_<hex>` / `shppa_<hex>`.
  scrubbed = scrubbed.replace(/shp[a-z]{2,4}_[A-Za-z0-9]{20,}/g, '[redacted-token]');
  return new Error(scrubbed);
}

function createLiveAdapter(auth = {}) {
  // Deliberately do NOT store the token on the returned adapter object.
  // Keep it captured in this closure only, and surface it through a hidden
  // helper that the (future) HTTP layer can pull. This makes it impossible
  // to JSON.stringify the adapter and accidentally leak the token.
  const token = auth && (auth.accessToken || auth.apiKey) ? String(auth.accessToken || auth.apiKey) : '';
  return {
    type: 'live',
    source: 'shopify_admin_api',
    readOnly: true,
    requiredScopes: ['read_orders', 'read_products'],
    hasAuth: Boolean(token),
    async fetchOrders(/* { since, until } */) {
      if (!token) {
        throw new Error(
          'Shopify live adapter not configured. Provide auth.accessToken (read-only) ' +
          'or use a fixture adapter. In scheduled contexts, pass ' +
          'api_credentials=[\'external-tools\'] and configure the connector externally.'
        );
      }
      try {
        // Intentionally not implemented yet. When this is filled in, the
        // request layer must use `token` only via Authorization headers and
        // must scrub any thrown errors via scrubAuthFromError(err, token).
        throw new Error('Shopify live adapter is not yet implemented; use --orders <file> with a fixture.');
      } catch (err) {
        throw scrubAuthFromError(err, token);
      }
    },
  };
}

/**
 * Factory.
 *
 * @param {Object} opts
 * @param {string} [opts.fixturePath] - Path to a CSV/JSON fixture.
 * @param {Object} [opts.auth] - Live API auth (future). Token is held in a
 *   closure and is never attached to the returned adapter object.
 * @param {'fixture'|'live'} [opts.mode]
 */
function createAdapter(opts = {}) {
  const mode = opts.mode || (opts.fixturePath ? 'fixture' : 'live');
  if (mode === 'fixture') return createFixtureAdapter(opts.fixturePath);
  return createLiveAdapter(opts.auth || {});
}

module.exports = {
  createAdapter,
  createFixtureAdapter,
  createLiveAdapter,
  loadFixtureFile,
  scrubAuthFromError,
};
