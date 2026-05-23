'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'ucs-box-counter.js');
const APPSTLE = path.join(__dirname, '..', 'samples', 'appstle_subscriptions.csv');
const ORDERS = path.join(__dirname, '..', 'samples', 'shopify_orders.csv');

test('CLI --help prints usage', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /UCS Monthly Box Count Agent/);
});

test('CLI runs final report against sample fixtures and writes output files', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucs-out-'));
  const r = spawnSync(process.execPath, [
    BIN, '--type', 'final',
    '--target-month', '2026-06',
    '--appstle', APPSTLE,
    '--orders', ORDERS,
    '--out', outDir,
    '--quiet',
  ], { encoding: 'utf8' });
  if (r.status !== 0) {
    process.stderr.write(`stderr: ${r.stderr}\nstdout: ${r.stdout}\n`);
  }
  assert.equal(r.status, 0);
  const files = fs.readdirSync(outDir);
  assert.ok(files.some((f) => f.startsWith('summary_2026-06_final.md')));
  assert.ok(files.some((f) => f.startsWith('summary_2026-06_final.json')));
  assert.ok(files.some((f) => f.startsWith('boxes_2026-06_final.csv')));

  // The CSV should have a BOM.
  const csv = fs.readFileSync(path.join(outDir, 'boxes_2026-06_final.csv'), 'utf8');
  assert.equal(csv.charCodeAt(0), 0xfeff);
});

test('CLI default stdout does not leak full emails, addresses, or phones', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucs-out-'));
  const r = spawnSync(process.execPath, [
    BIN, '--type', 'estimate',
    '--run-date', '2026-05-09',
    '--appstle', APPSTLE,
    '--orders', ORDERS,
    '--out', outDir,
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  // Full emails from the fixtures must not appear on stdout.
  for (const email of ['alice@example.com', 'bob@example.com', 'carol@example.com']) {
    assert.equal(r.stdout.includes(email), false, `stdout leaked email ${email}`);
  }
  // No address line should appear verbatim.
  assert.equal(r.stdout.includes('1 Main St'), false);
  // No phone number should appear verbatim.
  assert.equal(r.stdout.includes('555-0101'), false);
});

test('CLI runs estimate report against sample fixtures', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucs-out-'));
  const r = spawnSync(process.execPath, [
    BIN, '--type', 'estimate',
    '--run-date', '2026-05-09',
    '--appstle', APPSTLE,
    '--orders', ORDERS,
    '--out', outDir,
    '--quiet',
  ], { encoding: 'utf8' });
  if (r.status !== 0) {
    process.stderr.write(`stderr: ${r.stderr}\nstdout: ${r.stdout}\n`);
  }
  assert.equal(r.status, 0);
  const json = JSON.parse(fs.readFileSync(path.join(outDir, 'summary_2026-06_estimate.json'), 'utf8'));
  assert.equal(json.target_box_month, '2026-06');
  assert.equal(json.report_type, 'estimate');
  assert.match(json.language, /estimate/);
});

test('CLI --overrides loads a manual override CSV and writes a gray-zone CSV', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucs-out-'));
  const overridesPath = path.join(outDir, 'overrides.csv');
  fs.writeFileSync(
    overridesPath,
    [
      'customer_email,subscription_id,shopify_order_id,target_box_month,override_action,reason',
      'someone@example.com,FAKE_SUB_1,,2026-09,include,Pull into Sept',
    ].join('\n'),
    'utf8'
  );
  const r = spawnSync(process.execPath, [
    BIN, '--type', 'final',
    '--target-month', '2026-09',
    '--appstle', APPSTLE,
    '--orders', ORDERS,
    '--overrides', overridesPath,
    '--out', outDir,
    '--quiet',
  ], { encoding: 'utf8' });
  if (r.status !== 0) process.stderr.write(`stderr: ${r.stderr}\nstdout: ${r.stdout}\n`);
  assert.equal(r.status, 0);
  // Gray-zone CSV should exist (may be empty if no gray-zone rows exist in fixtures).
  const grayPath = path.join(outDir, 'gray_zone_2026-09_final.csv');
  assert.ok(fs.existsSync(grayPath));
  // JSON should expose the gray-zone window.
  const json = JSON.parse(fs.readFileSync(path.join(outDir, 'summary_2026-09_final.json'), 'utf8'));
  assert.equal(json.gray_zone_window_start, '2026-08-25');
  assert.equal(json.gray_zone_window_end, '2026-09-03');
});
