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
// To plug in real Shopify auth later, set env vars or pass `auth` to
// createAdapter. The recommended pattern from the spec is to keep credentials
// out of source code; in scheduled contexts, pass api_credentials=['external-tools'].

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
    async fetchOrders(/* { since, until } */) {
      const rows = loadFixtureFile(filePath);
      return rows.map(normalizeShopifyOrder);
    },
  };
}

function createLiveAdapter(auth = {}) {
  return {
    type: 'live',
    source: 'shopify_admin_api',
    async fetchOrders(/* { since, until } */) {
      if (!auth || (!auth.accessToken && !auth.apiKey)) {
        throw new Error(
          'Shopify live adapter not configured. Provide auth.accessToken or use a fixture adapter. ' +
            'In scheduled contexts, pass api_credentials=[\'external-tools\'] and configure the connector externally.'
        );
      }
      throw new Error('Shopify live adapter is not yet implemented; use --orders <file> with a fixture.');
    },
  };
}

/**
 * Factory.
 *
 * @param {Object} opts
 * @param {string} [opts.fixturePath] - Path to a CSV/JSON fixture.
 * @param {Object} [opts.auth] - Live API auth (future).
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
};
