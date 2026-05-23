'use strict';

// Thin wrapper around the host's `external-tool` CLI.
//
// The connector layer (Shopify, etc.) is provided to this agent via the
// external-tool harness; this module does not store or read credentials.
// The expected invocation shape:
//
//   external-tool call '{"source_id":"shopify","tool_name":"graphql_query",
//                        "arguments":{"query":"...","variables":{...}}}'
//
// The CLI returns a JSON object whose useful payload is typically a JSON
// STRING under `structure` / `result` / `output` (the harness flags this:
// "structure: JSON string"). We try the common locations and parse.
//
// All real I/O is funneled through a single `run()` function which can be
// replaced by tests via `setRunner()`. This makes the live Shopify adapter
// fully testable with no real subprocess and no real PII.
//
// Privacy: the connector logs nothing on its own. Errors thrown from here
// must NOT include any returned payload body — only the source_id and tool
// name — because the payload may contain customer rows from a partially
// successful call.

const { spawn } = require('child_process');

let currentRunner = defaultSpawnRunner;

/** Test/integration seam. Pass a function `(payload) => Promise<resultObject>`. */
function setRunner(fn) {
  currentRunner = typeof fn === 'function' ? fn : defaultSpawnRunner;
}

function resetRunner() {
  currentRunner = defaultSpawnRunner;
}

/**
 * Invoke the connector. Returns the parsed inner payload — i.e. if the
 * CLI returns `{ structure: '<json-string>' }`, the caller gets the
 * already-JSON.parsed object.
 *
 * @param {Object} payload
 * @param {string} payload.source_id  e.g. "shopify"
 * @param {string} payload.tool_name  e.g. "graphql_query"
 * @param {Object} payload.arguments  tool-specific input
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=120000]
 */
async function call(payload, opts = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('connector.call: payload must be an object');
  }
  if (!payload.source_id) throw new Error('connector.call: payload.source_id is required');
  if (!payload.tool_name) throw new Error('connector.call: payload.tool_name is required');
  const result = await currentRunner(payload, opts);
  return unwrapResult(result, payload);
}

/**
 * The harness returns a wrapper object; the actual tool payload may be
 * under `structure`, `result`, `output`, or `data`. If it is a JSON string
 * (the documented shape), parse it. Otherwise pass through.
 */
function unwrapResult(raw, payload) {
  if (raw === null || raw === undefined) {
    throw new Error(`connector.call(${payload.source_id}/${payload.tool_name}): empty response`);
  }
  // String at the top level: try to parse.
  if (typeof raw === 'string') {
    return tryParseJson(raw, payload);
  }
  if (typeof raw !== 'object') {
    throw new Error(`connector.call(${payload.source_id}/${payload.tool_name}): unexpected response type ${typeof raw}`);
  }
  if (raw.error) {
    throw new Error(`connector.call(${payload.source_id}/${payload.tool_name}): ${String(raw.error).slice(0, 200)}`);
  }
  // Documented harness shape: { structure: "<json-string>" } (per "structure:
  // JSON string" in the connector docs). We treat `structure`/`result`/`output`
  // as the canonical wrapper keys. We do NOT auto-unwrap `data`, because
  // GraphQL responses already use `data` as the top-level payload key and
  // unwrapping it here would strip information the caller needs.
  for (const key of ['structure', 'result', 'output']) {
    if (key in raw) {
      const v = raw[key];
      if (typeof v === 'string') return tryParseJson(v, payload);
      if (v && typeof v === 'object') return v;
    }
  }
  // No known wrapper key; return as-is (e.g. GraphQL { data, errors } shape).
  return raw;
}

function tryParseJson(s, payload) {
  try {
    return JSON.parse(s);
  } catch (_err) {
    // Some tools return plain text (e.g. error strings). Surface a generic
    // failure that does not echo the body, which could contain customer
    // data on partial successes.
    throw new Error(`connector.call(${payload.source_id}/${payload.tool_name}): response was not JSON`);
  }
}

/**
 * Default subprocess runner. Spawns `external-tool call '<json>'` and
 * collects stdout. Stderr is consumed but never re-emitted directly
 * (to avoid leaking tokens/PII the connector might log there).
 */
function defaultSpawnRunner(payload, opts = {}) {
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 120000);
  const bin = process.env.EXTERNAL_TOOL_BIN || 'external-tool';
  const args = ['call', JSON.stringify(payload)];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`failed to launch ${bin}: ${err.code || err.message || 'unknown'}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGTERM'); } catch (_e) { /* ignore */ }
      reject(new Error(`${bin} ${payload.source_id}/${payload.tool_name} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`${bin}: ${err.code || err.message || 'spawn error'}`));
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        // stderr may include connector diagnostics. Surface only an exit
        // code; do not echo stderr or stdout (could include PII or tokens).
        // The fact that the runner ran but failed is enough info.
        // (Length-only signal helps operators tell empty-vs-something.)
        reject(new Error(`${bin} ${payload.source_id}/${payload.tool_name} exited ${code} (stderr ${stderr.length}B, stdout ${stdout.length}B)`));
        return;
      }
      try {
        const parsed = stdout.trim().length > 0 ? JSON.parse(stdout) : null;
        resolve(parsed);
      } catch (_err) {
        // Some harnesses emit the JSON string directly (not double-wrapped).
        resolve(stdout);
      }
    });
  });
}

module.exports = {
  call,
  setRunner,
  resetRunner,
  unwrapResult,
};
