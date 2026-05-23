#!/usr/bin/env node
'use strict';

// CLI entry point for the UCS Monthly Box Count Agent.
//
// Usage:
//   ucs-box-counter --type estimate --run-date 2026-05-09 \
//       --appstle ./appstle.csv --orders ./shopify-orders.csv \
//       --out ./out
//
//   ucs-box-counter --type final --target-month 2026-06 \
//       --appstle ./appstle.csv --orders ./shopify-orders.csv

const fs = require('fs');
const path = require('path');
const { parseObjects } = require('../src/csv');
const { normalizeAppstleSubscription } = require('../src/normalize');
const { createAdapter } = require('../src/shopify');
const { runCount } = require('../src/count');
const { buildMarkdown, buildJson, buildCsv } = require('../src/report');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { args.help = true; continue; }
    if (a === '-v' || a === '--version') { args.version = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
      continue;
    }
    args._.push(a);
  }
  return args;
}

function usage() {
  return [
    'UCS Monthly Box Count Agent',
    '',
    'Usage:',
    '  ucs-box-counter [options]',
    '',
    'Options:',
    '  --type <estimate|final>   Report type (default: estimate).',
    '  --run-date <YYYY-MM-DD>   Run date; cycle is derived from it.',
    '  --target-month <YYYY-MM>  Target box month; overrides --run-date.',
    '  --appstle <path>          Path to the Appstle subscription CSV export.',
    '  --orders <path>           Path to a Shopify/Appstle orders CSV or JSON.',
    '  --out <dir>               Output directory (default: ./out).',
    '  --quiet                   Suppress summary on stdout.',
    '  --help                    Show this help.',
    '  --version                 Print version and exit.',
    '',
    'Examples:',
    '  ucs-box-counter --type estimate --run-date 2026-05-09 \\',
    '      --appstle samples/appstle.csv --orders samples/shopify-orders.csv',
    '',
    '  ucs-box-counter --type final --target-month 2026-06 \\',
    '      --appstle samples/appstle.csv --orders samples/shopify-orders.csv',
    '',
    'Notes:',
    '  Live Shopify auth is not required. For scheduled contexts using an',
    '  external Shopify CLI tool, pass api_credentials=["external-tools"] and',
    '  point --orders at the file the external tool produces.',
  ].join('\n');
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(usage() + '\n'); return 0; }
  if (args.version) {
    const pkg = require('../package.json');
    process.stdout.write(pkg.version + '\n');
    return 0;
  }

  const reportType = args.type || 'estimate';
  if (!['estimate', 'final'].includes(reportType)) {
    process.stderr.write(`Error: --type must be 'estimate' or 'final' (got '${reportType}').\n`);
    return 2;
  }
  if (!args.appstle) {
    process.stderr.write('Error: --appstle <path> is required.\n');
    return 2;
  }
  if (!fs.existsSync(args.appstle)) {
    process.stderr.write(`Error: appstle file not found: ${args.appstle}\n`);
    return 2;
  }

  // Load Appstle CSV.
  const appstleText = fs.readFileSync(args.appstle, 'utf8');
  const appstleRows = parseObjects(appstleText);
  const subscriptions = appstleRows.map(normalizeAppstleSubscription);

  // Load orders (optional but recommended).
  let orders = [];
  if (args.orders) {
    if (!fs.existsSync(args.orders)) {
      process.stderr.write(`Error: orders file not found: ${args.orders}\n`);
      return 2;
    }
    const adapter = createAdapter({ fixturePath: args.orders });
    orders = await adapter.fetchOrders({});
  }

  const result = runCount({
    subscriptions,
    orders,
    runDate: args['run-date'] || null,
    targetMonth: args['target-month'] || null,
    reportType,
  });

  const outDir = path.resolve(process.cwd(), args.out || 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = `${result.target_box_month}_${result.report_type}`;
  const mdPath = path.join(outDir, `summary_${stamp}.md`);
  const jsonPath = path.join(outDir, `summary_${stamp}.json`);
  const csvPath = path.join(outDir, `boxes_${stamp}.csv`);
  fs.writeFileSync(mdPath, buildMarkdown(result), 'utf8');
  fs.writeFileSync(jsonPath, buildJson(result), 'utf8');
  fs.writeFileSync(csvPath, buildCsv(result), 'utf8');

  if (!args.quiet) {
    process.stdout.write(buildMarkdown(result) + '\n');
    process.stdout.write(`\nWrote: ${mdPath}\nWrote: ${jsonPath}\nWrote: ${csvPath}\n`);
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code || 0),
    (err) => {
      process.stderr.write(`ucs-box-counter: ${err.stack || err.message || err}\n`);
      process.exit(1);
    }
  );
}

module.exports = { main, parseArgs, usage };
